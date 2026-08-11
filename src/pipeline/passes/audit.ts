/**
 * Pass 2d — post-write execution-integrity audit. Deterministic; no model.
 *
 * Runs AFTER the writes, so it can only DETECT, never prevent. It deliberately does **not** judge
 * whether a decision was *correct* — a wrongly-but-plausibly routed card matches the plan and PASSes.
 * Correctness is the pre-write gates' job. This pass answers a narrower and completely different
 * question: **did what we said we did actually happen?**
 *
 * That distinction matters because these are the failures a pre-write gate structurally cannot see:
 *   • a write that reported success but produced no card;
 *   • a partial run that left plan lines unwritten;
 *   • a race — the parent or target card deleted between the snapshot and the write;
 *   • a HELD item that somehow executed anyway;
 *   • a card that landed on the wrong list from a stale mapping.
 *
 * Fail-open by contract: any error here is non-fatal. An audit that crashes the run would convert a
 * reporting problem into an outage.
 */
import type { BoardTask } from '../../trackers';
import type { HeldItem } from '../gates/contractGates';
import type { CategorizationItem } from '../parsing/categorizationManifest';
import type { ExecuteResult } from './execute';

export type AuditVerdict = 'PASS' | 'MISMATCH';

export type AuditLine = {
  item: number;
  category: string;
  title: string;
  verdict: AuditVerdict;
  /** What was checked, or why it did not match. */
  detail: string;
};

export type AuditResult = {
  lines: AuditLine[];
  passed: number;
  mismatched: number;
  /** Non-empty only when something needs attention. */
  report: string;
};

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reconcile the plan and the execution report against a **fresh** board read taken after the writes.
 *
 * The freshness matters: auditing against the pre-write snapshot would just re-read our own
 * assumptions and pass every time.
 */
export function auditPostWrite(
  cleanManifest: CategorizationItem[],
  exec: ExecuteResult,
  freshTasks: BoardTask[],
  held: HeldItem[] = []
): AuditResult {
  const byId = new Map(freshTasks.map((t) => [t.id, t]));
  const findByTitle = (title: string): BoardTask | undefined =>
    freshTasks.find((t) => norm(t.title.replace(/^\[SUBTASK of [^\]]+\]\s*/i, '')) === norm(title));

  const actionByItem = new Map(exec.actions.map((a) => [a.item, a]));
  const lines: AuditLine[] = [];

  for (const m of cleanManifest) {
    const action = actionByItem.get(m.item);
    const line = (verdict: AuditVerdict, detail: string): void => {
      lines.push({ item: m.item, category: m.category, title: m.title, verdict, detail });
    };

    if (!action) {
      line('MISMATCH', 'in the plan but the executor never reported on it — the run was partial');
      continue;
    }

    if (action.outcome === 'failed') {
      line('MISMATCH', `write failed: ${action.detail ?? 'no detail'}`);
      continue;
    }

    switch (m.category) {
      case 'DUPLICATE': {
        // Correct behaviour is that nothing was written. The failure mode is a card appearing anyway.
        const created = findByTitle(m.title);
        if (created && !byId.has(m.existingTaskId ?? '')) {
          line('MISMATCH', `skipped as a duplicate, but a card titled "${m.title}" is now on the board (${created.id})`);
        } else {
          line('PASS', 'skipped as a duplicate; nothing written, as intended');
        }
        break;
      }

      case 'NEW_TASK':
      case 'SUBTASK': {
        const createdId = action.results.find((r) => r.op.kind === 'createTask' && r.outcome.status === 'applied');
        const resultId = createdId?.outcome.status === 'applied' ? createdId.outcome.resultId : undefined;
        const card = (resultId ? byId.get(resultId) : undefined) ?? findByTitle(m.title);

        if (!card) {
          line('MISMATCH', 'reported as created, but no matching card is on the board');
          break;
        }
        if (m.list && norm(card.listKey) !== norm(m.list)) {
          line('MISMATCH', `created on list "${card.listKey}" but the plan said "${m.list}"`);
          break;
        }
        if (m.category === 'SUBTASK' && m.parentTaskId && card.parentId !== m.parentTaskId) {
          line('MISMATCH', `created without the intended parent ${m.parentTaskId}`);
          break;
        }
        line('PASS', `created as ${card.id} on ${card.listKey}`);
        break;
      }

      case 'UPDATE': {
        if (!m.existingTaskId || !byId.has(m.existingTaskId)) {
          // The card vanished between the snapshot and the write — a real race, and invisible upstream.
          line('MISMATCH', `target card ${m.existingTaskId ?? '(none)'} is not on the board — deleted or closed mid-run`);
          break;
        }
        const commented = action.results.some((r) => r.op.kind === 'addComment' && r.outcome.status === 'applied');
        if (!commented) {
          line('MISMATCH', `no comment landed on ${m.existingTaskId}`);
          break;
        }
        const refused = action.results.filter((r) => r.outcome.status === 'refused');
        const unsupported = action.results.filter((r) => r.outcome.status === 'unsupported');
        if (refused.length || unsupported.length) {
          const detail = [...refused, ...unsupported]
            .map((r) => `${r.op.kind}: ${r.outcome.status === 'refused' || r.outcome.status === 'unsupported' ? r.outcome.detail : ''}`)
            .join('; ');
          line('MISMATCH', `commented, but some changes did not apply — ${detail}`);
          break;
        }
        line('PASS', `commented on ${m.existingTaskId}`);
        break;
      }

      case 'RELATE': {
        const linked = action.results.some((r) => r.op.kind === 'linkTasks' && r.outcome.status === 'applied');
        line(linked ? 'PASS' : 'MISMATCH', linked ? 'linked' : 'link did not apply');
        break;
      }

      default:
        line('MISMATCH', `unknown category ${m.category}`);
    }
  }

  // A held item must NOT have been written. If its title is on the board, something bypassed the gate.
  for (const h of held) {
    const card = findByTitle(h.title);
    if (card) {
      lines.push({
        item: h.item,
        category: h.category,
        title: h.title,
        verdict: 'MISMATCH',
        detail: `held for "${h.gate}" but a card titled "${h.title}" is on the board (${card.id}) — it executed anyway`,
      });
    }
  }

  const passed = lines.filter((l) => l.verdict === 'PASS').length;
  const mismatched = lines.length - passed;

  const report = mismatched
    ? [
        `POST_WRITE_AUDIT: ${mismatched} mismatch(es) across ${lines.length} line(s).`,
        ...lines.filter((l) => l.verdict === 'MISMATCH').map((l) => `  [MISMATCH] ITEM ${l.item} "${l.title}" — ${l.detail}`),
      ].join('\n')
    : '';

  return { lines, passed, mismatched, report };
}

/** One line per item, round-trippable against the eval's own regex. */
export function formatAuditResult(result: AuditResult): string {
  return result.lines.map((l) => `[${l.verdict}] ITEM ${l.item} — ${l.detail}`).join('\n');
}
