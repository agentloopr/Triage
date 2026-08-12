/**
 * ClickUp adapter — a typed HTTP client over the v2 API.
 *
 * This replaces a 2,034-line bash script in the system this was extracted from. Most of that script
 * was `jq` output shaping and is not reproduced. Three pieces were real logic and are carried across
 * deliberately, because each one exists to stop a specific silent failure:
 *
 *  1. **Status vocabulary resolution.** ClickUp rejects a status whose casing does not match the
 *     list's own vocabulary, and every list can define its own. The adapter reads the vocabulary,
 *     matches case-insensitively, and sends back ClickUp's exact spelling.
 *  2. **The protected-status guard** → `refused`. A card a human already moved to `in review` or
 *     `blocked` must never be silently dragged back by an automated write. This is pipeline policy
 *     rather than a ClickUp quirk, which is why the outcome is part of the interface.
 *  3. **Assignee replace semantics.** The wire format is `{assignees:{add,rem}}`, but the operation
 *     is `setAssignees` — *replace*. The adapter reads the current assignees and computes the
 *     difference. An adapter that only sends `add` appends instead of replacing, and quietly leaves
 *     the previous owner on every card it touches.
 *
 * Three things the original did NOT have, added here:
 *
 *  • **Rate limiting.** There is no 429 handling and no backoff anywhere in the production code; the
 *    100 req/min cap is entirely unguarded. This honours `Retry-After` inside a total wall-clock
 *    budget, reusing the providers' retry helper rather than writing a second one — both had to get
 *    the same thing right, and one of them already did.
 *  • **`moveList` → `unsupported`.** ClickUp v2 has no move-list endpoint. This is precisely the case
 *    the `unsupported` outcome exists for: the pipeline must be able to tell "this tracker cannot do
 *    that" from "that failed".
 *  • **Name clamping.** ClickUp rejects a name over 256 characters, and the original dropped the
 *    action when it did. The title is clamped and preserved in full in the description.
 *
 * Not ported, on purpose: custom-field defaults, the per-list "Requested by" People field, and the
 * mandatory-due-date contract. Those are one workspace's configuration, not architecture.
 */
import { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, TRACKER_TIMEOUT_MS } from '../config';
import { ModelError, withRetryBudget } from '../providers';
import { externalId, getMembers, getRoutes } from '../registry/opsRegistry';
import {
  type BoardTask,
  type Comment,
  type OpOutcome,
  type Priority,
  type TrackerAdapter,
  type TrackerCapabilities,
} from './index';
import { renderBoardSnapshot } from './renderSnapshot';

const BASE_URL = 'https://api.clickup.com/api/v2';
const MAX_NAME_CHARS = 256;
const MAX_PAGES = 20;
const COMMENT_PAGE_SIZE = 25;

/** ClickUp's priority ids. `null` clears it. */
const PRIORITY_TO_ID: Record<Priority, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
const ID_TO_PRIORITY: Record<number, Priority> = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };

/**
 * Statuses an automated write may never move a card out of. Carried verbatim from production, where
 * each entry was added after a specific incident of a human's decision being undone by a robot.
 */
const DEFAULT_PROTECTED_STATUSES = [
  'blocked',
  'in review',
  'in-review',
  'under review',
  'in qa',
  'qa review',
  'pending review',
  'on hold',
];

const CAPABILITIES: TrackerCapabilities = {
  // ClickUp v2 exposes no endpoint for this. Saying so is more useful than a failed write.
  moveList: false,
  linkTasks: true,
  subtasks: true,
  priority: true,
  dueDate: true,
  protectedStatusGuard: true,
};

export interface ClickUpTrackerOptions {
  apiToken?: string;
  teamId?: string;
  /** Injected so the contract suite can replay recorded responses with no network and no token. */
  fetchImpl?: typeof fetch;
  protectedStatuses?: string[];
  timeoutMs?: number;
}

interface ClickUpTaskJson {
  id: string;
  name: string;
  description?: string | null;
  text_content?: string | null;
  status?: { status?: string };
  assignees?: Array<{ id?: number | string; username?: string; email?: string }>;
  priority?: { id?: string | number } | null;
  due_date?: string | null;
  parent?: string | null;
  list?: { id?: string };
}

export function clickupTracker(opts: ClickUpTrackerOptions = {}): TrackerAdapter {
  const token = opts.apiToken ?? CLICKUP_API_TOKEN;
  const teamId = opts.teamId ?? CLICKUP_TEAM_ID;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TRACKER_TIMEOUT_MS;
  const protectedStatuses = new Set(
    (opts.protectedStatuses ?? DEFAULT_PROTECTED_STATUSES).map((s) => s.toLowerCase())
  );

  // Per-run cache. A status write would otherwise re-fetch the same list vocabulary for every item.
  const statusVocab = new Map<string, string[]>();

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!token) throw new Error('CLICKUP_API_TOKEN is not set');

    return withRetryBudget(`clickup:${init.method ?? 'GET'} ${path}`, timeoutMs, async (signal) => {
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}${path}`, {
          ...init,
          // The header is the raw token. ClickUp does NOT use a `Bearer` prefix, and sending one
          // fails as 401 — which reads exactly like a bad token.
          headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
          signal,
        });
      } catch (err) {
        throw new ModelError(`network: ${(err as Error)?.message ?? String(err)}`);
      }

      if (res.status === 429) {
        // The one failure the original had no handling for at all.
        const after = Number(res.headers.get('retry-after'));
        throw new ModelError('rate limited', Number.isFinite(after) && after > 0 ? after * 1_000 : 5_000);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        // 5xx is worth another attempt; a 4xx means the request itself is wrong and resending it
        // just burns the budget to arrive at the same answer.
        throw new ModelError(`HTTP ${res.status}: ${detail}`, res.status >= 500 ? 2_000 : null);
      }
      return (await res.json()) as T;
    });
  }

  /** ClickUp knows numeric user ids; the pipeline only ever knows canonical names. */
  function nameToClickUpId(name: string): string {
    const member = getMembers().find((m) => m.name === name);
    if (!member) throw new Error(`"${name}" is not in the ops registry roster`);
    return externalId(member, 'clickup');
  }

  function clickUpIdToName(id: string | number | undefined): string | null {
    if (id == null) return null;
    return getMembers().find((m) => m.externalIds.clickup === String(id))?.name ?? null;
  }

  function listKeyToId(listKey: string): string {
    const route = getRoutes().find((r) => r.key === listKey);
    if (!route) throw new Error(`no route named "${listKey}" in the ops registry`);
    return externalId(route, 'clickupList');
  }

  function listIdToKey(listId: string | undefined): string {
    if (!listId) return '(unknown)';
    return getRoutes().find((r) => r.externalIds.clickupList === listId)?.key ?? `list:${listId}`;
  }

  function toBoardTask(t: ClickUpTaskJson): BoardTask {
    const priorityId = Number(t.priority?.id);
    return {
      id: t.id,
      title: t.name,
      ...(t.description || t.text_content ? { description: t.description || t.text_content || '' } : {}),
      listKey: listIdToKey(t.list?.id),
      // An assignee ClickUp knows but the registry does not is dropped rather than guessed at — the
      // pipeline's routing gate would only hold on a name it cannot resolve anyway.
      assignees: (t.assignees ?? []).map((a) => clickUpIdToName(a.id)).filter((n): n is string => !!n),
      status: t.status?.status ?? 'unknown',
      ...(ID_TO_PRIORITY[priorityId] ? { priority: ID_TO_PRIORITY[priorityId]! } : {}),
      ...(t.due_date ? { dueDate: new Date(Number(t.due_date)).toISOString().slice(0, 10) } : {}),
      ...(t.parent ? { parentId: t.parent } : {}),
    };
  }

  /**
   * Resolve a requested status against the list's real vocabulary.
   *
   * Returns ClickUp's exact spelling, or null when the status does not exist on that list — which is
   * a failure worth naming loudly, because the alternative is a write that appears to succeed while
   * the card sits in whatever state it was already in.
   */
  async function resolveStatus(listId: string, requested: string): Promise<string | null> {
    let vocab = statusVocab.get(listId);
    if (!vocab) {
      const list = await call<{ statuses?: Array<{ status?: string; type?: string }> }>(`/list/${listId}`);
      vocab = (list.statuses ?? []).map((s) => s.status ?? '').filter(Boolean);
      statusVocab.set(listId, vocab);
    }
    if (vocab.length === 0) return requested; // list defines none — pass through rather than block

    const exact = vocab.find((s) => s.toLowerCase() === requested.toLowerCase());
    if (exact) return exact;

    // The fallback chain production used, in order. "not started" is what the model emits; every
    // board spells it differently.
    if (requested.toLowerCase() === 'not started') {
      for (const candidate of ['to do', 'todo', 'open']) {
        const hit = vocab.find((s) => s.toLowerCase() === candidate);
        if (hit) return hit;
      }
    }
    return null;
  }

  async function currentTask(taskId: string): Promise<ClickUpTaskJson> {
    return call<ClickUpTaskJson>(`/task/${taskId}`);
  }

  /** Shared by every mutating op: fetch, refuse if protected, then act. */
  async function guarded(taskId: string, fn: (t: ClickUpTaskJson) => Promise<OpOutcome>): Promise<OpOutcome> {
    let task: ClickUpTaskJson;
    try {
      task = await currentTask(taskId);
    } catch (err) {
      return { status: 'failed', detail: `could not read task ${taskId}: ${message(err)}` };
    }
    const status = task.status?.status ?? '';
    if (protectedStatuses.has(status.toLowerCase())) {
      return { status: 'refused', detail: `task ${taskId} is in protected status "${status}" — a human moved it there` };
    }
    return fn(task);
  }

  return {
    name: 'clickup',
    capabilities: CAPABILITIES,

    async getTask(id) {
      try {
        return toBoardTask(await currentTask(id));
      } catch {
        return null;
      }
    },

    /**
     * Comments paginate by cursor, not page number: pass the oldest seen `date`/`id` back as
     * `start`/`start_id`. A batch smaller than the page size is the end.
     */
    async getComments(id, limit) {
      const out: Comment[] = [];
      let start: string | undefined;
      let startId: string | undefined;

      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams();
        if (start) q.set('start', start);
        if (startId) q.set('start_id', startId);
        const suffix = q.toString() ? `?${q}` : '';

        const body = await call<{ comments?: Array<{ id: string; comment_text?: string; user?: { username?: string }; date?: string }> }>(
          `/task/${id}/comment${suffix}`
        );
        const batch = body.comments ?? [];
        for (const c of batch) {
          out.push({
            id: c.id,
            author: c.user?.username ?? 'unknown',
            body: c.comment_text ?? '',
            createdAt: c.date ? new Date(Number(c.date)).toISOString() : new Date(0).toISOString(),
          });
          if (limit != null && out.length >= limit) return out;
        }
        if (batch.length < COMMENT_PAGE_SIZE) break;
        const last = batch[batch.length - 1]!;
        start = last.date;
        startId = last.id;
      }
      return out;
    },

    async listTasks(listOpts) {
      const includeClosed = listOpts?.includeClosed ? 'true' : 'false';
      const out: BoardTask[] = [];

      // Per-list when the caller named lists, team-wide otherwise. Both paginate on `last_page`.
      const paths = listOpts?.listKeys?.length
        ? listOpts.listKeys.map((k) => `/list/${listKeyToId(k)}/task`)
        : [`/team/${teamId}/task`];

      for (const path of paths) {
        for (let page = 0; page < MAX_PAGES; page++) {
          const body = await call<{ tasks?: ClickUpTaskJson[]; last_page?: boolean }>(
            `${path}?include_closed=${includeClosed}&subtasks=true&page=${page}`
          );
          for (const t of body.tasks ?? []) out.push(toBoardTask(t));
          if (body.last_page !== false) break;
        }
      }
      return out;
    },

    renderSnapshot: (list) => renderBoardSnapshot(list),

    async apply(op): Promise<OpOutcome> {
      try {
        switch (op.kind) {
          case 'createTask': {
            const listId = listKeyToId(op.listKey);
            let status: string | undefined;
            if (op.status) {
              const resolved = await resolveStatus(listId, op.status);
              if (!resolved) {
                return { status: 'failed', detail: `status "${op.status}" does not exist on list "${op.listKey}" (${(statusVocab.get(listId) ?? []).join(', ')})` };
              }
              status = resolved;
            }

            // Over-length names are rejected outright by the API, and the original dropped the whole
            // action when that happened. Clamp, and keep the full title where it is still readable.
            const clamped = op.title.length > MAX_NAME_CHARS;
            const name = clamped ? `${op.title.slice(0, MAX_NAME_CHARS - 1)}…` : op.title;
            const description = clamped
              ? `${op.description ?? ''}\n\nFull title: ${op.title}`.trim()
              : op.description;

            const created = await call<{ id: string }>(`/list/${listId}/task`, {
              method: 'POST',
              body: JSON.stringify({
                name,
                ...(description ? { description } : {}),
                assignees: op.assignees.map((n) => Number(nameToClickUpId(n))),
                ...(op.priority ? { priority: PRIORITY_TO_ID[op.priority] } : {}),
                ...(op.dueDate ? { due_date: Date.parse(`${op.dueDate}T12:00:00Z`), due_date_time: false } : {}),
                ...(status ? { status } : {}),
                ...(op.parentId ? { parent: op.parentId } : {}),
              }),
            });
            return { status: 'applied', resultId: created.id };
          }

          case 'addComment':
            await call(`/task/${op.taskId}/comment`, {
              method: 'POST',
              body: JSON.stringify({ comment_text: op.body, notify_all: false }),
            });
            return { status: 'applied' };

          case 'setStatus':
            return guarded(op.taskId, async (task) => {
              const listId = task.list?.id;
              if (!listId) return { status: 'failed', detail: `task ${op.taskId} has no list` };

              const resolved = await resolveStatus(listId, op.status);
              if (!resolved) {
                return { status: 'failed', detail: `status "${op.status}" does not exist on that list (${(statusVocab.get(listId) ?? []).join(', ')})` };
              }
              if ((task.status?.status ?? '').toLowerCase() === resolved.toLowerCase()) {
                return { status: 'unchanged', detail: `already "${resolved}"` };
              }
              await call(`/task/${op.taskId}`, { method: 'PUT', body: JSON.stringify({ status: resolved }) });
              return { status: 'applied' };
            });

          case 'setDueDate':
            return guarded(op.taskId, async (task) => {
              const wanted = Date.parse(`${op.dueDate}T12:00:00Z`);
              if (task.due_date && Number(task.due_date) === wanted) {
                return { status: 'unchanged', detail: `already ${op.dueDate}` };
              }
              await call(`/task/${op.taskId}`, {
                method: 'PUT',
                body: JSON.stringify({ due_date: wanted, due_date_time: false }),
              });
              return { status: 'applied' };
            });

          case 'setPriority':
            return guarded(op.taskId, async (task) => {
              if (ID_TO_PRIORITY[Number(task.priority?.id)] === op.priority) {
                return { status: 'unchanged', detail: `already ${op.priority}` };
              }
              await call(`/task/${op.taskId}`, {
                method: 'PUT',
                body: JSON.stringify({ priority: PRIORITY_TO_ID[op.priority] }),
              });
              return { status: 'applied' };
            });

          /**
           * Replace, computed against what is actually on the card.
           *
           * The wire format only speaks in add/rem, so an adapter that sends the desired set as `add`
           * silently appends — leaving the previous owner assigned to every card the pipeline
           * touches, and no error anywhere to say so.
           */
          case 'setAssignees':
            return guarded(op.taskId, async (task) => {
              const current = (task.assignees ?? []).map((a) => String(a.id));
              const wanted = op.assignees.map((n) => nameToClickUpId(n));

              const add = wanted.filter((id) => !current.includes(id));
              const rem = current.filter((id) => !wanted.includes(id));
              if (add.length === 0 && rem.length === 0) {
                return { status: 'unchanged', detail: `already ${op.assignees.join(', ') || '(none)'}` };
              }

              await call(`/task/${op.taskId}`, {
                method: 'PUT',
                body: JSON.stringify({ assignees: { add: add.map(Number), rem: rem.map(Number) } }),
              });
              return { status: 'applied' };
            });

          case 'linkTasks': {
            if (op.taskIdA === op.taskIdB) return { status: 'failed', detail: 'cannot link a task to itself' };
            await call(`/task/${op.taskIdA}/link/${op.taskIdB}`, { method: 'POST' });
            return { status: 'applied' };
          }

          case 'moveList':
            return {
              status: 'unsupported',
              detail: 'ClickUp v2 has no move-list endpoint; move the card by hand or recreate it',
            };
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
