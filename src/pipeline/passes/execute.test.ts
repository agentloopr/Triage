import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OpsRegistry, setOpsRegistryPath } from '../../registry/opsRegistry';
import { setCorrectionsPath } from '../../state/corrections';
import type { BoardTask } from '../../trackers';
import { memoryTracker } from '../../trackers/memory';
import type { CategorizationItem } from '../parsing/categorizationManifest';
import { auditPostWrite, formatAuditResult } from './audit';
import { executeOperations, planAction, planOperations } from './execute';

const DIR = join(tmpdir(), `execute-test-${process.pid}`);
const REGISTRY_PATH = join(DIR, 'ops-registry.json');

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: { clickup: '1' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] },
    { name: 'Rowan Diaz', externalIds: { clickup: '2' }, email: 'r@x.com', role: 'designer', defaultProjects: [] },
  ],
  routes: [
    { key: 'backend', externalIds: {}, pattern: 'backend', validAssignees: [], status: 'active' },
    { key: 'design', externalIds: {}, pattern: 'design', validAssignees: [], status: 'active' },
  ],
  log: [],
};

const BOARD: BoardTask[] = [
  { id: 't100', title: 'Add rate limiting', listKey: 'backend', assignees: ['Avery Chen'], status: 'to do' },
  { id: 't200', title: 'Onboarding revamp', listKey: 'design', assignees: ['Rowan Diaz'], status: 'in progress' },
];

const item = (over: Partial<CategorizationItem> = {}): CategorizationItem => ({
  item: 1, title: 'A deliverable', category: 'NEW_TASK', tier2Cited: false, raw: '',
  list: 'backend', assignee: 'Avery Chen', finalDesc: 'do the thing', ...over,
});

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(REGISTRY_PATH);
  setCorrectionsPath(join(DIR, 'corrections.json'));
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  rmSync(DIR, { recursive: true, force: true });
});

describe('planAction — pure', () => {
  it('plans a create for a NEW_TASK, in names and list keys only', () => {
    const a = planAction(item({ priority: 'high', dueDate: '2026-09-01', status: 'to do' }));
    expect(a.outcome).toBe('planned');
    expect(a.ops).toEqual([
      {
        kind: 'createTask', listKey: 'backend', title: 'A deliverable', description: 'do the thing',
        assignees: ['Avery Chen'], priority: 'high', dueDate: '2026-09-01', status: 'to do',
      },
    ]);
  });

  it('carries the parent for a SUBTASK', () => {
    const a = planAction(item({ category: 'SUBTASK', parentTaskId: 't200' }));
    expect(a.ops[0]).toMatchObject({ kind: 'createTask', parentId: 't200' });
  });

  it('fails a SUBTASK with no parent rather than creating an orphan', () => {
    const a = planAction(item({ category: 'SUBTASK' }));
    expect(a.outcome).toBe('failed');
    expect(a.detail).toContain('PARENT_TASK_ID');
  });

  // Deciding NOT to write is a correct outcome, and must be recorded as distinct from a failure.
  it('emits no operations for a DUPLICATE, and does not call it a failure', () => {
    const a = planAction(item({ category: 'DUPLICATE', existingTaskId: 't100' }));
    expect(a.ops).toEqual([]);
    expect(a.outcome).toBe('skipped_duplicate');
  });

  /**
   * On an UPDATE, a present LIST or ASSIGNEE means "move it" / "reassign it" — the categorization
   * prompt only emits them when the source explicitly directed that change. These helpers make each
   * test say exactly which fields it is exercising, since inheriting them is how a spurious move gets
   * planned.
   */
  const update = (over: Partial<CategorizationItem> = {}): CategorizationItem => ({
    ...item({ category: 'UPDATE', existingTaskId: 't100', finalDesc: 'progress' }),
    list: undefined, assignee: undefined, ...over,
  });

  it('plans an UPDATE comment first, then only the directed changes, in order', () => {
    const a = planAction(update({ status: 'in review', dueDate: '2026-09-02', priority: 'urgent' }));
    expect(a.ops.map((o) => o.kind)).toEqual(['addComment', 'setStatus', 'setDueDate', 'setPriority']);
  });

  it('omits fields the source never directed', () => {
    expect(planAction(update()).ops.map((o) => o.kind)).toEqual(['addComment']);
  });

  it('treats a reassignment as replace, not append', () => {
    expect(planAction(update({ assignee: 'Rowan Diaz' })).ops).toContainEqual({
      kind: 'setAssignees', taskId: 't100', assignees: ['Rowan Diaz'],
    });
  });

  // Emitted even where a tracker cannot do it — the adapter answers `unsupported`, so a human sees
  // the instruction rather than it being silently dropped.
  it('emits a move as an operation rather than dropping it', () => {
    expect(planAction(update({ list: 'design' })).ops).toContainEqual({
      kind: 'moveList', taskId: 't100', listKey: 'design',
    });
  });

  it('plans a link for RELATE and fails without both ids', () => {
    expect(planAction(item({ category: 'RELATE', linkTaskId1: 't100', linkTaskId2: 't200' })).ops).toEqual([
      { kind: 'linkTasks', taskIdA: 't100', taskIdB: 't200' },
    ]);
    expect(planAction(item({ category: 'RELATE', linkTaskId1: 't100' })).outcome).toBe('failed');
  });

  it('fails on an unresolvable list or assignee instead of guessing', () => {
    expect(planAction(item({ list: 'nowhere' })).detail).toContain('unresolvable list');
    expect(planAction(item({ assignee: 'Ghost' })).detail).toContain('unresolvable assignee');
  });

  it('ignores a priority value that is not in the vocabulary', () => {
    expect(planAction(item({ priority: 'extremely urgent' })).ops[0]).not.toHaveProperty('priority');
  });

  it('falls back to the run date when the source stated no due date', () => {
    expect(planAction(item(), { todayIso: '2026-08-11' }).ops[0]).toMatchObject({ dueDate: '2026-08-11' });
  });

  // An over-long title fails the write outright on a real tracker, silently dropping the action.
  it('clamps a pathological title and preserves the full text in the body', () => {
    const long = 'x'.repeat(400);
    const op = planAction(item({ title: long, finalDesc: 'body' })).ops[0]!;
    expect(op.kind === 'createTask' && op.title.length).toBeLessThanOrEqual(256);
    expect(op.kind === 'createTask' && op.description).toContain(long);
  });

  it('plans a whole batch in order', () => {
    expect(planOperations([item({ item: 1 }), item({ item: 2, category: 'DUPLICATE', existingTaskId: 't100' })]))
      .toMatchObject([{ item: 1, outcome: 'planned' }, { item: 2, outcome: 'skipped_duplicate' }]);
  });
});

describe('executeOperations', () => {
  const tracker = () => memoryTracker({ tasks: BOARD, protectedStatuses: ['complete'] });

  it('applies a plan and tallies what happened', async () => {
    const t = tracker();
    const out = await executeOperations(planOperations([item()]), t);
    expect(out.created).toBe(1);
    expect(out.actions[0]!.ok).toBe(true);
  });

  it('records a duplicate as skipped, not failed', async () => {
    const out = await executeOperations(planOperations([item({ category: 'DUPLICATE', existingTaskId: 't100' })]), tracker());
    expect(out).toMatchObject({ skipped: 1, failed: 0, created: 0 });
  });

  it('reports an unsupported operation without treating it as a crash', async () => {
    const t = memoryTracker({ tasks: BOARD });
    const plan = planOperations([item({ category: 'UPDATE', existingTaskId: 't100', finalDesc: 'x', list: 'design' })]);
    const out = await executeOperations(plan, t);
    expect(out.commented).toBe(1);
    expect(out.actions[0]!.results.find((r) => r.op.kind === 'moveList')?.outcome.status).toBe('applied');
  });

  // One bad card must cost that card, not the run.
  it('keeps going after an item fails', async () => {
    const plan = planOperations([item({ item: 1, category: 'SUBTASK' }), item({ item: 2 })]);
    const out = await executeOperations(plan, tracker());
    expect(out.failed).toBe(1);
    expect(out.created).toBe(1);
  });

  it('survives an adapter that throws', async () => {
    const exploding = { ...memoryTracker(), apply: async () => { throw new Error('tracker exploded'); } };
    const out = await executeOperations(planOperations([item()]), exploding);
    expect(out.failed).toBe(1);
    expect(out.actions[0]!.results[0]!.outcome).toMatchObject({ status: 'failed', detail: 'tracker exploded' });
  });
});

describe('auditPostWrite', () => {
  const run = async (items: CategorizationItem[]) => {
    const t = memoryTracker({ tasks: BOARD });
    const exec = await executeOperations(planOperations(items), t);
    return { exec, fresh: t.snapshotTasks() };
  };

  it('passes a create that actually landed', async () => {
    const items = [item()];
    const { exec, fresh } = await run(items);
    const audit = auditPostWrite(items, exec, fresh);
    expect(audit.mismatched).toBe(0);
    expect(audit.lines[0]!.detail).toContain('created as');
  });

  // The failure a pre-write gate structurally cannot see: reported success, no card.
  it('catches a create that reported success but produced no card', async () => {
    const items = [item()];
    const { exec } = await run(items);
    const audit = auditPostWrite(items, exec, BOARD); // fresh read without the new card
    expect(audit.mismatched).toBe(1);
    expect(audit.lines[0]!.detail).toContain('no matching card');
  });

  it('catches a card that landed on the wrong list', async () => {
    const items = [item()];
    const { exec, fresh } = await run(items);
    const moved = fresh.map((t) => (t.title === 'A deliverable' ? { ...t, listKey: 'design' } : t));
    expect(auditPostWrite(items, exec, moved).lines[0]!.detail).toContain('but the plan said');
  });

  it('catches a target card deleted mid-run', async () => {
    const items = [item({ category: 'UPDATE', existingTaskId: 't100', finalDesc: 'x' })];
    const { exec } = await run(items);
    const audit = auditPostWrite(items, exec, BOARD.filter((t) => t.id !== 't100'));
    expect(audit.lines[0]!.detail).toContain('deleted or closed mid-run');
  });

  it('passes an update whose comment landed', async () => {
    const items = [item({ category: 'UPDATE', existingTaskId: 't100', finalDesc: 'progress' })];
    const { exec, fresh } = await run(items);
    expect(auditPostWrite(items, exec, fresh).mismatched).toBe(0);
  });

  it('catches an item that was held but executed anyway', async () => {
    const { exec, fresh } = await run([item()]);
    const audit = auditPostWrite([], exec, fresh, [
      { item: 9, title: 'A deliverable', category: 'NEW_TASK', gate: 'uncertain field(s)', question: '?' },
    ]);
    expect(audit.mismatched).toBe(1);
    expect(audit.lines[0]!.detail).toContain('executed anyway');
  });

  it('catches a plan line the executor never reported on', () => {
    const audit = auditPostWrite([item()], { actions: [], created: 0, commented: 0, skipped: 0, refused: 0, failed: 0, unsupported: 0 }, BOARD);
    expect(audit.lines[0]!.detail).toContain('the run was partial');
  });

  it('stays silent when everything reconciles', async () => {
    const items = [item()];
    const { exec, fresh } = await run(items);
    expect(auditPostWrite(items, exec, fresh).report).toBe('');
  });

  it('formats one round-trippable line per item', async () => {
    const items = [item()];
    const { exec, fresh } = await run(items);
    expect(formatAuditResult(auditPostWrite(items, exec, fresh))).toMatch(/^\[PASS\] ITEM 1 — /);
  });
});
