/**
 * Pass 2c — the only writer.
 *
 * Two halves, split on purpose:
 *   • `planOperations` is **pure** — categorized items in, `TrackerOperation[]` out. No I/O, no
 *     model, no tracker. Everything about *what* should happen is decided here and is trivially
 *     testable.
 *   • `executeOperations` applies the plan through a `TrackerAdapter` and records what happened.
 *
 * The version this was extracted from emitted ClickUp command-line arguments directly from the
 * planner, which meant "what should happen" and "how ClickUp spells it" were the same function.
 * Splitting them is what makes a second tracker possible at all.
 *
 * **No model runs in the write path.** Every judgement was made and gated upstream; by the time
 * anything reaches here it is deterministic.
 */
import { findMemberByName, findRouteByKey } from '../../registry/identity';
import type { OpOutcome, Priority, TrackerAdapter, TrackerOperation } from '../../trackers';
import type { CategorizationItem, MeetingCategory } from '../parsing/categorizationManifest';

/**
 * Titles have a length ceiling on real trackers, and an over-long one fails the write outright —
 * silently dropping the action. Clamp what is displayed and preserve the full text in the body, so
 * nothing is ever lost. Real titles are short; this only fires on a pathological one.
 */
const MAX_TITLE = 256;

export type PlannedAction = {
  item: number;
  category: MeetingCategory | 'UNKNOWN';
  title: string;
  ops: TrackerOperation[];
  /** `planned` — ops to run · `skipped_duplicate` — nothing to do, by design · `failed` — unplannable. */
  outcome: 'planned' | 'skipped_duplicate' | 'failed';
  detail?: string;
};

const PRIORITIES = new Set<Priority>(['urgent', 'high', 'normal', 'low']);
const asPriority = (p: string | undefined): Priority | undefined =>
  p && PRIORITIES.has(p as Priority) ? (p as Priority) : undefined;

export type PlanContext = {
  todayIso?: string;
  /** Recorded on created tasks as who asked for the work. */
  requestedBy?: string;
};

/** Pure. What SHOULD happen for one item — no tracker, no I/O. */
export function planAction(item: CategorizationItem, ctx: PlanContext = {}): PlannedAction {
  const base = { item: item.item, category: item.category, title: item.title, ops: [] as TrackerOperation[] };

  switch (item.category) {
    case 'DUPLICATE':
      // Not a failure — deciding NOT to write is the correct outcome, and it is recorded as such.
      return {
        ...base,
        outcome: 'skipped_duplicate',
        detail: item.existingTaskId ? `duplicate of ${item.existingTaskId}` : 'duplicate',
      };

    case 'RELATE': {
      if (!item.linkTaskId1 || !item.linkTaskId2) {
        return { ...base, outcome: 'failed', detail: 'RELATE is missing a link id' };
      }
      return {
        ...base,
        ops: [{ kind: 'linkTasks', taskIdA: item.linkTaskId1, taskIdB: item.linkTaskId2 }],
        outcome: 'planned',
      };
    }

    case 'UPDATE': {
      if (!item.existingTaskId || !item.finalDesc) {
        return { ...base, outcome: 'failed', detail: 'UPDATE is missing EXISTING_TASK_ID or FINAL_DESC' };
      }
      const taskId = item.existingTaskId;

      // The comment goes first: it is the record of WHY the other changes are happening, and it must
      // survive even if a later field change is refused.
      const ops: TrackerOperation[] = [{ kind: 'addComment', taskId, body: item.finalDesc }];

      // Each field appears only when the source explicitly directed that change; values pass through
      // for the adapter to validate against the tracker's real vocabulary.
      if (item.status) ops.push({ kind: 'setStatus', taskId, status: item.status });
      if (item.dueDate) ops.push({ kind: 'setDueDate', taskId, dueDate: item.dueDate });
      const priority = asPriority(item.priority);
      if (priority) ops.push({ kind: 'setPriority', taskId, priority });

      if (item.assignee) {
        const member = findMemberByName(item.assignee);
        if (!member) {
          return { ...base, ops, outcome: 'failed', detail: `UPDATE reassign: unresolvable assignee "${item.assignee}"` };
        }
        // Replace semantics — a reassignment names the new owner, it does not add one.
        ops.push({ kind: 'setAssignees', taskId, assignees: [member.name] });
      }

      // A LIST on an UPDATE means "move this card". Emitted as an operation even though some trackers
      // cannot do it — the adapter answers `unsupported`, which surfaces to a human instead of the
      // instruction being silently dropped.
      if (item.list) ops.push({ kind: 'moveList', taskId, listKey: item.list });

      return { ...base, ops, outcome: 'planned' };
    }

    case 'NEW_TASK':
    case 'SUBTASK': {
      const route = item.list ? findRouteByKey(item.list) : undefined;
      if (!route) return { ...base, outcome: 'failed', detail: `unresolvable list "${item.list ?? ''}"` };

      const member = item.assignee ? findMemberByName(item.assignee) : undefined;
      if (!member) return { ...base, outcome: 'failed', detail: `unresolvable assignee "${item.assignee ?? ''}"` };

      if (item.category === 'SUBTASK' && !item.parentTaskId) {
        return { ...base, outcome: 'failed', detail: 'SUBTASK is missing PARENT_TASK_ID' };
      }

      let title = item.title;
      let description = item.finalDesc;
      if (title.length > MAX_TITLE) {
        title = `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
        description = description ? `${item.title}\n\n${description}` : item.title;
      }

      const op: TrackerOperation = {
        kind: 'createTask',
        listKey: route.key,
        title,
        assignees: [member.name],
        ...(description ? { description } : {}),
        ...(asPriority(item.priority) ? { priority: asPriority(item.priority)! } : {}),
        // Every created task carries a due date; fall back to the run date rather than creating one
        // without. A missing due date must never fail a create.
        ...(item.dueDate || ctx.todayIso ? { dueDate: item.dueDate || ctx.todayIso! } : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(item.category === 'SUBTASK' && item.parentTaskId ? { parentId: item.parentTaskId } : {}),
        ...(ctx.requestedBy ? { requestedBy: ctx.requestedBy } : {}),
      };

      return { ...base, ops: [op], outcome: 'planned' };
    }

    default:
      return { ...base, outcome: 'failed', detail: `unknown category ${item.category}` };
  }
}

/** Pure. The whole plan, in order — used by the dry run and by the executor alike. */
export function planOperations(items: CategorizationItem[], ctx: PlanContext = {}): PlannedAction[] {
  return items.map((it) => planAction(it, ctx));
}

export type ExecutedOp = { op: TrackerOperation; outcome: OpOutcome };

export type ExecutedAction = PlannedAction & {
  results: ExecutedOp[];
  /** True when every operation applied or was already in the desired state. */
  ok: boolean;
};

export type ExecuteResult = {
  actions: ExecutedAction[];
  created: number;
  commented: number;
  skipped: number;
  refused: number;
  failed: number;
  unsupported: number;
};

/**
 * Apply a plan. Operations run **in order within an item**, and one item's failure never stops the
 * rest — a bad card should cost that card, not the whole run.
 */
export async function executeOperations(
  plan: PlannedAction[],
  tracker: TrackerAdapter
): Promise<ExecuteResult> {
  const actions: ExecutedAction[] = [];
  const tally = { created: 0, commented: 0, skipped: 0, refused: 0, failed: 0, unsupported: 0 };

  for (const action of plan) {
    if (action.outcome !== 'planned') {
      if (action.outcome === 'skipped_duplicate') tally.skipped++;
      else tally.failed++;
      actions.push({ ...action, results: [], ok: action.outcome === 'skipped_duplicate' });
      continue;
    }

    const results: ExecutedOp[] = [];
    for (const op of action.ops) {
      let outcome: OpOutcome;
      try {
        outcome = await tracker.apply(op);
      } catch (err) {
        outcome = { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
      results.push({ op, outcome });

      switch (outcome.status) {
        case 'applied':
          if (op.kind === 'createTask') tally.created++;
          if (op.kind === 'addComment') tally.commented++;
          break;
        case 'refused':
          tally.refused++;
          break;
        case 'unsupported':
          tally.unsupported++;
          break;
        case 'failed':
          tally.failed++;
          break;
        case 'unchanged':
          break;
      }
    }

    actions.push({
      ...action,
      results,
      ok: results.every((r) => r.outcome.status === 'applied' || r.outcome.status === 'unchanged'),
    });
  }

  return { actions, ...tally };
}
