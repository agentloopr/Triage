/**
 * A governed write boundary — the adapter wrapper that lets the **board agent** write.
 *
 * This is the second of two adapter wrappers, and the pair is the whole write-authority design:
 *
 *   `readOnlyTracker`   refuses every write. What role agents get, always.
 *   `governedTracker`   allows a write **that the deterministic gates accept**. What the board agent
 *                       gets, and only when `BOARD_AGENT_WRITES` is on.
 *
 * **Why a wrapper and not prompt text.** Same reason as `readOnlyTracker`: a prompt is a request and
 * a wrapper is a guarantee. A model that has been jailbroken, confused, or fed a malicious transcript
 * cannot argue its way past this, because the argument never reaches the tracker — `applyGates` does.
 *
 * ## What this does and does not guarantee
 *
 * With `BOARD_AGENT_WRITES` off, this file is not in the process and the repo's claim is literal: no
 * model is in the write path, because no write tool exists for one to reach.
 *
 * With it on, the claim narrows, and it is worth stating the narrowed version exactly rather than
 * restating the old one:
 *
 *   > A successful injection cannot author a write **the deterministic gates would not already have
 *   > approved.**
 *
 * That is smaller than "cannot author a write". It is not nothing: every gate the pipeline's own
 * answer faced — routing, roster, evidence, duplicate, critical — runs again here, over an item
 * rebuilt from the operation the model actually asked for rather than from anything it claimed.
 *
 * ## Two paths through `apply`
 *
 * **An op that matches the approved plan exactly applies as planned.** It was gated moments ago;
 * re-gating it would be theatre, and worse, would fail — `tier2Cited` and the resolved fields live on
 * the manifest item, not on the operation, so a naive rebuild loses them and the write the pipeline
 * approved gets refused by its own gates. Matching is on the whole serialised op, so a title that
 * matches with a body that does not is a novel op, not an approved one.
 *
 * **Anything else is rebuilt into a `CategorizationItem` and re-gated.** That covers the case this
 * mode exists for: the agent looked at the board, decided the plan was wrong, and wants to comment on
 * an existing card instead of creating a second one.
 *
 * ## Evidence, and why this is stricter than the pipeline
 *
 * The evidence gate holds a DUPLICATE or SUBTASK whose rationale does not cite comment history —
 * "same work" and containment are the two claims that history actually proves. (An UPDATE is gated on
 * card *identity* instead, deliberately; see the note in `contractGates.ts`.)
 *
 * On the pipeline path that citation is the model's own claim, checked by parsing its prose. Here it
 * is a fact: `readComments` reports whether this agent actually called `get_task_comments` on that
 * card during this run. A model that says it checked but did not gets held, which makes this strictly
 * stricter than the pipeline's own version of the same gate.
 */
import type { BoardTask, OpOutcome, TrackerAdapter, TrackerOperation } from '../../trackers';
import type { CategorizationItem } from '../parsing/categorizationManifest';
import { type DeterministicGateOptions, applyGates } from '../passes/contractCheck';
import type { HeldItem } from './contractGates';

export interface GovernedTrackerContext {
  /**
   * The operations the pipeline already gated and approved, serialised. An op in this set applies
   * without re-gating; see the header for why re-gating an approved op is both pointless and wrong.
   */
  approvedOps: ReadonlySet<string>;
  /** The board as the run read it, for the gates that compare against existing cards. */
  snapshot: Map<string, BoardTask>;
  gateOpts?: DeterministicGateOptions;
  /** Did the agent actually fetch this card's comments this run? Becomes `tier2Cited`. */
  readComments?: (taskId: string) => boolean;
  /** Called for every write the gates refuse, so it reaches the same place any other hold does. */
  onHold?: (held: HeldItem, op: TrackerOperation) => void;
}

/**
 * Serialise an operation to a stable string.
 *
 * Key-sorted rather than `JSON.stringify(op)` directly: object key order is insertion order in V8, so
 * the same logical op built by two different code paths would otherwise produce two different
 * signatures and an approved write would be treated as novel.
 */
export function opSignature(op: TrackerOperation): string {
  return JSON.stringify(op, Object.keys(op).sort());
}

/** Build the approved-op set from a plan's operations. */
export function approvedOpSet(ops: readonly TrackerOperation[]): Set<string> {
  return new Set(ops.map(opSignature));
}

/**
 * Rebuild the manifest item an operation implies, so the gates can judge it.
 *
 * Returns `null` for an operation shape this layer cannot express as an item. That is a refusal, not
 * a pass — an op nothing can gate must not reach the tracker just because it is unfamiliar.
 */
function itemForOp(
  op: TrackerOperation,
  n: number,
  ctx: GovernedTrackerContext
): CategorizationItem | null {
  const cited = (taskId: string): boolean => ctx.readComments?.(taskId) ?? false;
  const base = { item: n, confidence: 'med' as const, raw: `agent-originated ${op.kind}` };

  switch (op.kind) {
    case 'createTask':
      return {
        ...base,
        title: op.title,
        category: 'NEW_TASK',
        ...(op.listKey ? { list: op.listKey } : {}),
        ...(op.assignees[0] ? { assignee: op.assignees[0] } : {}),
        ...(op.description ? { finalDesc: op.description } : {}),
        ...(op.dueDate ? { dueDate: op.dueDate } : {}),
        ...(op.status ? { status: op.status } : {}),
        ...(op.parentId ? { category: 'SUBTASK' as const, parentTaskId: op.parentId } : {}),
        // A plain create cites nothing by construction — there is no prior card to have read. A
        // subtask create does have one, and the evidence gate asks for exactly that card's history,
        // so it cites the parent it actually opened. Hardcoding `false` here made every agent-
        // originated subtask unwritable, which would have read as "the gate is strict" rather than
        // as the bug it was.
        tier2Cited: op.parentId ? cited(op.parentId) : false,
      };

    case 'addComment':
      return {
        ...base,
        title: ctx.snapshot.get(op.taskId)?.title ?? op.taskId,
        category: 'UPDATE',
        existingTaskId: op.taskId,
        finalDesc: op.body,
        tier2Cited: cited(op.taskId),
      };

    case 'setStatus':
      return {
        ...base,
        title: ctx.snapshot.get(op.taskId)?.title ?? op.taskId,
        category: 'UPDATE',
        existingTaskId: op.taskId,
        status: op.status,
        tier2Cited: cited(op.taskId),
      };

    case 'setAssignees':
      return {
        ...base,
        title: ctx.snapshot.get(op.taskId)?.title ?? op.taskId,
        category: 'UPDATE',
        existingTaskId: op.taskId,
        ...(op.assignees[0] ? { assignee: op.assignees[0] } : {}),
        tier2Cited: cited(op.taskId),
      };

    default:
      return null;
  }
}

/**
 * Wrap an adapter so it accepts a write only when the deterministic gates do.
 *
 * `refused` rather than `failed`, matching `readOnlyTracker` and everything else in this repo: the
 * operation is well-formed and the tracker could perform it. This layer declined, and a retry will
 * decline identically.
 */
export function governedTracker(inner: TrackerAdapter, ctx: GovernedTrackerContext): TrackerAdapter {
  // Agent-originated items are numbered below zero so a held one is instantly distinguishable from a
  // held inventory item in a trace, and can never collide with a real inventory line number.
  let originated = 0;

  return {
    name: `${inner.name}:governed`,
    capabilities: inner.capabilities,
    getTask: (id) => inner.getTask(id),
    getComments: (id, limit) => inner.getComments(id, limit),
    listTasks: (opts) => inner.listTasks(opts),
    renderSnapshot: (tasks) => inner.renderSnapshot(tasks),

    async apply(op): Promise<OpOutcome> {
      if (ctx.approvedOps.has(opSignature(op))) return inner.apply(op);

      const item = itemForOp(op, --originated, ctx);
      if (!item) {
        return {
          status: 'refused',
          detail:
            `governed: "${op.kind}" has no manifest form, so no gate can judge it — refusing rather ` +
            `than writing something unchecked`,
        };
      }

      const { held } = applyGates([item], ctx.snapshot, ctx.gateOpts ?? {});
      const stop = held[0];
      if (stop) {
        ctx.onHold?.(stop, op);
        return {
          status: 'refused',
          detail: `governed: ${stop.gate} — ${stop.question}`,
        };
      }

      return inner.apply(op);
    },
  };
}
