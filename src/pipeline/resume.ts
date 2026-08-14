/**
 * The resume path: a human answers a held question, and the item finishes.
 *
 * The whole point is that **no model runs here.** The categorization was made once, gated once, and
 * stored; resolving replays that stored decision through the same `planOperations` →
 * `executeOperations` → `finalizeWrite` chain the clean items went through. A second inference on
 * resume would mean the human approved one thing and something else got written — and the divergence
 * would be invisible, because both outputs look like the model's work.
 *
 * ── TWO THINGS THIS FILE GOT WRONG, BOTH FOUND BY AN OUTSIDE AUDIT ────────────────────────────
 *
 * **1. It deleted the hold before the write succeeded.** `store.resolve()` removed the entry, then
 * the tracker was called. A timeout, a protected-status refusal or an unsupported operation left the
 * board unchanged and the queue entry gone: the human's decision was destroyed, a second attempt
 * returned `unknown`, and the source id was already consumed by idempotency, so re-running would not
 * recreate it. The decision is now *claimed*, acted on, and only then *finalized*.
 *
 * **2. `exec.failed === 0` was read as success.** It is not. `refused` (the adapter declined on
 * policy) and `unsupported` (the tracker cannot express this operation) also mean the board did not
 * change — and a refusal reported as an approved write is the worst of the three, because it is
 * silent and looks finished. All three now keep the hold open.
 *
 * The asymmetry that follows is deliberate: a `skip` finalizes immediately, because a skip writes
 * nothing and so has no outcome that can fail.
 */
import { finalizeWrite, wroteSomething } from './finalize';
import type { PendingHumanStore, Resolution } from '../state/pendingHuman';
import type { RoleStateStore } from '../state/roleState';
import type { TrackerAdapter } from '../trackers';
import type { AuditResult } from './passes/audit';
import { type ExecuteResult, executeOperations, planOperations } from './passes/execute';

export type ResumeOutcome =
  | { status: 'executed'; exec: ExecuteResult; audit: AuditResult }
  /** The write did not land. **The hold is still open** and can be retried or skipped. */
  | { status: 'write_failed'; exec: ExecuteResult; reason: string }
  | { status: 'skipped' }
  | { status: 'unknown' }
  | { status: 'not_resumable'; reason: string };

export type ResumeDeps = {
  tracker: TrackerAdapter;
  /** Supply it and approved work reaches role memory exactly as pipeline-written work does. */
  roleState?: RoleStateStore;
  alert?: (detail: string) => void;
};

/** Names which of the three non-applied outcomes happened; they differ in whether a retry helps. */
function whyNotWritten(exec: ExecuteResult): string {
  const parts: string[] = [];
  if (exec.failed) parts.push(`${exec.failed} failed (transient — retrying may work)`);
  if (exec.refused) parts.push(`${exec.refused} refused by the adapter on policy (a retry will refuse again)`);
  if (exec.unsupported) parts.push(`${exec.unsupported} unsupported by this tracker (a retry cannot help)`);
  return parts.join('; ');
}

export async function resumeHold(
  store: PendingHumanStore,
  id: string,
  decision: Resolution,
  deps: ResumeDeps
): Promise<ResumeOutcome> {
  // CLAIM, not resolve. The hold stays in the store until something has actually happened.
  const res = store.claim(id, decision);

  if (res.status === 'unknown') return { status: 'unknown' };
  if (res.status === 'not_resumable') {
    return {
      status: 'not_resumable',
      reason: `hold ${id} (${res.hold.gate}) was recorded without a per-item decision, so approving it would mean inventing the write. Re-run the source once the underlying problem is fixed.`,
    };
  }

  if (decision === 'skip') {
    store.finalize(id);
    return { status: 'skipped' };
  }

  const item = res.hold.originalItem!; // `claim` refuses to approve without it
  const exec = await executeOperations(planOperations([item]), deps.tracker);

  if (!wroteSomething(exec)) {
    // Left open on purpose. A queue entry is cheap; a lost human decision is not.
    return { status: 'write_failed', exec, reason: whyNotWritten(exec) };
  }

  // The same tail the pipeline runs: role memory, then an audit against a FRESH board read.
  // Approved work used to be the only work in the system that was never audited, which is exactly
  // backwards — an item a human had to think about is the one most worth verifying afterwards.
  const audit = await finalizeWrite([item], exec, {
    tracker: deps.tracker,
    ...(deps.roleState ? { roleState: deps.roleState } : {}),
    ...(deps.alert ? { alert: deps.alert } : {}),
  });

  store.finalize(id);
  return { status: 'executed', exec, audit };
}
