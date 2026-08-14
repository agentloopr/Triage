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
    expect(out.audit?.mismatched).toBe(0);
    expect(out.audit?.passed).toBeGreaterThan(0);
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

  // ── Concurrency, partial writes, and a failed audit ─────────────────────────────────────────
  //
  // All three were introduced by the fix that split claim from finalize, and all three were found by
  // an outside audit running them rather than reading them.

  it('does not execute the same hold twice when two approvals race', async () => {
    // Measured before the claim existed: two concurrent approvals put TWO cards on the board from
    // one decision. The previous design avoided this by deleting the hold first — so durability and
    // exclusivity were being provided by the same delete, and splitting them lost one.
    pendingHumanStore(FILE).register('meeting-1', [held()]);
    const tracker = memoryTracker({ tasks: [] });

    const [a, b] = await Promise.all([
      resumeHold(pendingHumanStore(FILE), 'meeting-1#3', 'approve', { tracker }),
      resumeHold(pendingHumanStore(FILE), 'meeting-1#3', 'approve', { tracker }),
    ]);

    expect(await tracker.listTasks()).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual(['executed', 'in_progress']);
  });

  it('releases the claim when nothing was written, so a retry can take it', async () => {
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    const failed = await resumeHold(store, 'meeting-1#3', 'approve', { tracker: failing('failed') });
    expect(failed.status).toBe('write_failed');

    // Not blocked behind a stale claim: the next attempt proceeds immediately.
    const retry = await resumeHold(pendingHumanStore(FILE), 'meeting-1#3', 'approve', {
      tracker: memoryTracker({ tasks: [] }),
    });
    expect(retry.status).toBe('executed');
  });

  it('closes the hold when the write is PARTIAL, because a retry would duplicate what landed', async () => {
    // An UPDATE plans a comment first, then field changes. If the comment applies and a later
    // operation is refused, treating the item as "not written" and leaving it retryable adds the
    // comment again on every retry.
    const base = memoryTracker({ tasks: [{ id: 't100', title: 'Existing card', status: 'open', listKey: 'backend', assignees: ['Avery Chen'] } as never] });
    let n = 0;
    const halfway = {
      ...base,
      apply: async (op: never) => (++n === 1 ? base.apply(op) : { status: 'refused' as const, reason: 'protected status' }),
    } as unknown as ReturnType<typeof memoryTracker>;

    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [
      held({ originalItem: { ...ITEM, category: 'UPDATE', existingTaskId: 't100', status: 'done' } }),
    ]);

    const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker: halfway });

    expect(out.status).toBe('partially_written');
    expect(store.list()).toEqual([]); // closed — NOT retryable
  });

  it('keeps the write when the post-write audit read fails, instead of re-writing on retry', async () => {
    // The audit re-reads the tracker, and it used to run BEFORE the hold was closed. A read timeout
    // threw past `finalize`, leaving a written card and an open hold — so the retry wrote a second
    // card. A post-hoc check must not be able to undo the record of what already happened.
    const base = memoryTracker({ tasks: [] });
    let reads = 0;
    const flaky = {
      ...base,
      listTasks: async (o?: never) => {
        if (++reads === 1) throw new Error('read timeout');
        return base.listTasks(o);
      },
    } as unknown as ReturnType<typeof memoryTracker>;

    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker: flaky });

    expect(out.status).toBe('executed');
    if (out.status !== 'executed') throw new Error('unreachable');
    expect(out.audit).toBeUndefined();
    expect(out.auditError).toMatch(/read timeout/);
    expect(await base.listTasks()).toHaveLength(1);
    expect(store.list()).toEqual([]); // closed, so no retry can write a second card
  });

  it('refuses a skip that races an in-flight approval', async () => {
    // Measured before the guard covered both decisions: the approve wrote a card AND the skip
    // reported the same hold skipped — two confirmations, opposite meanings, one decision. The live
    // claim now blocks EITHER decision, because an item already being acted on is not available.
    pendingHumanStore(FILE).register('meeting-1', [held()]);
    const tracker = memoryTracker({ tasks: [] });

    const [a, b] = await Promise.all([
      resumeHold(pendingHumanStore(FILE), 'meeting-1#3', 'approve', { tracker }),
      resumeHold(pendingHumanStore(FILE), 'meeting-1#3', 'skip', { tracker }),
    ]);

    expect([a.status, b.status].sort()).toEqual(['executed', 'in_progress']);
    expect(await tracker.listTasks()).toHaveLength(1);
  });

  it('resolves an approved DUPLICATE instead of leaving it stuck', async () => {
    // A DUPLICATE plans zero operations — `planOperations` calls that `skipped_duplicate` and says
    // in its own comment that deciding NOT to write is the correct outcome. Counting applied
    // operations read that as "nothing landed", so approving one answered `write_failed` forever and
    // `--skip` was the only exit — and skip means "drop this", not "yes, it really is a duplicate".
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [
      held({ category: 'DUPLICATE', originalItem: { ...ITEM, category: 'DUPLICATE', existingTaskId: 't100' } }),
    ]);
    const tracker = memoryTracker({ tasks: [] });

    const out = await resumeHold(store, 'meeting-1#3', 'approve', { tracker });

    expect(out.status).toBe('executed');
    expect(await tracker.listTasks()).toEqual([]); // correctly wrote nothing
    expect(store.list()).toEqual([]); // and the question is answered
  });

  it('still audits when the write was only PARTIAL, and lets role state make its own call', async () => {
    // The board changed, so the post-write audit must run: the first version returned early on
    // `partial` and skipped it, leaving the board altered and unverified.
    //
    // Role memory is the subtler half. It is now *offered* the result rather than bypassed — and it
    // declines, because `recordExecutedWorkByRole` only records actions where every operation
    // applied. That is deliberate and predates this: a card whose status change was refused is not
    // "open for" its owner in the shape the memory claims. Being consulted and saying no is a
    // different thing from never being asked, and only the second one was a bug.
    const base = memoryTracker({
      tasks: [{ id: 't100', title: 'Existing card', status: 'open', listKey: 'backend', assignees: ['Avery Chen'] } as never],
    });
    let n = 0;
    const halfway = {
      ...base,
      apply: async (op: never) => (++n === 1 ? base.apply(op) : { status: 'refused' as const, reason: 'protected status' }),
    } as unknown as ReturnType<typeof memoryTracker>;

    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [
      held({ originalItem: { ...ITEM, category: 'UPDATE', existingTaskId: 't100', status: 'done' } }),
    ]);
    const recorded: string[] = [];

    const out = await resumeHold(store, 'meeting-1#3', 'approve', {
      tracker: halfway,
      roleState: { record: (role) => recorded.push(role) },
    });

    expect(out.status).toBe('partially_written');
    if (out.status !== 'partially_written') throw new Error('unreachable');
    expect(out.audit, 'the audit must run — the board changed').toBeDefined();
    expect(recorded, 'a not-ok action is not recorded as open work').toEqual([]);
  });

  it('refuses to finalize a hold nobody has claimed, whatever token is offered', () => {
    // The guard read `hold.claim && hold.claim.token !== claimToken`, so an UNCLAIMED hold fell
    // straight through and any string deleted it — the token proved nothing in exactly the case
    // where nothing else did either.
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    expect(store.finalize('meeting-1#3', 'i-made-this-up')).toBe(false);
    expect(store.list()).toHaveLength(1);

    // And the real token, taken through a claim, still works.
    const claimed = store.claim('meeting-1#3', 'skip');
    if (claimed.status !== 'resolved') throw new Error('unreachable');
    expect(store.finalize('meeting-1#3', claimed.claimToken)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('reports in_progress from resolve() when the claim was taken over between claim and finalize', () => {
    // `resolve` discarded finalize's return — the same silent-success bug `resumeHold` had, one
    // layer down. A hold whose claim was stolen mid-resolve reported `resolved` regardless.
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);

    const original = store.claim;
    // Steal the claim in the gap: claim, then immediately re-claim from "elsewhere" so our token is
    // no longer the live one.
    store.claim = ((id, decision) => {
      const res = original.call(store, id, decision);
      if (res.status === 'resolved') {
        store.release(id, res.claimToken);
        original.call(store, id, 'approve'); // someone else now owns it
      }
      return res;
    }) as typeof store.claim;

    expect(store.resolve('meeting-1#3', 'skip').status).toBe('in_progress');
    expect(store.list(), 'the hold survives a resolution that did not take effect').toHaveLength(1);
  });

  it('takes the cross-process lock in register, like every other mutation', () => {
    // `register` was the one method left outside the lock — and it is the one the PIPELINE calls
    // while a human may be answering. An audit probe watched an unlocked register read the file, an
    // approval write a claim into it, and the register's write put the pre-claim copy back, erasing
    // a claim already granted.
    //
    // **A single-process test cannot observe that race**, which is why the first version of this
    // test passed with the lock removed. So the property is asserted directly instead: hold the lock
    // from outside, and a locking method must refuse to proceed.
    writeFileSync(`${FILE}.lock`, 'another-process');
    const store = pendingHumanStore(FILE, { lock: { timeoutMs: 50, staleMs: 60_000 } });

    expect(() => store.register('meeting-1', [held()]), 'register did not wait for the lock').toThrow(/timed out/);

    // The sibling methods, for the same reason and the same money.
    expect(() => store.claim('meeting-1#3', 'approve')).toThrow(/timed out/);
    expect(() => store.finalize('meeting-1#3', 'tok')).toThrow(/timed out/);
  });

  it('reports rather than silently succeeding when the claim was taken over mid-write', async () => {
    // `finalize` returns false when someone else owns the hold now. Ignoring that return meant a
    // write landed, the hold stayed with its new owner, and the operator was told "approved" — the
    // quietest possible route to a duplicate card.
    const store = pendingHumanStore(FILE);
    store.register('meeting-1', [held()]);
    const alerts: string[] = [];

    // Steal the claim while the write is in flight, by expiring ours and claiming from elsewhere.
    const tracker = memoryTracker({ tasks: [] });
    const stealing = {
      ...tracker,
      apply: async (op: never) => {
        const other = pendingHumanStore(FILE);
        const h = other.list().find((x) => x.id === 'meeting-1#3');
        if (h?.claim) other.release('meeting-1#3', h.claim.token); // ours is gone
        other.claim('meeting-1#3', 'approve'); // now someone else holds it
        return tracker.apply(op);
      },
    } as unknown as ReturnType<typeof memoryTracker>;

    const out = await resumeHold(store, 'meeting-1#3', 'approve', {
      tracker: stealing,
      alert: (d) => alerts.push(d),
    });

    expect(out.status).toBe('executed');
    if (out.status !== 'executed') throw new Error('unreachable');
    expect(out.staleClaim, 'a taken-over claim must be reported, not swallowed').toBeDefined();
    expect(alerts.join(' ')).toMatch(/duplicate/i);
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
