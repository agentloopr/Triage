import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeldItem } from '../pipeline/gates/contractGates';
import type { CategorizationItem } from '../pipeline/parsing/categorizationManifest';
import { resumeHold } from '../pipeline/resume';
import { type OpsRegistry, setOpsRegistryPath } from '../registry/opsRegistry';
import { memoryTracker } from '../trackers/memory';
import { pendingHumanStore } from './pendingHuman';
import { setCorruptFileNotifier } from './jsonStore';

const DIR = join(tmpdir(), `pending-human-${process.pid}`);
const FILE = join(DIR, 'pending.json');
const REGISTRY_PATH = join(DIR, 'ops-registry.json');

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [{ name: 'Avery Chen', externalIds: { memory: 'u1' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] }],
  routes: [
    { key: 'backend', externalIds: {}, pattern: 'backend|api', defaultAssignee: 'Avery Chen', validAssignees: ['Avery Chen'], status: 'active' },
  ],
  log: [],
};

const ITEM: CategorizationItem = {
  item: 3,
  title: 'Add rate limiting to the public API',
  category: 'NEW_TASK',
  list: 'backend',
  assignee: 'Avery Chen',
  finalDesc: 'Throttle the public endpoints so one client cannot exhaust the pool.',
  tier2Cited: false,
  raw: '',
};

const held = (over: Partial<HeldItem> = {}): HeldItem => ({
  item: 3,
  title: ITEM.title,
  category: 'NEW_TASK',
  gate: 'uncertain field(s)',
  question: 'Which list should this land on?',
  originalItem: ITEM,
  ...over,
});

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(REGISTRY_PATH);
});

afterEach(() => {
  setOpsRegistryPath(null);
  setCorruptFileNotifier(null);
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

describe('pendingHumanStore', () => {
  /**
   * The reason this file exists.
   *
   * A hold that lives only in memory is discarded by a deploy, a crash or an idle timeout, and the
   * failure is silent in the worst direction: the run announced "held for a human", the human answers
   * tomorrow, and the answer lands nowhere at all.
   */
  it('survives a restart — a fresh instance on the same path sees the holds', () => {
    pendingHumanStore(FILE).register('meeting-1', [held()]);

    const afterRestart = pendingHumanStore(FILE); // new instance, no shared memory
    expect(afterRestart.list('meeting-1').map((h) => h.item)).toEqual([3]);
    expect(afterRestart.get('meeting-1#3')?.question).toBe('Which list should this land on?');
  });

  it('scopes ids by source, so two runs holding item 3 do not collide', () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);
    store.register('meeting-2', [held()]);

    expect(store.list()).toHaveLength(2);
    expect(store.list('meeting-2').map((h) => h.id)).toEqual(['meeting-2#3']);
  });

  // A redelivered webhook must not reset the clock on a question someone is already looking at.
  it('keeps the original when the same hold is registered again', () => {
    const store = pendingHumanStore(FILE, { now: () => 1_000 });
    store.register('meeting-1', [held()]);
    pendingHumanStore(FILE, { now: () => 999_000 }).register('meeting-1', [held({ question: 'changed' })]);

    const [only] = store.list('meeting-1');
    expect(store.list('meeting-1')).toHaveLength(1);
    expect(only!.question).toBe('Which list should this land on?');
    expect(only!.heldAtIso).toBe(new Date(1_000).toISOString());
  });

  it('carries the assignee the question should go to', () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held({ notifyAssignee: 'Avery Chen' })]);
    expect(store.get('meeting-1#3')?.notifyAssignee).toBe('Avery Chen');
  });

  /**
   * Answering twice is normal — someone clicks, nothing visibly happens, they click again. The second
   * click must not produce a second card.
   */
  it('resolves once; a second resolve reports unknown rather than resolving again', () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    expect(store.resolve('meeting-1#3', 'approve').status).toBe('resolved');
    expect(store.resolve('meeting-1#3', 'approve').status).toBe('unknown');
    expect(store.list()).toEqual([]);
  });

  it('removes the hold on skip too, without offering anything to execute', () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    const res = store.resolve('meeting-1#3', 'skip');
    expect(res).toMatchObject({ status: 'resolved', decision: 'skip' });
    expect(store.list()).toEqual([]);
  });

  /**
   * Some gates hold a whole batch without a usable per-item decision — the registry-degraded
   * short-circuit is the live example. Approving one of those would have to invent the write.
   */
  it('refuses to approve a hold recorded without a per-item decision', () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held({ originalItem: undefined, gate: 'ops registry unavailable' })]);

    const res = store.resolve('meeting-1#3', 'approve');
    expect(res.status).toBe('not_resumable');
    expect(store.list()).toHaveLength(1); // still there — refusing must not lose the hold
  });

  it('reports a corrupt file and starts empty rather than pretending it was absent', () => {
    const reports: string[] = [];
    setCorruptFileNotifier((m) => reports.push(m));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(FILE, '{ not json', 'utf8');

    expect(pendingHumanStore(FILE).list()).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('CORRUPT');
  });

  it('writes atomically, leaving no temp file behind', () => {
    pendingHumanStore(FILE).register('meeting-1', [held()]);
    expect(JSON.parse(readFileSync(FILE, 'utf8')).holds).toHaveLength(1);
    expect(() => readFileSync(`${FILE}.tmp-${process.pid}`, 'utf8')).toThrow();
  });
});

/**
 * The resume path, end to end.
 *
 * The property under test is not "a task appears" — it is that the task appears **from the decision
 * the human was shown**, with no second inference. A model call on resume would mean the approval and
 * the write came from different reasoning, and nothing downstream could tell.
 */
describe('resumeHold', () => {
  it('writes the approved item through the normal execution chain, with no model involved', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);
    const tracker = memoryTracker({ tasks: [] });

    const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker });

    expect(out.status).toBe('executed');
    if (out.status !== 'executed') throw new Error('unreachable');
    expect(out.exec.created).toBe(1);

    const board = await tracker.listTasks();
    expect(board.map((t) => t.title)).toEqual(['Add rate limiting to the public API']);
    expect(board[0]!.listKey).toBe('backend');
    expect(board[0]!.assignees).toEqual(['Avery Chen']);
  });

  it('survives the restart in between — hold now, approve after a reload', async () => {
    pendingHumanStore(FILE).register('meeting-1', [held()]);

    const out = await resumeHold(pendingHumanStore(FILE), 'meeting-1#3', 'approve', {
      tracker: memoryTracker({ tasks: [] }),
    });
    expect(out.status).toBe('executed');
  });

  it('writes nothing on skip', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);
    const tracker = memoryTracker({ tasks: [] });

    expect((await resumeHold(store, 'meeting-1#3', 'skip', { tracker })).status).toBe('skipped');
    expect(await tracker.listTasks()).toEqual([]);
  });

  it('writes nothing twice when the answer arrives twice', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);
    const tracker = memoryTracker({ tasks: [] });

    await resumeHold(store, 'meeting-1#3', 'approve', { tracker });
    const second = await resumeHold(store, 'meeting-1#3', 'approve', { tracker });

    expect(second.status).toBe('unknown');
    expect(await tracker.listTasks()).toHaveLength(1);
  });

  // ── The hold must outlive a failed write ────────────────────────────────────────────────────
  //
  // `resolve()` deleted the hold and THEN executed. A tracker outage, a protected-status refusal or
  // an unsupported operation left the board unchanged and the queue entry gone: the human's decision
  // was destroyed, a retry answered `unknown`, and the source id was already consumed by idempotency
  // so re-running the source would not recreate it. Found by an outside audit.
  //
  // Worse, only `failed` was read as failure. A refusal reported as an approved write is the quiet
  // one — it looks finished and nothing changed.

  const failing = (outcome: 'failed' | 'refused' | 'unsupported') => {
    const tracker = memoryTracker({ tasks: [] });
    return {
      ...tracker,
      apply: async () => {
        if (outcome === 'failed') throw new Error('tracker unreachable');
        return { status: outcome, reason: `simulated ${outcome}` };
      },
    } as unknown as ReturnType<typeof memoryTracker>;
  };

  it.each(['failed', 'refused', 'unsupported'] as const)(
    'keeps the hold open when the write comes back %s',
    async (outcome) => {
      const store = pendingHumanStore(FILE);
      store.register('meeting-1', [held()]);

      const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker: failing(outcome) });

      expect(out.status).toBe('write_failed');
      // The decision survives, so the human can retry or skip rather than losing it.
      expect(store.list().map((h) => h.id)).toEqual(['meeting-1#3']);
    }
  );

  it('is retryable after a failure — the same id approves once the tracker recovers', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    expect((await resumeHold(store, 'meeting-1#3', 'approve', { tracker: failing('failed') })).status).toBe('write_failed');

    const tracker = memoryTracker({ tasks: [] });
    const retry = await resumeHold(store, 'meeting-1#3', 'approve', { tracker });

    expect(retry.status).toBe('executed');
    expect(await tracker.listTasks()).toHaveLength(1);
    expect(store.list()).toEqual([]);
  });

  it('audits the approved write against a fresh board read, like the pipeline does', async () => {
    // Approved work used to be the only work in the system never audited, which is backwards: an
    // item a human had to think about is the one most worth verifying afterwards.
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker: memoryTracker({ tasks: [] }) });

    expect(out.status).toBe('executed');
    if (out.status !== 'executed') throw new Error('unreachable');
    expect(out.audit.mismatched).toBe(0);
    expect(out.audit.passed).toBeGreaterThan(0);
  });

  it('records approved work in role state, so the next run remembers it', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);
    const recorded: Array<{ role: string; count: number }> = [];

    await resumeHold(store, 'meeting-1#3', 'approve', {
      tracker: memoryTracker({ tasks: [] }),
      roleState: { record: (role, items) => recorded.push({ role, count: items.length }) },
    });

    expect(recorded).toEqual([{ role: 'engineer', count: 1 }]);
  });

  it('explains itself rather than writing when the hold has no decision behind it', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held({ originalItem: undefined, gate: 'ops registry unavailable' })]);
    const tracker = memoryTracker({ tasks: [] });

    const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker });
    expect(out.status).toBe('not_resumable');
    if (out.status !== 'not_resumable') throw new Error('unreachable');
    expect(out.reason).toContain('inventing the write');
    expect(await tracker.listTasks()).toEqual([]);
  });

  /**
   * Approving while the roster is unreadable must not write an unassignable card.
   *
   * The resume path deliberately does NOT re-check the registry — that is why the degraded-registry
   * gate holds the whole batch rather than individual items. This asserts the remaining edge: if the
   * registry goes away *between* the hold and the answer, planning fails the item instead of writing
   * it to nobody. The write is recoverable by re-answering; a task assigned to no one is not.
   */
  it('fails the item rather than writing it unassigned when the roster went away', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);
    setOpsRegistryPath(join(DIR, 'gone.json'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tracker = memoryTracker({ tasks: [] });

    const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker });

    // Nothing was written, so the hold is STILL OPEN. This test's own comment used to say the
    // situation was "recoverable by re-answering" while the implementation deleted the hold before
    // executing — a comment describing behaviour nobody had asserted. Now it is asserted.
    expect(out.status).toBe('write_failed');
    if (out.status !== 'write_failed') throw new Error('unreachable');
    expect(out.exec.created).toBe(0);
    expect(await tracker.listTasks()).toEqual([]);
    expect(store.list().map((h) => h.id)).toEqual(['meeting-1#3']);
  });

  it('reports unknown for an id that was never held', async () => {
    const out = await resumeHold(pendingHumanStore(FILE), 'meeting-9#1', 'approve', {
      tracker: memoryTracker({ tasks: [] }),
    });
    expect(out.status).toBe('unknown');
  });
});
