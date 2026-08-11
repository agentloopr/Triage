/**
 * The resume path: a human answers a held question, and the item finishes.
 *
 * The whole point is that **no model runs here.** The categorization was made once, gated once, and
 * stored; resolving replays that stored decision through the same `planOperations` → `executeOperations`
 * chain the clean items went through. A second inference on resume would mean the human approved one
 * thing and something else got written — and the divergence would be invisible, because both outputs
 * look like the model's work.
 */
import type { PendingHumanStore, Resolution } from '../state/pendingHuman';
import type { TrackerAdapter } from '../trackers';
import { type ExecuteResult, executeOperations, planOperations } from './passes/execute';

export type ResumeOutcome =
  | { status: 'executed'; exec: ExecuteResult }
  | { status: 'skipped' }
  | { status: 'unknown' }
  | { status: 'not_resumable'; reason: string };

export async function resumeHold(
  store: PendingHumanStore,
  id: string,
  decision: Resolution,
  deps: { tracker: TrackerAdapter }
): Promise<ResumeOutcome> {
  const res = store.resolve(id, decision);

  if (res.status === 'unknown') return { status: 'unknown' };
  if (res.status === 'not_resumable') {
    return {
      status: 'not_resumable',
      reason: `hold ${id} (${res.hold.gate}) was recorded without a per-item decision, so approving it would mean inventing the write. Re-run the source once the underlying problem is fixed.`,
    };
  }
  if (decision === 'skip') return { status: 'skipped' };

  const item = res.hold.originalItem!; // `resolve` refuses to approve without it
  return { status: 'executed', exec: await executeOperations(planOperations([item]), deps.tracker) };
}
