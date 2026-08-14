/**
 * What happens after a write, wherever the write came from.
 *
 * There are two paths to the tracker in this repo: the pipeline's own Pass 2c, and a human
 * approving a held item through `npm run answer`. They used to do different things afterwards —
 * the pipeline recorded role state and ran the Pass 2d audit, and the resume path did neither.
 *
 * That difference was invisible while the resume path was unreachable. Wiring `pull.ts` made it
 * real, and made it the wrong shape: **approved work was the only work in the system that was never
 * audited**, which inverts the point. An item a human had to think about is the one you most want
 * verified against the board afterwards.
 *
 * So both paths call this. If the two ever need to differ, the difference has to be written down
 * here rather than arise from one caller forgetting.
 */

import { type RoleArchetype, getMembers } from '../registry/opsRegistry';
import type { RoleOpenItem, RoleStateStore } from '../state/roleState';
import type { BoardTask, TrackerAdapter } from '../trackers';
import { type AuditResult, auditPostWrite } from './passes/audit';
import type { ExecuteResult } from './passes/execute';
import type { HeldItem } from './gates/contractGates';
import type { CategorizationItem } from './parsing/categorizationManifest';

/**
 * Per-role memory, written from what actually landed rather than from what was planned — a plan that
 * failed at the tracker must not leave the next run believing the work is underway.
 *
 * `written` must be the FINAL item list, after any agent re-gate. Passing the pre-agent list records
 * the owner an accepted assignee proposal replaced, which is a wrong memory stated confidently in
 * every later prompt.
 *
 * Entirely fail-open. This is a memo written after the writes have already succeeded; losing it costs
 * the next run some context and must never turn a successful run into a failed one.
 */
export function recordExecutedWorkByRole(
  store: RoleStateStore,
  written: CategorizationItem[],
  exec: ExecuteResult,
  alert: (detail: string) => void
): void {
  try {
    const roleOf = new Map(getMembers().map((m) => [m.name.toLowerCase(), m.role]));
    const at = new Date().toISOString();
    const byRole = new Map<RoleArchetype, RoleOpenItem[]>();

    for (const action of exec.actions) {
      if (!action.ok || action.outcome !== 'planned') continue;

      const item = written.find((c) => c.item === action.item);
      const owner = item?.assignee ?? item?.notifyAssignee;
      const role = owner ? roleOf.get(owner.toLowerCase()) : undefined;
      if (!role) continue;

      const created = action.results.find((r) => r.op.kind === 'createTask' && r.outcome.status === 'applied');
      const taskId =
        (created?.outcome.status === 'applied' ? created.outcome.resultId : undefined) ??
        item?.existingTaskId ??
        item?.parentTaskId;

      const bucket = byRole.get(role) ?? [];
      bucket.push({ ...(taskId ? { taskId } : {}), title: action.title, at });
      byRole.set(role, bucket);
    }

    for (const [role, items] of byRole) store.record(role, items);
  } catch (err) {
    alert(`could not update role state: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * How much of a write actually landed — three states, not a boolean.
 *
 * `failed` alone is not the question, and reading it as if it were is how a protected-status refusal
 * got reported as a successful approval. Three op outcomes leave the board unchanged:
 *
 *   failed      — it broke, and may work on a retry
 *   refused     — the adapter declined on policy (a protected status); a retry declines again
 *   unsupported — the tracker cannot express this operation at all
 *
 * But an item can plan SEVERAL operations. An UPDATE emits a comment first and then any of
 * setStatus, setDueDate, setPriority, setAssignees, moveList — and `moveList` is `unsupported` on
 * ClickUp by design. So the common case is not all-or-nothing: the comment applies and the move does
 * not. Treating that as "nothing happened" and leaving the item retryable means the next retry adds
 * the comment a second time.
 *
 *   'none'    — nothing reached the board. Safe to retry.
 *   'partial' — some operations applied and some did not. **A retry would duplicate the applied ones.**
 *   'full'    — everything applied, or was already in the desired state.
 */
export type WriteOutcome = 'none' | 'partial' | 'full';

export function classifyWrite(exec: ExecuteResult): WriteOutcome {
  const ops = exec.actions.flatMap((a) => a.results);
  // An action that never reached the tracker (`outcome !== 'planned'`) contributes no ops but is
  // still a failure — count it so an unplannable item is not mistaken for a clean run.
  const unplanned = exec.actions.filter((a) => a.outcome !== 'planned' && a.outcome !== 'skipped_duplicate').length;

  const applied = ops.filter((o) => o.outcome.status === 'applied' || o.outcome.status === 'unchanged').length;
  const notApplied = ops.length - applied + unplanned;

  // **A DUPLICATE is a complete outcome with zero operations.** `planOperations` returns
  // `skipped_duplicate` for it — "deciding NOT to write is the correct outcome, and it is recorded
  // as such", in that file's own words. Counting applied operations alone read that as `none`, so
  // approving a held DUPLICATE answered `write_failed` and left the hold open forever, with `--skip`
  // the only escape — and skip means "drop this", not "yes, it really is a duplicate".
  if (applied === 0 && notApplied === 0 && exec.actions.length > 0) return 'full';

  if (applied === 0) return 'none';
  return notApplied === 0 ? 'full' : 'partial';
}

/** Which operations did not land, and whether retrying could help. */
export function describeNotApplied(exec: ExecuteResult): string {
  const parts: string[] = [];
  if (exec.failed) parts.push(`${exec.failed} failed (transient — a retry may work)`);
  if (exec.refused) parts.push(`${exec.refused} refused by the adapter on policy (a retry refuses again)`);
  if (exec.unsupported) parts.push(`${exec.unsupported} unsupported by this tracker (a retry cannot help)`);
  return parts.join('; ') || 'no operation applied';
}

export type FinalizeDeps = {
  tracker: TrackerAdapter;
  roleState?: RoleStateStore;
  alert?: (detail: string) => void;
};

/**
 * The shared tail of a write: record role memory, then audit against a FRESH board read.
 *
 * Re-reads rather than reusing any earlier snapshot — auditing against the pre-write board would
 * just re-read our own assumptions and pass every time.
 */
export async function finalizeWrite(
  written: CategorizationItem[],
  exec: ExecuteResult,
  deps: FinalizeDeps,
  held: HeldItem[] = []
): Promise<AuditResult> {
  const alert = deps.alert ?? (() => {});
  if (deps.roleState) recordExecutedWorkByRole(deps.roleState, written, exec, alert);

  const fresh: BoardTask[] = await deps.tracker.listTasks({ includeClosed: true });
  return auditPostWrite(written, exec, fresh, held);
}
