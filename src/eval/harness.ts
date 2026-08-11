/**
 * The evaluation harness.
 *
 * **This file's most important property is that it fails loudly.** The version it was extracted from
 * returned an empty array on three separate paths — unreadable file, missing step, blocks that
 * matched no items — and a null parse was silently skipped. So a prompt edit that changed the
 * manifest's shape produced an eval reporting *zero events and no error*, which at a glance is
 * indistinguishable from a clean run. Months of "the eval is green" meant nothing.
 *
 * Strict is therefore the DEFAULT, not a flag. `--lenient` is the opt-in for exploring messy real
 * traces. There is deliberately no `--strict` flag: it once existed as a silent no-op, so every
 * habit and document that passed it was claiming a guarantee that was never delivered.
 *
 * Scoring is **objective code-checks first**. A judge model can be layered on, but a code result
 * always wins the merge — an opinion never overrides something that can be checked.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CategorizationItem } from '../pipeline/parsing/categorizationManifest';
import type { PipelineResult } from '../pipeline/run';
import { type DimResult, type EvalDimension, SIX_DIMENSIONS } from './dimensions';

export class TraceParseError extends Error {
  constructor(
    readonly file: string,
    reason: string
  ) {
    super(`${file}: ${reason}`);
    this.name = 'TraceParseError';
  }
}

/** One decision, with everything needed to judge it. */
export type EvalEvent = {
  runId: string;
  item: number;
  title: string;
  category: string;
  list?: string;
  assignee?: string;
  status?: string;
  finalDesc?: string;
  /** What actually happened to it. */
  disposition: 'created' | 'commented' | 'skipped_duplicate' | 'held' | 'skipped_not_task' | 'failed' | 'unknown';
  /** The gate that held it, when it was held. */
  gate?: string;
  rationale?: string;
  tier2Cited: boolean;
  uncertainFieldCount: number;
};

export type LoadOptions = {
  /** Default TRUE. Throw rather than returning an empty array. */
  strict?: boolean;
};

/** A run, as written to disk for later evaluation. */
export type RunTrace = {
  runId: string;
  sourceId: string;
  recordedAt: string;
  events: EvalEvent[];
};

// ── Building events ──────────────────────────────────────────────────────────

const dispositionOf = (item: CategorizationItem, result: PipelineResult): EvalEvent['disposition'] => {
  if (result.held.some((h) => h.item === item.item)) return 'held';
  if (result.skippedNotTask.some((s) => s.item === item.item)) return 'skipped_not_task';

  const action = result.exec?.actions.find((a) => a.item === item.item);
  if (!action) return result.clean.some((c) => c.item === item.item) ? 'unknown' : 'failed';
  if (action.outcome === 'skipped_duplicate') return 'skipped_duplicate';
  if (action.outcome === 'failed') return 'failed';
  if (action.results.some((r) => r.op.kind === 'createTask' && r.outcome.status === 'applied')) return 'created';
  if (action.results.some((r) => r.op.kind === 'addComment' && r.outcome.status === 'applied')) return 'commented';
  return 'unknown';
};

export function eventsFromResult(result: PipelineResult, runId: string): EvalEvent[] {
  return result.manifest.map((item) => ({
    runId,
    item: item.item,
    title: item.title,
    category: item.category,
    ...(item.list ? { list: item.list } : {}),
    ...(item.assignee ? { assignee: item.assignee } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(item.finalDesc ? { finalDesc: item.finalDesc } : {}),
    disposition: dispositionOf(item, result),
    ...(result.held.find((h) => h.item === item.item)?.gate ? { gate: result.held.find((h) => h.item === item.item)!.gate } : {}),
    ...(item.rationale ? { rationale: item.rationale } : {}),
    tier2Cited: item.tier2Cited,
    uncertainFieldCount: item.uncertainFields?.length ?? 0,
  }));
}

// ── Loading traces ───────────────────────────────────────────────────────────

export function loadEventsFromTrace(file: string, opts: LoadOptions = {}): EvalEvent[] {
  const strict = opts.strict !== false;

  const fail = (reason: string): EvalEvent[] => {
    if (strict) throw new TraceParseError(file, reason);
    console.warn(`[eval] ${file}: ${reason}`);
    return [];
  };

  if (!existsSync(file)) return fail('trace file does not exist');

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return fail(`unreadable (${(err as Error).message.slice(0, 80)})`);
  }
  if (!raw.trim()) return fail('trace file is empty');

  let trace: RunTrace;
  try {
    trace = JSON.parse(raw) as RunTrace;
  } catch (err) {
    return fail(`not valid JSON (${(err as Error).message.slice(0, 80)})`);
  }

  if (!Array.isArray(trace.events)) return fail('trace has no events[] array');
  // A run that decided nothing is a legitimate outcome, but it must be stated rather than inferred
  // from an empty result — that is the exact ambiguity this harness exists to remove.
  if (trace.events.length === 0) return fail('trace contains zero events — was this run empty, or did parsing fail?');

  return trace.events;
}

export function loadEventsFromDir(dir: string, opts: LoadOptions = {}): EvalEvent[] {
  const strict = opts.strict !== false;

  if (!existsSync(dir)) {
    if (strict) throw new TraceParseError(dir, 'trace directory does not exist');
    return [];
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    if (strict) throw new TraceParseError(dir, 'no trace files found');
    return [];
  }
  return files.flatMap((f) => loadEventsFromTrace(join(dir, f), opts));
}

// ── Objective checks ─────────────────────────────────────────────────────────

/**
 * Checks that need no judgement at all. These are the backbone: reproducible, free, and impossible
 * to argue with. Anything a code check can answer is never sent to a model.
 */
export function codeChecks(e: EvalEvent): DimResult[] {
  const out: DimResult[] = [];
  const add = (dimension: EvalDimension, score: DimResult['score'], why: string): void => {
    out.push({ dimension, score, why, source: 'code' });
  };

  const createsWork = e.category === 'NEW_TASK' || e.category === 'SUBTASK';

  // creation — did work that should exist end up existing?
  if (createsWork) {
    if (e.disposition === 'created') add('creation', 'pass', 'created');
    else if (e.disposition === 'held') add('creation', 'partial', `held for a human (${e.gate ?? 'unknown gate'})`);
    else if (e.disposition === 'failed') add('creation', 'fail', 'the write failed');
  }

  // routing — an item that creates work needs both a list and an owner.
  if (createsWork && e.disposition !== 'held') {
    if (e.list && e.assignee) add('routing', 'pass', `${e.list} / ${e.assignee}`);
    else add('routing', 'fail', `missing ${!e.list ? 'list' : 'assignee'}`);
  }

  // status — only meaningful when a status change was actually directed.
  if (e.category === 'UPDATE') {
    if (e.status) add('status', e.disposition === 'commented' ? 'pass' : 'fail', `status "${e.status}" ${e.disposition}`);
  }

  // comment — an update's whole value is the detail it carries.
  if (e.category === 'UPDATE') {
    if (!e.finalDesc) add('comment', 'fail', 'no comment body');
    else if (e.finalDesc.length < 40) add('comment', 'partial', `body is only ${e.finalDesc.length} chars`);
    else add('comment', 'pass', `${e.finalDesc.length} chars`);
  }

  // false_alarms — an existing-card decision without cited evidence is exactly how a wrong nudge
  // reaches someone, which is what makes people stop reading the output.
  if (e.category === 'DUPLICATE' || e.category === 'UPDATE' || e.category === 'SUBTASK') {
    add('false_alarms', e.tier2Cited ? 'pass' : 'fail', e.tier2Cited ? 'evidence cited' : 'no evidence cited');
  }

  // miss_rate is deliberately absent. A dropped item leaves no event, so it cannot be scored from
  // the events — only against a labelled corpus. Claiming otherwise would be scoring a blind spot.

  return out;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export type DimAggregate = { pass: number; partial: number; fail: number; n: number; score: number | null };

export type EventEval = { event: EvalEvent; results: DimResult[] };

/** Code always wins: an objective check is never overridden by an opinion. */
export function mergeResults(code: DimResult[], judge: DimResult[]): DimResult[] {
  const byDim = new Map<EvalDimension, DimResult>();
  for (const j of judge) byDim.set(j.dimension, j);
  for (const c of code) byDim.set(c.dimension, c);
  return [...byDim.values()];
}

export function aggregate(evals: EventEval[]): Record<EvalDimension, DimAggregate> {
  const out = {} as Record<EvalDimension, DimAggregate>;

  for (const { key } of SIX_DIMENSIONS) {
    const scored = evals.flatMap((e) => e.results.filter((r) => r.dimension === key && r.score !== 'n/a'));
    const pass = scored.filter((r) => r.score === 'pass').length;
    const partial = scored.filter((r) => r.score === 'partial').length;
    const fail = scored.filter((r) => r.score === 'fail').length;
    const n = scored.length;
    out[key] = { pass, partial, fail, n, score: n === 0 ? null : (pass + partial * 0.5) / n };
  }
  return out;
}

export function evaluate(events: EvalEvent[]): { evals: EventEval[]; dimensions: Record<EvalDimension, DimAggregate> } {
  const evals = events.map((event) => ({ event, results: codeChecks(event) }));
  return { evals, dimensions: aggregate(evals) };
}

/** Human-readable report. Always states how many events were parsed — even a lenient run looks wrong. */
export function formatReport(events: EvalEvent[], dimensions: Record<EvalDimension, DimAggregate>): string {
  const lines = [`parsed ${events.length} event(s)`, ''];

  for (const { key, name } of SIX_DIMENSIONS) {
    const d = dimensions[key];
    lines.push(
      d.n === 0
        ? `  ${name.padEnd(20)} —      (not scored: no applicable events)`
        : `  ${name.padEnd(20)} ${(d.score! * 100).toFixed(0).padStart(3)}%  (${d.pass} pass · ${d.partial} partial · ${d.fail} fail of ${d.n})`
    );
  }

  lines.push('', 'miss_rate is never scored from events alone — a dropped item leaves no event to score.');
  return lines.join('\n');
}
