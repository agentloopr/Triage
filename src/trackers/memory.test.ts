import { describe, it, expect } from 'vitest';
import { type BoardTask } from './index';
import { memoryTracker } from './memory';
import { renderBoardSnapshot, orderTasks } from './renderSnapshot';

const TASKS: BoardTask[] = [
  { id: 't1', title: 'Ship onboarding revamp', listKey: 'backend', assignees: ['Avery Chen'], status: 'in progress', description: 'Rework first-run.' },
  { id: 't2', title: 'Wire the welcome email', listKey: 'backend', assignees: [], status: 'to do', parentId: 't1' },
  { id: 't3', title: 'Refresh the marketing site', listKey: 'design', assignees: ['Rowan Diaz'], status: 'complete' },
];

const make = () =>
  memoryTracker({
    tasks: TASKS,
    protectedStatuses: ['complete'],
    validStatuses: { backend: ['to do', 'in progress', 'complete'] },
  });

describe('memoryTracker reads', () => {
  it('hides closed tasks by default and includes them on request', async () => {
    const t = make();
    expect((await t.listTasks()).map((x) => x.id)).toEqual(['t1', 't2']);
    expect((await t.listTasks({ includeClosed: true })).map((x) => x.id)).toEqual(['t1', 't2', 't3']);
  });

  it('filters by list key', async () => {
    expect((await make().listTasks({ listKeys: ['design'], includeClosed: true })).map((x) => x.id)).toEqual(['t3']);
  });

  // Callers mutating a returned task must not silently edit the board.
  it('returns copies, not live references', async () => {
    const t = make();
    const got = await t.getTask('t1');
    got!.assignees.push('Someone Else');
    expect((await t.getTask('t1'))!.assignees).toEqual(['Avery Chen']);
  });
});

describe('OpOutcome distinguishes the three non-failure results', () => {
  it('applied — a real change', async () => {
    expect(await make().apply({ kind: 'setStatus', taskId: 't1', status: 'to do' })).toEqual({ status: 'applied' });
  });

  it('unchanged — already in the desired state, which is not a change and not an error', async () => {
    const out = await make().apply({ kind: 'setStatus', taskId: 't1', status: 'in progress' });
    expect(out.status).toBe('unchanged');
  });

  // A card a human already moved to a terminal state must never be dragged back by an automated write.
  it('refused — a guard says a human has to decide', async () => {
    const out = await make().apply({ kind: 'setStatus', taskId: 't3', status: 'to do' });
    expect(out.status).toBe('refused');
    expect(out).toHaveProperty('detail', expect.stringContaining('protected'));
  });

  it('failed — a status outside the list vocabulary', async () => {
    const out = await make().apply({ kind: 'setStatus', taskId: 't1', status: 'shipped-ish' });
    expect(out.status).toBe('failed');
  });

  it('failed — an operation against a task that does not exist', async () => {
    expect((await make().apply({ kind: 'addComment', taskId: 'nope', body: 'hi' })).status).toBe('failed');
  });
});

describe('write semantics', () => {
  it('createTask returns the new id and the task becomes visible', async () => {
    const t = make();
    const out = await t.apply({
      kind: 'createTask', listKey: 'backend', title: 'New work', assignees: ['Avery Chen'], status: 'to do',
    });
    expect(out.status).toBe('applied');
    const id = out.status === 'applied' ? out.resultId! : '';
    expect((await t.getTask(id))?.title).toBe('New work');
  });

  it('createTask fails when the declared parent does not exist', async () => {
    const out = await make().apply({
      kind: 'createTask', listKey: 'backend', title: 'Orphan', assignees: [], parentId: 'ghost',
    });
    expect(out.status).toBe('failed');
  });

  // The one that silently corrupts a board if an adapter gets it backwards.
  it('setAssignees REPLACES rather than appends', async () => {
    const t = make();
    await t.apply({ kind: 'setAssignees', taskId: 't1', assignees: ['Rowan Diaz'] });
    expect((await t.getTask('t1'))?.assignees).toEqual(['Rowan Diaz']);
  });

  it('linkTasks refuses a self-link and is idempotent otherwise', async () => {
    const t = make();
    expect((await t.apply({ kind: 'linkTasks', taskIdA: 't1', taskIdB: 't1' })).status).toBe('failed');
    expect((await t.apply({ kind: 'linkTasks', taskIdA: 't1', taskIdB: 't2' })).status).toBe('applied');
    expect((await t.apply({ kind: 'linkTasks', taskIdA: 't2', taskIdB: 't1' })).status).toBe('unchanged');
  });

  it('records every attempted operation for the audit, including refused ones', async () => {
    const t = make();
    await t.apply({ kind: 'setStatus', taskId: 't3', status: 'to do' }); // refused
    expect(t.ops).toHaveLength(1);
  });
});

describe('snapshot rendering', () => {
  it('places each subtask immediately after its parent and tags it', () => {
    const rows = renderBoardSnapshot(TASKS).split('\n');
    expect(rows[0]).toContain('t1');
    expect(rows[1]).toContain('[SUBTASK of t1]');
  });

  it('renders id | title | list | assignees | status | description', () => {
    const first = renderBoardSnapshot(TASKS).split('\n')[0]!;
    expect(first.split(' | ')).toEqual([
      't1', 'Ship onboarding revamp', 'backend', 'Avery Chen', 'in progress', 'Rework first-run.',
    ]);
  });

  it('caps long descriptions', () => {
    const long: BoardTask[] = [{ ...TASKS[0]!, description: 'x'.repeat(50) }];
    expect(renderBoardSnapshot(long, { descMaxChars: 10 })).toContain(`${'x'.repeat(10)}…`);
  });

  // A subtask whose parent is not in the page would otherwise vanish from the board entirely.
  it('keeps an orphaned subtask rather than dropping it', () => {
    const orphan: BoardTask[] = [{ id: 'x9', title: 'Orphan', listKey: 'backend', assignees: [], status: 'to do', parentId: 'gone' }];
    expect(orderTasks(orphan)).toHaveLength(1);
  });
});
