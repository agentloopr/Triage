/**
 * Pass 2b — the blind verdict: types, parser, and the legitimacy gate.
 *
 * Pass 2b re-derives the categorization from the Pass-1 inventory item alone, without seeing what 2a
 * concluded. Its output is this small structured verdict, which the gates then compare against 2a's.
 *
 * **Every optional judgement here fails OPEN.** An absent or garbled field parses to the permissive
 * value — `real_task`, `grounded`, `cardStillMatches`, `routingOk` all default to "fine". That is
 * deliberate and worth defending: a flaky verdict must never be able to suppress genuine work or
 * invent a dispute out of nothing. The blind read's job is to *catch* problems, so its failure mode
 * has to be silence, not false alarms.
 */
import { ASR_PROVENANCE_FLOOR, ASR_PROVENANCE_LOW } from '../../config';
import type { MeetingCategory } from './categorizationManifest';

export type Legitimacy = 'real_task' | 'not_a_task' | 'unsure';

export type ContractVerdict = {
  category: MeetingCategory | 'UNKNOWN';
  /** Board ids the blind read matched (DUPLICATE/UPDATE existing, SUBTASK parent, RELATE pair). */
  matchIds: string[];
  rationale: string;
  tier2Cited: boolean;
  /**
   * Independent "does this deserve a card at all" judgement. Defaults to `real_task` on a parse miss.
   */
  legitimacy: Legitimacy;
  /**
   * Does the item's wording actually trace to the source, or was a term bled in from a similar
   * board card? **Detection only** — this never rewrites the item. An LLM "correction" is itself an
   * LLM output that can be wrong, and silently rewording what a human said is worse than flagging
   * it. The only thing a `false` can do is become a card-identity question via `cardStillMatches`.
   */
  grounded: boolean;
  /**
   * Meaningful only when `grounded` is false AND the item matches an existing card: does that card
   * genuinely cover what the source describes? `false` means the ungrounded wording was masking a
   * WRONG match — a legitimate card-identity question, never a "is this word right" question.
   */
  cardStillMatches: boolean;
  /** Is the chosen list confidently right? Routing IS a legitimate thing to ask a human about. */
  routingOk: boolean;
  raw: string;
};

const CATEGORIES = new Set(['NEW_TASK', 'DUPLICATE', 'SUBTASK', 'UPDATE', 'RELATE']);

export function parseContractVerdict(raw: string): ContractVerdict {
  const out: ContractVerdict = {
    category: 'UNKNOWN',
    matchIds: [],
    rationale: '',
    tier2Cited: false,
    legitimacy: 'real_task',
    grounded: true,
    cardStillMatches: true,
    routingOk: true,
    raw: raw.trim(),
  };

  const cat = raw.match(/^\s*VERDICT_CATEGORY:\s*(.+)$/im)?.[1]?.toUpperCase().replace(/[^A-Z_]/g, '');
  if (cat && CATEGORIES.has(cat)) out.category = cat as MeetingCategory;

  const ids = raw.match(/^\s*MATCH_TASK_ID:\s*(.+)$/im)?.[1] ?? '';
  out.matchIds = ids
    .split(/[,\s]+/)
    .map((s) => s.replace(/^#/, '').replace(/[^A-Za-z0-9-]/g, ''))
    .filter((s) => s && !/^(none|na|tbd|unknown)$/i.test(s));

  const worth = raw.match(/^\s*WORTH_A_CARD:\s*([a-z_]+)/im)?.[1]?.toLowerCase();
  if (worth === 'not_a_task' || worth === 'not_task' || worth === 'notatask') out.legitimacy = 'not_a_task';
  else if (worth === 'unsure') out.legitimacy = 'unsure';
  else out.legitimacy = 'real_task';

  // Each of these reads "not explicitly no" — absent, garbled and n/a all mean permissive.
  out.grounded = raw.match(/^\s*GROUNDED:\s*(yes|no)/im)?.[1]?.toLowerCase() !== 'no';
  out.cardStillMatches = raw.match(/^\s*CARD_STILL_MATCHES:\s*(yes|no|n\/a)/im)?.[1]?.toLowerCase() !== 'no';
  out.routingOk = raw.match(/^\s*ROUTING_OK:\s*(yes|no|n\/a)/im)?.[1]?.toLowerCase() !== 'no';

  out.rationale = (raw.match(/^\s*RATIONALE:\s*([\s\S]*?)(?=\n\s*[A-Z_]+:|\n*$)/im)?.[1] ?? '').trim();
  out.tier2Cited = /\b(list-tasks|task-comments)\b|comment history/i.test(out.rationale);

  return out;
}

/**
 * Should this item be held on legitimacy grounds?
 *
 * **Scoped to NEW_TASK only**, which is the recall guarantee that makes the whole gate safe to run:
 * a status change on an existing card can never be suppressed here, no matter what the blind read
 * says. The worst case is a new card that needed a human's yes.
 *
 * Holds when the blind read judged it not-a-task; when it was unsure *and* something else is weak
 * (low categorization confidence, or a poor-quality source); or when the source line is too garbled
 * to create a brand-new card from at all.
 *
 * Returns true → ask a human create-or-skip. Never a silent drop.
 */
export function legitimacyHolds(
  manifestCategory: string,
  verdictLegitimacy: Legitimacy,
  opts: { pass2aConfidence?: 'high' | 'med' | 'low'; provenance?: number | null } = {},
  thresholds: { low: number; floor: number } = { low: ASR_PROVENANCE_LOW, floor: ASR_PROVENANCE_FLOOR }
): boolean {
  if (manifestCategory !== 'NEW_TASK') return false;

  const prov = typeof opts.provenance === 'number' ? opts.provenance : null;

  if (verdictLegitimacy === 'not_a_task') return true;
  if (verdictLegitimacy === 'unsure') {
    if (opts.pass2aConfidence === 'low') return true;
    if (prov !== null && prov <= thresholds.low) return true;
  }
  if (prov !== null && prov <= thresholds.floor) return true;

  return false;
}

/**
 * Whether an item was confidently judged not-a-task and can be auto-skipped rather than held.
 *
 * Deliberately narrower than `legitimacyHolds`: only a *confident* not-a-task with a trustworthy
 * source skips. `unsure`, or anything from a low-quality source, still reaches a human. Nothing is
 * ever silently dropped either way — a skip is reported in the run digest with its reason, so the
 * rare miss can be created by hand.
 */
export function autoSkippable(
  verdict: ContractVerdict,
  opts: { provenance?: number | null } = {},
  floor: number = ASR_PROVENANCE_FLOOR
): boolean {
  if (verdict.legitimacy !== 'not_a_task') return false;
  const prov = typeof opts.provenance === 'number' ? opts.provenance : null;
  return prov === null || prov > floor;
}
