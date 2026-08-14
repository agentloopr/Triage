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
import { classifyWrite, describeNotApplied, finalizeWrite } from './finalize';
import type { PendingHumanStore, Resolution } from '../state/pendingHuman';
import type { RoleStateStore } from '../state/roleState';
import type { TrackerAdapter } from '../trackers';
import type { AuditResult } from './passes/audit';
import { type ExecuteResult, executeOperations, planOperations } from './passes/execute';

export type ResumeOutcome =
  /** Everything applied. The hold is closed. `audit` is absent if the post-write read itself failed. */
  | { status: 'executed'; exec: ExecuteResult; audit?: AuditResult; auditError?: string; staleClaim?: string }
  /**
   * Some operations applied and some did not — an UPDATE whose comment landed and whose `moveList`
   * came back `unsupported`, say. **The hold is closed**, because a retry would re-apply the ones
   * that worked; the board changed, and the remainder is a human's problem, not a machine's.
   */
  | { status: 'partially_written'; exec: ExecuteResult; reason: string; audit?: AuditResult; auditError?: string; staleClaim?: string }
  /** Nothing reached the board. **The hold is still open** and can be retried or skipped. */
  | { status: 'write_failed'; exec: ExecuteResult; reason: string }
  /** Another approval of this hold is in flight. Nothing was written here. */
  | { status: 'in_progress'; since: string }
  | { status: 'skipped' }
  | { status: 'unknown' }
  | { status: 'not_resumable'; reason: string };

export type ResumeDeps = {
  tracker: TrackerAdapter;
  /** Supply it and approved work reaches role memory exactly as pipeline-written work does. */
  roleState?: RoleStateStore;
  alert?: (detail: string) => void;
};

export async function resumeHold(
  store: PendingHumanStore,
  id: string,
  decision: Resolution,
  deps: ResumeDeps
): Promise<ResumeOutcome> {
  // CLAIM, not resolve. The hold stays in the store until something has actually happened.
  const res = store.claim(id, decision);

  if (res.status === 'unknown') return { status: 'unknown' };
  if (res.status === 'in_progress') return { status: 'in_progress', since: res.since };
  if (res.status === 'not_resumable') {
    return {
      status: 'not_resumable',
      reason: `hold ${id} (${res.hold.gate}) was recorded without a per-item decision, so approving it would mean inventing the write. Re-run the source once the underlying problem is fixed.`,
    };
  }

  if (decision === 'skip') {
    if (!store.finalize(id, res.claimToken)) {
      // The claim expired and someone else took the hold. Nothing was written here, so the honest
      // answer is that this skip did not take effect — not a cheerful "skipped".
      return { status: 'in_progress', since: 'the claim was taken over before this skip completed' };
    }
    return { status: 'skipped' };
  }

  const item = res.hold.originalItem!; // `claim` refuses to approve without it

  let exec: ExecuteResult;
  try {
    exec = await executeOperations(planOperations([item]), deps.tracker);
  } catch (err) {
    // Nothing is known to have landed, so hand the claim back rather than leaving the hold locked
    // until the TTL expires.
    store.release(id, res.claimToken);
    throw err;
  }

  const landed = classifyWrite(exec);

  if (landed === 'none') {
    // Left open on purpose, and the claim released so a retry can take it. A queue entry is cheap;
    // a lost human decision is not.
    store.release(id, res.claimToken);
    return { status: 'write_failed', exec, reason: describeNotApplied(exec) };
  }

  // ── THE BOARD HAS CHANGED. The decision is spent, so close the hold BEFORE anything else. ──
  //
  // The audit used to run first, and it re-reads the tracker. When that read threw, the exception
  // propagated past `finalize` — leaving a written card AND an open hold, so the next retry wrote a
  // second card. A post-hoc check must never be able to undo the record of what already happened.
  //
  // A `false` here means our claim expired and another process took the hold while this write was in
  // flight — so the board has changed and someone else may be about to change it again. Ignoring the
  // return value made that silent, which is the worst way to learn about a duplicate write.
  const closed = store.finalize(id, res.claimToken);
  const staleClaim = closed
    ? undefined
    : `the claim on ${id} expired mid-write and was taken over; this write landed, but another ` +
      `approval may also be running. Check the board for a duplicate.`;
  if (staleClaim) deps.alert?.(staleClaim);

  // The same tail the pipeline runs: role memory, then an audit against a FRESH board read.
  // Approved work used to be the only work in the system that was never audited, which is exactly
  // backwards — an item a human had to think about is the one most worth verifying afterwards.
  //
  // **`partial` runs this too.** The first version returned early for a partial write, so an item
  // whose comment landed and whose `moveList` was refused updated neither role memory nor the audit —
  // the board had changed and the two records of what the board looks like had not. Whether a write
  // was complete is a different question from whether it happened.
  //
  // Fail-open, because the write is already done: an audit that cannot read the board is a missing
  // check, not a reason to pretend the card is not there.
  let audit: AuditResult | undefined;
  let auditError: string | undefined;
  try {
    audit = await finalizeWrite([item], exec, {
      tracker: deps.tracker,
      ...(deps.roleState ? { roleState: deps.roleState } : {}),
      ...(deps.alert ? { alert: deps.alert } : {}),
    });
  } catch (err) {
    auditError = err instanceof Error ? err.message : String(err);
    deps.alert?.(`the write landed but the post-write audit could not read the board: ${auditError}`);
  }

  if (landed === 'partial') {
    // Deliberately NOT retryable: some operations are already on the board and re-running would
    // duplicate them. A human gets told exactly what is left.
    return {
      status: 'partially_written',
      exec,
      reason: describeNotApplied(exec),
      ...(audit ? { audit } : {}),
      ...(auditError ? { auditError } : {}),
      ...(staleClaim ? { staleClaim } : {}),
    };
  }

  return {
    status: 'executed',
    exec,
    ...(audit ? { audit } : {}),
    ...(auditError ? { auditError } : {}),
    ...(staleClaim ? { staleClaim } : {}),
  };
}
