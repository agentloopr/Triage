import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OpsRegistry, setOpsRegistryPath } from '../registry/opsRegistry';
import { clickupTracker } from './clickup';
import { type BoardTask, type TrackerAdapter } from './index';
import { linearTracker } from './linear';
import { memoryTracker } from './memory';

/**
 * One suite, three adapters. This is the PRD §9 adapter gate, and it is the only thing that makes
 * `TrackerAdapter` an abstraction rather than a description of ClickUp with the nouns renamed.
 *
 * **What the two HTTP adapters run against, stated plainly:** hand-written fakes that speak each
 * vendor's documented wire format, not traffic recorded from a live account. That distinction
 * matters and is not glossed over anywhere in this repo. These fakes prove the adapter's own logic —
 * replace-vs-append, the protected-status refusal, status-vocabulary resolution, pagination,
 * capability mapping, error handling. They cannot prove an endpoint path, a field name or an auth
 * header is right, because the fake was written from the same reading of the docs as the adapter.
 * Only a live call settles those, and neither account exists yet.
 *
 * The memory adapter is the reference implementation: wherever a real tracker answers `unsupported`,
 * running the same case here shows what the operation was supposed to do.
 */
const DIR = join(tmpdir(), `adapter-contract-${process.pid}`);

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: { clickup: '111', linear: 'lin-avery' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] },
    { name: 'Rowan Diaz', externalIds: { clickup: '222', linear: 'lin-rowan' }, email: 'r@x.com', role: 'designer', defaultProjects: [] },
  ],
  routes: [
    {
      key: 'backend',
      externalIds: { clickupList: '900', linearTeam: 'BE' },
      pattern: 'backend|api',
      defaultAssignee: 'Avery Chen',
      validAssignees: ['Avery Chen', 'Rowan Diaz'],
      status: 'active',
    },
    {
      key: 'design',
      externalIds: { clickupList: '901', linearTeam: 'DES' },
      pattern: 'design|ui',
      defaultAssignee: 'Rowan Diaz',
      validAssignees: ['Rowan Diaz'],
      status: 'active',
    },
  ],
  log: [],
};

/** The status vocabulary both fakes serve, including one protected status. */
const STATUSES = ['to do', 'in progress', 'in review', 'complete'];
const PROTECTED = ['in review'];

// ── The ClickUp wire fake ────────────────────────────────────────────────────

function clickupFake() {
  const tasks = new Map<string, Record<string, unknown>>();
  const comments = new Map<string, Array<Record<string, unknown>>>();
  const links: string[] = [];
  let nextId = 1;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('https://api.clickup.com/api/v2', '').split('?')[0]!;
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, never>) : {};

    // ClickUp sends the raw token with no Bearer prefix. Asserting it here means an adapter that
    // "helpfully" adds one fails the suite rather than a live 401 months later.
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (!auth || auth.startsWith('Bearer ')) return json({ err: 'unauthorized' }, 401);

    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/list\/(\d+)$/)) && method === 'GET') {
      return json({ statuses: STATUSES.map((s) => ({ status: s, type: s === 'complete' ? 'closed' : 'open' })) });
    }

    if ((m = path.match(/^\/list\/(\d+)\/task$/)) && method === 'POST') {
      const id = `cu-${nextId++}`;
      tasks.set(id, {
        id,
        name: body.name,
        description: body.description ?? null,
        status: { status: body.status ?? 'to do' },
        assignees: ((body.assignees as unknown as number[]) ?? []).map((n) => ({ id: n })),
        priority: body.priority ? { id: body.priority } : null,
        due_date: body.due_date ?? null,
        parent: body.parent ?? null,
        list: { id: m[1] },
      });
      return json({ id });
    }

    if ((m = path.match(/^\/list\/(\d+)\/task$/)) && method === 'GET') {
      const inList = [...tasks.values()].filter((t) => (t.list as { id: string }).id === m![1]);
      return json({ tasks: inList, last_page: true });
    }

    if ((m = path.match(/^\/team\/(\w+)\/task$/)) && method === 'GET') {
      return json({ tasks: [...tasks.values()], last_page: true });
    }

    if ((m = path.match(/^\/task\/([\w-]+)$/)) && method === 'GET') {
      const t = tasks.get(m[1]!);
      return t ? json(t) : json({ err: 'not found' }, 404);
    }

    if ((m = path.match(/^\/task\/([\w-]+)$/)) && method === 'PUT') {
      const t = tasks.get(m[1]!);
      if (!t) return json({ err: 'not found' }, 404);
      if (body.status) t.status = { status: body.status };
      if (body.due_date) t.due_date = body.due_date;
      if (body.priority) t.priority = { id: body.priority };
      if (body.assignees) {
        const { add = [], rem = [] } = body.assignees as unknown as { add?: number[]; rem?: number[] };
        const cur = (t.assignees as Array<{ id: number }>).map((a) => Number(a.id));
        const next = [...cur.filter((id) => !rem.includes(id)), ...add.filter((id) => !cur.includes(id))];
        t.assignees = next.map((id) => ({ id }));
      }
      return json({ id: m[1] });
    }

    if ((m = path.match(/^\/task\/([\w-]+)\/comment$/)) && method === 'POST') {
      const list = comments.get(m[1]!) ?? [];
      list.push({ id: `c${list.length + 1}`, comment_text: body.comment_text, user: { username: 'bot' }, date: '0' });
      comments.set(m[1]!, list);
      return json({ id: 'c' });
    }

    if ((m = path.match(/^\/task\/([\w-]+)\/comment$/)) && method === 'GET') {
      return json({ comments: comments.get(m[1]!) ?? [] });
    }

    if ((m = path.match(/^\/task\/([\w-]+)\/link\/([\w-]+)$/)) && method === 'POST') {
      links.push(`${m[1]}~${m[2]}`);
      return json({ ok: true });
    }

    return json({ err: `fake has no route for ${method} ${path}` }, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, links };
}

// ── The Linear wire fake ─────────────────────────────────────────────────────

function linearFake() {
  const issues = new Map<string, Record<string, unknown>>();
  const comments = new Map<string, Array<Record<string, unknown>>>();
  const relations: string[] = [];
  let nextId = 1;

  const json = (data: unknown): Response =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables: Record<string, never>;
    };
    const input = (variables.input ?? {}) as Record<string, never>;

    if (query.includes('teams(')) return json({ teams: { nodes: [{ id: `team-${variables.key}`, key: variables.key }] } });

    if (query.includes('workflowStates')) {
      return json({ workflowStates: { nodes: STATUSES.map((n) => ({ id: `st-${n.replace(/ /g, '-')}`, name: n })) } });
    }

    if (query.includes('issueCreate')) {
      const id = `lin-${nextId++}`;
      const teamKey = String(input.teamId).replace('team-', '');
      issues.set(id, {
        id,
        title: input.title,
        description: input.description ?? null,
        state: { name: String(input.stateId ?? 'st-to-do').replace('st-', '').replace(/-/g, ' ') },
        assignee: input.assigneeId ? { id: input.assigneeId } : null,
        priority: input.priority ?? null,
        dueDate: input.dueDate ?? null,
        parent: input.parentId ? { id: input.parentId } : null,
        team: { key: teamKey },
      });
      return json({ issueCreate: { success: true, issue: { id } } });
    }

    if (query.includes('issueUpdate')) {
      const i = issues.get(String(variables.id));
      if (!i) return json({ issueUpdate: { success: false } });
      const up = (variables.input ?? {}) as Record<string, never>;
      if (up.stateId) i.state = { name: String(up.stateId).replace('st-', '').replace(/-/g, ' ') };
      if (up.dueDate) i.dueDate = up.dueDate;
      if (up.priority) i.priority = up.priority;
      if ('assigneeId' in up) i.assignee = up.assigneeId ? { id: up.assigneeId } : null;
      if (up.teamId) i.team = { key: String(up.teamId).replace('team-', '') };
      return json({ issueUpdate: { success: true } });
    }

    if (query.includes('commentCreate')) {
      const list = comments.get(String(input.issueId)) ?? [];
      list.push({ id: `c${list.length + 1}`, body: input.body, createdAt: new Date(0).toISOString(), user: { name: 'bot' } });
      comments.set(String(input.issueId), list);
      return json({ commentCreate: { success: true } });
    }

    if (query.includes('issueRelationCreate')) {
      relations.push(`${input.issueId}~${input.relatedIssueId}`);
      return json({ issueRelationCreate: { success: true } });
    }

    if (query.includes('comments(')) {
      return json({ issue: { comments: { nodes: comments.get(String(variables.id)) ?? [] } } });
    }

    if (query.includes('issues(')) return json({ issues: { nodes: [...issues.values()] } });

    if (query.includes('issue(')) {
      const i = issues.get(String(variables.id));
      return json({ issue: i ?? null });
    }

    return json({});
  }) as unknown as typeof fetch;

  return { fetchImpl, relations };
}

// ── The suite ────────────────────────────────────────────────────────────────

type Case = { name: string; make: () => TrackerAdapter };

const ADAPTERS: Case[] = [
  {
    name: 'memory',
    make: () =>
      memoryTracker({
        protectedStatuses: PROTECTED,
        validStatuses: { backend: STATUSES, design: STATUSES },
      }),
  },
  { name: 'clickup', make: () => clickupTracker({ apiToken: 'pk_test', teamId: 'T1', fetchImpl: clickupFake().fetchImpl, protectedStatuses: PROTECTED }) },
  { name: 'linear', make: () => linearTracker({ apiKey: 'lin_test', fetchImpl: linearFake().fetchImpl, protectedStatuses: PROTECTED }) },
];

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'r.json'), JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(join(DIR, 'r.json'));
});
afterEach(() => {
  setOpsRegistryPath(null);
  rmSync(DIR, { recursive: true, force: true });
});

const create = (t: TrackerAdapter, over: Partial<Parameters<TrackerAdapter['apply']>[0]> = {}) =>
  t.apply({
    kind: 'createTask',
    listKey: 'backend',
    title: 'Add rate limiting',
    description: 'Throttle the public endpoints.',
    assignees: ['Avery Chen'],
    status: 'to do',
    ...over,
  } as Parameters<TrackerAdapter['apply']>[0]);

describe.each(ADAPTERS)('$name adapter — the shared contract', ({ make }) => {
  it('round-trips a create through getTask', async () => {
    const t = make();
    const res = await create(t);
    expect(res.status).toBe('applied');
    if (res.status !== 'applied') throw new Error('unreachable');

    const got = await t.getTask(res.resultId!);
    expect(got).toMatchObject({ title: 'Add rate limiting', listKey: 'backend', assignees: ['Avery Chen'] });
  });

  it('returns null for a task that does not exist rather than throwing', async () => {
    expect(await make().getTask('nope-9999')).toBeNull();
  });

  /**
   * The one that silently corrupts a board.
   *
   * ClickUp's wire format only speaks add/rem, so an adapter that sends the desired set as `add`
   * appends — and the previous owner stays on every card the pipeline touches, with no error.
   */
  it('setAssignees REPLACES, it does not append', async () => {
    const t = make();
    const res = await create(t, { assignees: ['Avery Chen'] });
    if (res.status !== 'applied') throw new Error('create failed');
    const id = res.resultId!;

    const out = await t.apply({ kind: 'setAssignees', taskId: id, assignees: ['Rowan Diaz'] });
    if (out.status === 'unsupported') return; // Linear single-assignee case is covered separately

    expect(out.status).toBe('applied');
    expect((await t.getTask(id))!.assignees).toEqual(['Rowan Diaz']);
  });

  it('reports unchanged, not applied, when the value is already what was asked for', async () => {
    const t = make();
    const res = await create(t, { status: 'to do' });
    if (res.status !== 'applied') throw new Error('create failed');

    expect((await t.apply({ kind: 'setStatus', taskId: res.resultId!, status: 'to do' })).status).toBe('unchanged');
  });

  it('fails a status outside the list vocabulary rather than writing something else', async () => {
    const t = make();
    const res = await create(t);
    if (res.status !== 'applied') throw new Error('create failed');

    const out = await t.apply({ kind: 'setStatus', taskId: res.resultId!, status: 'banana' });
    expect(out.status).toBe('failed');
  });

  /** A human moved this card. An automated write must not move it back. */
  it('refuses to touch a card in a protected status', async () => {
    const t = make();
    const res = await create(t);
    if (res.status !== 'applied') throw new Error('create failed');
    const id = res.resultId!;

    expect((await t.apply({ kind: 'setStatus', taskId: id, status: 'in review' })).status).toBe('applied');

    const out = await t.apply({ kind: 'setStatus', taskId: id, status: 'complete' });
    expect(out.status).toBe('refused');
    if (out.status !== 'refused') throw new Error('unreachable');
    expect(out.detail).toMatch(/protected/i);
  });

  it('reports a capability it does not have as unsupported, never as failed', async () => {
    const t = make();
    const res = await create(t);
    if (res.status !== 'applied') throw new Error('create failed');

    const out = await t.apply({ kind: 'moveList', taskId: res.resultId!, listKey: 'design' });
    expect(out.status).toBe(t.capabilities.moveList ? 'applied' : 'unsupported');
    expect(out.status).not.toBe('failed');
  });

  it('refuses to link a task to itself', async () => {
    const t = make();
    const res = await create(t);
    if (res.status !== 'applied') throw new Error('create failed');

    expect((await t.apply({ kind: 'linkTasks', taskIdA: res.resultId!, taskIdB: res.resultId! })).status).toBe('failed');
  });

  it('round-trips comments', async () => {
    const t = make();
    const res = await create(t);
    if (res.status !== 'applied') throw new Error('create failed');

    expect((await t.apply({ kind: 'addComment', taskId: res.resultId!, body: 'moved to review' })).status).toBe('applied');
    expect((await t.getComments(res.resultId!)).map((c) => c.body)).toContain('moved to review');
  });

  /**
   * The snapshot is the model's entire view of the board — a task missing from it cannot be matched,
   * so it silently becomes a duplicate create. Every task must appear, with the fields matching is
   * done on.
   */
  it('renders every task it lists, with its id, title, list and assignee', async () => {
    const t = make();
    const res = await create(t);
    if (res.status !== 'applied') throw new Error('create failed');

    const tasks: BoardTask[] = await t.listTasks({ listKeys: ['backend'] });
    expect(tasks.length).toBeGreaterThan(0);

    const snapshot = t.renderSnapshot(tasks);
    for (const task of tasks) {
      expect(snapshot).toContain(task.id);
      expect(snapshot).toContain(task.title);
      expect(snapshot).toContain(task.listKey);
      for (const a of task.assignees) expect(snapshot).toContain(a);
    }
  });

  it('speaks member names and list keys, never tracker ids', async () => {
    const t = make();
    const res = await create(t);
    if (res.status !== 'applied') throw new Error('create failed');

    const got = (await t.getTask(res.resultId!))!;
    expect(got.assignees).toEqual(['Avery Chen']);
    expect(got.listKey).toBe('backend');
  });
});

/**
 * Where the adapters genuinely differ. A capability matrix where every flag is true everywhere would
 * prove the abstraction was never tested against anything awkward.
 */
describe('capability differences are real, not cosmetic', () => {
  it('ClickUp cannot move a card between lists; Linear can move an issue between teams', () => {
    expect(clickupTracker({ apiToken: 'x', fetchImpl: clickupFake().fetchImpl }).capabilities.moveList).toBe(false);
    expect(linearTracker({ apiKey: 'x', fetchImpl: linearFake().fetchImpl }).capabilities.moveList).toBe(true);
  });

  /**
   * Linear issues hold one assignee. Keeping the first name and dropping the rest would leave a task
   * that looks assigned while the person meant to do it never hears about it.
   */
  it('Linear refuses two assignees as unsupported rather than silently keeping one', async () => {
    const t = linearTracker({ apiKey: 'x', fetchImpl: linearFake().fetchImpl });
    const out = await t.apply({
      kind: 'createTask',
      listKey: 'backend',
      title: 'Pair on the limiter',
      assignees: ['Avery Chen', 'Rowan Diaz'],
    });

    expect(out.status).toBe('unsupported');
    if (out.status !== 'unsupported') throw new Error('unreachable');
    expect(out.detail).toMatch(/single assignee/i);
  });
});
