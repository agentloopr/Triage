/**
 * Linear adapter — GraphQL, written against the same interface as ClickUp.
 *
 * There is no prior art for this in the system this repo was extracted from; it exists to prove the
 * seam is real. A second adapter written from scratch is the only honest test of whether the
 * abstraction was tracker-neutral or just ClickUp with the names filed off.
 *
 * It was not entirely neutral, and the differences are the interesting part:
 *
 *  • **Linear issues take ONE assignee.** `setAssignees` with more than one name returns
 *    `unsupported` rather than silently keeping the first. Dropping an owner quietly is how a task
 *    ends up looking assigned while the person who was supposed to do it never hears about it.
 *  • **`moveList` works here** and does not on ClickUp. Two adapters with genuinely different
 *    capability matrices is the point — a `TrackerCapabilities` where every flag is `true`
 *    everywhere would prove nothing.
 *  • **Status is a `WorkflowState` per team**, not a string, so a name has to be resolved to a state
 *    id against that team's own vocabulary — the same problem ClickUp has, in a different shape.
 *
 * `listKey` maps to a Linear **team key**. The protected-status guard is implemented here too,
 * because it is pipeline policy rather than a property of either tracker.
 */
import { LINEAR_API_KEY, TRACKER_TIMEOUT_MS } from '../config';
import { ModelError, withRetryBudget } from '../providers';
import { externalId, getMembers, getRoutes } from '../registry/opsRegistry';
import {
  type BoardTask,
  type OpOutcome,
  type Priority,
  type TrackerAdapter,
  type TrackerCapabilities,
} from './index';
import { renderBoardSnapshot } from './renderSnapshot';

const API_URL = 'https://api.linear.app/graphql';

/** Linear: 0 = none, 1 = urgent … 4 = low. */
const PRIORITY_TO_ID: Record<Priority, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
const ID_TO_PRIORITY: Record<number, Priority> = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };

const DEFAULT_PROTECTED_STATUSES = ['in review', 'blocked', 'on hold', 'qa', 'pending review'];

const CAPABILITIES: TrackerCapabilities = {
  moveList: true, // an issue can change team, unlike a ClickUp card changing list
  linkTasks: true,
  subtasks: true,
  priority: true,
  dueDate: true,
  protectedStatusGuard: true,
};

export interface LinearTrackerOptions {
  apiKey?: string;
  /** Injected so the contract suite can replay recorded responses with no network and no key. */
  fetchImpl?: typeof fetch;
  protectedStatuses?: string[];
  timeoutMs?: number;
}

interface LinearIssueJson {
  id: string;
  identifier?: string;
  title: string;
  description?: string | null;
  state?: { name?: string };
  assignee?: { id?: string } | null;
  priority?: number | null;
  dueDate?: string | null;
  parent?: { id?: string } | null;
  team?: { key?: string };
}

export function linearTracker(opts: LinearTrackerOptions = {}): TrackerAdapter {
  const apiKey = opts.apiKey ?? LINEAR_API_KEY;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TRACKER_TIMEOUT_MS;
  const protectedStatuses = new Set(
    (opts.protectedStatuses ?? DEFAULT_PROTECTED_STATUSES).map((s) => s.toLowerCase())
  );

  const stateCache = new Map<string, Array<{ id: string; name: string }>>();
  const teamIdCache = new Map<string, string>();

  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!apiKey) throw new Error('LINEAR_API_KEY is not set');

    return withRetryBudget('linear', timeoutMs, async (signal) => {
      let res: Response;
      try {
        res = await doFetch(API_URL, {
          method: 'POST',
          // A personal API key goes in raw, with no `Bearer` prefix. OAuth tokens differ; this
          // adapter takes the key form because that is what a reader can get in thirty seconds.
          headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal,
        });
      } catch (err) {
        throw new ModelError(`network: ${(err as Error)?.message ?? String(err)}`);
      }

      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        throw new ModelError('rate limited', Number.isFinite(after) && after > 0 ? after * 1_000 : 5_000);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new ModelError(`HTTP ${res.status}: ${detail}`, res.status >= 500 ? 2_000 : null);
      }

      const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
      // GraphQL reports failure inside a 200. Treating HTTP status as the outcome is the classic way
      // to make a broken write look like a successful one.
      if (body.errors?.length) {
        throw new ModelError(`graphql: ${body.errors.map((e) => e.message).join('; ')}`, null);
      }
      if (!body.data) throw new ModelError('graphql: empty data', null);
      return body.data;
    });
  }

  function nameToLinearId(name: string): string {
    const member = getMembers().find((m) => m.name === name);
    if (!member) throw new Error(`"${name}" is not in the ops registry roster`);
    return externalId(member, 'linear');
  }

  function linearIdToName(id: string | undefined | null): string | null {
    if (!id) return null;
    return getMembers().find((m) => m.externalIds.linear === id)?.name ?? null;
  }

  function listKeyToTeamKey(listKey: string): string {
    const route = getRoutes().find((r) => r.key === listKey);
    if (!route) throw new Error(`no route named "${listKey}" in the ops registry`);
    return externalId(route, 'linearTeam');
  }

  function teamKeyToListKey(teamKey: string | undefined): string {
    if (!teamKey) return '(unknown)';
    return getRoutes().find((r) => r.externalIds.linearTeam === teamKey)?.key ?? `team:${teamKey}`;
  }

  async function teamId(teamKey: string): Promise<string> {
    const cached = teamIdCache.get(teamKey);
    if (cached) return cached;

    const data = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
      'query($key:String!){ teams(filter:{key:{eq:$key}}){ nodes{ id key } } }',
      { key: teamKey }
    );
    const id = data.teams.nodes[0]?.id;
    if (!id) throw new Error(`no Linear team with key "${teamKey}"`);
    teamIdCache.set(teamKey, id);
    return id;
  }

  /** A status name only means something relative to one team's workflow. */
  async function stateId(teamKey: string, statusName: string): Promise<string | null> {
    let states = stateCache.get(teamKey);
    if (!states) {
      const data = await gql<{ workflowStates: { nodes: Array<{ id: string; name: string }> } }>(
        'query($key:String!){ workflowStates(filter:{team:{key:{eq:$key}}}){ nodes{ id name } } }',
        { key: teamKey }
      );
      states = data.workflowStates.nodes;
      stateCache.set(teamKey, states);
    }
    return states.find((s) => s.name.toLowerCase() === statusName.toLowerCase())?.id ?? null;
  }

  function toBoardTask(i: LinearIssueJson): BoardTask {
    const name = linearIdToName(i.assignee?.id);
    return {
      id: i.id,
      title: i.title,
      ...(i.description ? { description: i.description } : {}),
      listKey: teamKeyToListKey(i.team?.key),
      assignees: name ? [name] : [],
      status: i.state?.name ?? 'unknown',
      ...(i.priority && ID_TO_PRIORITY[i.priority] ? { priority: ID_TO_PRIORITY[i.priority]! } : {}),
      ...(i.dueDate ? { dueDate: i.dueDate } : {}),
      ...(i.parent?.id ? { parentId: i.parent.id } : {}),
    };
  }

  const ISSUE_FIELDS = 'id identifier title description state{name} assignee{id} priority dueDate parent{id} team{key}';

  async function fetchIssue(id: string): Promise<LinearIssueJson | null> {
    const data = await gql<{ issue: LinearIssueJson | null }>(
      `query($id:String!){ issue(id:$id){ ${ISSUE_FIELDS} } }`,
      { id }
    );
    return data.issue;
  }

  async function guarded(taskId: string, fn: (i: LinearIssueJson) => Promise<OpOutcome>): Promise<OpOutcome> {
    let issue: LinearIssueJson | null;
    try {
      issue = await fetchIssue(taskId);
    } catch (err) {
      return { status: 'failed', detail: `could not read issue ${taskId}: ${message(err)}` };
    }
    if (!issue) return { status: 'failed', detail: `no such issue: ${taskId}` };

    const status = issue.state?.name ?? '';
    if (protectedStatuses.has(status.toLowerCase())) {
      return { status: 'refused', detail: `issue ${taskId} is in protected status "${status}" — a human moved it there` };
    }
    return fn(issue);
  }

  async function updateIssue(id: string, input: Record<string, unknown>): Promise<void> {
    await gql('mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success } }', {
      id,
      input,
    });
  }

  return {
    name: 'linear',
    capabilities: CAPABILITIES,

    async getTask(id) {
      try {
        const issue = await fetchIssue(id);
        return issue ? toBoardTask(issue) : null;
      } catch {
        return null;
      }
    },

    async getComments(id, limit) {
      const data = await gql<{ issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string; user?: { name?: string } }> } } | null }>(
        `query($id:String!,$first:Int!){ issue(id:$id){ comments(first:$first){ nodes{ id body createdAt user{ name } } } } }`,
        { id, first: limit ?? 50 }
      );
      return (data.issue?.comments.nodes ?? []).map((c) => ({
        id: c.id,
        author: c.user?.name ?? 'unknown',
        body: c.body,
        createdAt: c.createdAt,
      }));
    },

    async listTasks(listOpts) {
      const teamKeys = (listOpts?.listKeys ?? []).map(listKeyToTeamKey);
      const filter: Record<string, unknown> = {};
      if (teamKeys.length) filter.team = { key: { in: teamKeys } };
      // Linear models "closed" as a state TYPE, so this filters on the type rather than a name list.
      if (!listOpts?.includeClosed) filter.state = { type: { nin: ['completed', 'canceled'] } };

      const data = await gql<{ issues: { nodes: LinearIssueJson[] } }>(
        `query($filter:IssueFilter){ issues(filter:$filter,first:250){ nodes{ ${ISSUE_FIELDS} } } }`,
        { filter }
      );
      return data.issues.nodes.map(toBoardTask);
    },

    renderSnapshot: (list) => renderBoardSnapshot(list),

    async apply(op): Promise<OpOutcome> {
      try {
        switch (op.kind) {
          case 'createTask': {
            if (op.assignees.length > 1) {
              return {
                status: 'unsupported',
                detail: `Linear issues take a single assignee; ${op.assignees.length} were requested (${op.assignees.join(', ')})`,
              };
            }
            const teamKey = listKeyToTeamKey(op.listKey);
            const team = await teamId(teamKey);

            let state: string | undefined;
            if (op.status) {
              const resolved = await stateId(teamKey, op.status);
              if (!resolved) {
                return { status: 'failed', detail: `status "${op.status}" is not a workflow state on team "${teamKey}"` };
              }
              state = resolved;
            }

            const data = await gql<{ issueCreate: { success: boolean; issue?: { id: string } } }>(
              'mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id } } }',
              {
                input: {
                  teamId: team,
                  title: op.title,
                  ...(op.description ? { description: op.description } : {}),
                  ...(op.assignees[0] ? { assigneeId: nameToLinearId(op.assignees[0]) } : {}),
                  ...(op.priority ? { priority: PRIORITY_TO_ID[op.priority] } : {}),
                  ...(op.dueDate ? { dueDate: op.dueDate } : {}),
                  ...(state ? { stateId: state } : {}),
                  ...(op.parentId ? { parentId: op.parentId } : {}),
                },
              }
            );
            const id = data.issueCreate.issue?.id;
            return id ? { status: 'applied', resultId: id } : { status: 'failed', detail: 'issueCreate returned no issue' };
          }

          case 'addComment':
            await gql('mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }', {
              input: { issueId: op.taskId, body: op.body },
            });
            return { status: 'applied' };

          case 'setStatus':
            return guarded(op.taskId, async (issue) => {
              const teamKey = issue.team?.key;
              if (!teamKey) return { status: 'failed', detail: `issue ${op.taskId} has no team` };
              if ((issue.state?.name ?? '').toLowerCase() === op.status.toLowerCase()) {
                return { status: 'unchanged', detail: `already "${op.status}"` };
              }
              const resolved = await stateId(teamKey, op.status);
              if (!resolved) {
                return { status: 'failed', detail: `status "${op.status}" is not a workflow state on team "${teamKey}"` };
              }
              await updateIssue(op.taskId, { stateId: resolved });
              return { status: 'applied' };
            });

          case 'setDueDate':
            return guarded(op.taskId, async (issue) => {
              if (issue.dueDate === op.dueDate) return { status: 'unchanged', detail: `already ${op.dueDate}` };
              await updateIssue(op.taskId, { dueDate: op.dueDate });
              return { status: 'applied' };
            });

          case 'setPriority':
            return guarded(op.taskId, async (issue) => {
              if (issue.priority && ID_TO_PRIORITY[issue.priority] === op.priority) {
                return { status: 'unchanged', detail: `already ${op.priority}` };
              }
              await updateIssue(op.taskId, { priority: PRIORITY_TO_ID[op.priority] });
              return { status: 'applied' };
            });

          case 'setAssignees':
            return guarded(op.taskId, async (issue) => {
              if (op.assignees.length > 1) {
                return {
                  status: 'unsupported',
                  detail: `Linear issues take a single assignee; ${op.assignees.length} were requested (${op.assignees.join(', ')})`,
                };
              }
              const wanted = op.assignees[0] ? nameToLinearId(op.assignees[0]) : null;
              if ((issue.assignee?.id ?? null) === wanted) {
                return { status: 'unchanged', detail: `already ${op.assignees[0] ?? '(none)'}` };
              }
              await updateIssue(op.taskId, { assigneeId: wanted });
              return { status: 'applied' };
            });

          case 'linkTasks': {
            if (op.taskIdA === op.taskIdB) return { status: 'failed', detail: 'cannot link an issue to itself' };
            await gql('mutation($input:IssueRelationCreateInput!){ issueRelationCreate(input:$input){ success } }', {
              input: { issueId: op.taskIdA, relatedIssueId: op.taskIdB, type: 'related' },
            });
            return { status: 'applied' };
          }

          case 'moveList':
            return guarded(op.taskId, async (issue) => {
              const teamKey = listKeyToTeamKey(op.listKey);
              if (issue.team?.key === teamKey) return { status: 'unchanged', detail: `already in ${op.listKey}` };
              await updateIssue(op.taskId, { teamId: await teamId(teamKey) });
              return { status: 'applied' };
            });
        }
      } catch (err) {
        return { status: 'failed', detail: message(err) };
      }
    },
  };
}

function message(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).slice(0, 300);
}
