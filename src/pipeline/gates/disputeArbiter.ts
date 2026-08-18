/**
 * Dispute arbiter — resolves a 2a-vs-blind-read WRITE dispute (see `writeDispute` in
 * `contractGates.ts`) against LIVE tracker state, instead of unconditionally trusting 2a or
 * unconditionally holding for a human.
 *
 * **Off by default** (`DISPUTE_ARBITER_ENABLED`). Detection-only — every dispute holds — is the
 * literal PRD §6 policy and needs no model call; this module exists so a deployment that wants the
 * production behaviour can opt in without writing it.
 *
 * Two steps, only the second of which touches a model:
 *   1. Mechanical — does each cited card still exist? A card that's gone settles the dispute for
 *      free, no LLM involved. (Unlike production, `BoardTask` carries no `archived` field, so this
 *      step resolves on card-missing only.)
 *   2. Model — only for what step 1 couldn't resolve. Given the original source item, both reads,
 *      and each card's live state + comments, the model may resolve the dispute ONLY at high
 *      confidence with a cited live-board fact. Anything less — medium/low confidence, no evidence, a
 *      parse failure, a timeout — holds for a human. Fail-closed throughout: unlike
 *      `parseContractVerdict`'s fail-open defaults (a flaky verdict must never suppress a real task),
 *      here a flaky verdict must never resolve a dispute.
 *
 * Resolving toward an outcome that WRITES NOTHING (`DUPLICATE`) is held to a higher bar than
 * resolving toward a write — evidence must specifically be a comment or the card body that already
 * covers the work. A wrong resolve-to-write is a visible, correctable mistake (a redundant comment);
 * a wrong resolve-to-nothing is a silent loss with no trace.
 */
import type { TrackerAdapter } from '../../trackers';
import type { CategorizationItem, MeetingCategory } from '../parsing/categorizationManifest';
import type { ContractVerdict } from '../parsing/contractVerdict';
import type { EnrichedInventoryItem } from '../types';
import type { EffectiveWrite } from './contractGates';

// ── Verdict shape ────────────────────────────────────────────────────────────

export type ArbiterConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type ArbiterEvidenceSource = 'card-missing' | 'card-status' | 'comment' | 'card-body' | 'none';

export type ArbiterVerdict = {
  /** Defaults to 'HOLD' on any parse miss — fail-closed, the opposite default from `parseContractVerdict`. */
  resolution: '2A' | '2B' | 'HOLD';
  confidence: ArbiterConfidence;
  evidenceSource: ArbiterEvidenceSource;
  evidence: string;
  rationale: string;
  raw: string;
};

export function parseArbiterVerdict(raw: string): ArbiterVerdict {
  const out: ArbiterVerdict = { resolution: 'HOLD', confidence: 'unknown', evidenceSource: 'none', evidence: '', rationale: '', raw: raw.trim() };

  const res = raw.match(/^\s*RESOLUTION:\s*(2A|2B|HOLD)/im)?.[1]?.toUpperCase();
  if (res === '2A' || res === '2B' || res === 'HOLD') out.resolution = res;

  const conf = raw.match(/^\s*CONFIDENCE:\s*(high|medium|low)/im)?.[1]?.toLowerCase();
  if (conf === 'high' || conf === 'medium' || conf === 'low') out.confidence = conf;

  const src = raw.match(/^\s*EVIDENCE_SOURCE:\s*(card-missing|card-status|comment|card-body|none)/im)?.[1]?.toLowerCase();
  if (src) out.evidenceSource = src as ArbiterEvidenceSource;

  out.evidence = raw.match(/^\s*EVIDENCE:\s*(.+)$/im)?.[1]?.trim() ?? '';
  out.rationale = raw.match(/^\s*RATIONALE:\s*([\s\S]*?)(?=\n\s*[A-Z_]+:|\n*$)/im)?.[1]?.trim() ?? '';

  return out;
}

/**
 * Whether a verdict clears the bar to actually decide the dispute — high confidence AND a cited
 * fact, always; a resolution toward the losing side's write being `NOTHING` additionally requires
 * the strongest evidence class (comment/card-body — something that shows the work is already there,
 * not just that a card exists). Returns null (hold) on anything short of that.
 */
export function acceptArbiterResolution(
  v: ArbiterVerdict,
  dispute: { write2a: EffectiveWrite; write2b: EffectiveWrite }
): '2a' | '2b' | null {
  if (v.resolution !== '2A' && v.resolution !== '2B') return null;
  if (v.confidence !== 'high') return null;
  if (v.evidenceSource === 'none' || !v.evidence) return null;
  const winningWrite = v.resolution === '2A' ? dispute.write2a : dispute.write2b;
  if (winningWrite.action === 'NOTHING' && v.evidenceSource !== 'comment' && v.evidenceSource !== 'card-body') {
    return null;
  }
  return v.resolution === '2A' ? '2a' : '2b';
}

// ── Prompt ───────────────────────────────────────────────────────────────────

type LiveCard = Awaited<ReturnType<TrackerAdapter['getTask']>>;

function describeLiveCard(label: string, id: string | undefined, live: LiveCard | undefined, comments: string | undefined): string {
  if (!id) return `${label}: (this read named no card)`;
  const status = live === undefined ? 'unknown (fetch failed)' : !live ? 'DOES NOT EXIST on the board right now' : `open, status "${live.status}"`;
  return [
    `${label}: card ${id} — ${status}`,
    comments ? `  its comments:\n${comments.slice(0, 2500).split('\n').map((l) => `    ${l}`).join('\n')}` : '  its comments: (none fetched)',
  ].join('\n');
}

export function buildArbiterPrompt(
  original: EnrichedInventoryItem,
  m: CategorizationItem,
  verdict: ContractVerdict,
  ctx: {
    id2a?: string; id2b?: string;
    live2a?: LiveCard; live2b?: LiveCard;
    comments2a?: string; comments2b?: string;
  }
): string {
  return [
    '══════════════════════════════════════════════════════════════════════',
    'DISPUTE ARBITRATION — two independent reads of the same source disagree on what to write',
    '══════════════════════════════════════════════════════════════════════',
    '',
    'Two independent reads of the SAME source item reached different conclusions about what should be',
    'written to the board. Your job is NOT to re-judge the source from scratch — it is to check the',
    'LIVE board state below and see whether it SETTLES which read is right.',
    '',
    'Resolve this ONLY when a specific fact on the board decides it — a card that no longer exists, a',
    'status that rules one read out, or a comment that already covers what the other read would create.',
    'If nothing below settles it, say HOLD. A human answering this costs one question; a wrong',
    'auto-resolve costs either a bad write or a silently dropped one — HOLD is always the safe choice.',
    '',
    `ORIGINAL SOURCE ITEM: ${original.title}`,
    original.desc,
    original.quote ? `Quoted: "${original.quote}"` : '',
    '',
    `READ A: ${m.category}${ctx.id2a ? ` → card ${ctx.id2a}` : ''}`,
    m.rationale ? `  reasoning: ${m.rationale}` : '',
    `READ B (blind, independent second read): ${verdict.category}${ctx.id2b ? ` → card ${ctx.id2b}` : ''}`,
    verdict.rationale ? `  reasoning: ${verdict.rationale}` : '',
    '',
    'LIVE BOARD STATE (fetched just now — NOT the snapshot either read above was working from, which',
    'is stale by the length of the whole pipeline that ran before this point):',
    describeLiveCard('Read A\'s card', ctx.id2a, ctx.live2a, ctx.comments2a),
    describeLiveCard('Read B\'s card', ctx.id2b, ctx.live2b, ctx.comments2b),
    '',
    '══════════════════════════════════════════════════════════════════════',
    'OUTPUT — emit EXACTLY this block, nothing else',
    '══════════════════════════════════════════════════════════════════════',
    'RESOLUTION: <2A | 2B | HOLD>',
    'CONFIDENCE: <high | medium | low — HIGH means the live board state leaves no real doubt>',
    'EVIDENCE_SOURCE: <card-missing | card-status | comment | card-body | none>',
    'EVIDENCE: <one sentence naming the SPECIFIC live-board fact that decided this — not your reasoning>',
    'RATIONALE: <brief>',
    'FORBIDDEN: any text outside the block; resolving without a specific EVIDENCE fact.',
  ].filter((l) => l !== '').join('\n');
}

// ── Rewriting the item when Read B wins ─────────────────────────────────────

/**
 * Read B (the blind check) won the dispute — rewrite the item to reflect its category/target before
 * it flows into the deterministic gates, mirroring the field mapping `resume.ts` already uses when a
 * human's answer picks the blind read.
 */
export function applyBlindRead(item: CategorizationItem, verdict: ContractVerdict): CategorizationItem {
  const matchId = verdict.matchIds[0];
  const base: CategorizationItem = { ...item, category: verdict.category as MeetingCategory };
  if (verdict.category === 'UPDATE') return { ...base, existingTaskId: matchId, parentTaskId: undefined, status: item.status || 'in progress' };
  if (verdict.category === 'SUBTASK') return { ...base, parentTaskId: matchId, existingTaskId: undefined };
  if (verdict.category === 'DUPLICATE') return { ...base, existingTaskId: matchId, parentTaskId: undefined };
  if (verdict.category === 'NEW_TASK') return { ...base, existingTaskId: undefined, parentTaskId: undefined };
  return base;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export type ArbiterRunner = (prompt: string, label: string) => Promise<string>;

/** Injected I/O — a caller with no deps (arbiter not configured/enabled) gets `resolveDispute`
 *  short-circuited to always hold; see `contractCheck.ts`'s `opts.arbiter`. */
export type ArbiterDeps = {
  runAgent: ArbiterRunner;
  tracker: Pick<TrackerAdapter, 'getTask' | 'getComments'>;
};

export type DisputeOutcome =
  | { kind: 'resolved'; winner: '2a' | '2b'; evidence: string }
  | { kind: 'hold'; reason: string };

export async function resolveDispute(
  original: EnrichedInventoryItem,
  m: CategorizationItem,
  verdict: ContractVerdict,
  dispute: { write2a: EffectiveWrite; write2b: EffectiveWrite },
  deps: ArbiterDeps,
  label: string
): Promise<DisputeOutcome> {
  const id2a = dispute.write2a.target;
  const id2b = dispute.write2b.target;

  // Step 1 — mechanical, no LLM. A card that's gone settles it for free. `BoardTask` has no
  // `archived` field in this repo, so "gone" here means "not found", not "found but archived".
  const [live2a, live2b] = await Promise.all([
    id2a ? deps.tracker.getTask(id2a) : Promise.resolve(undefined),
    id2b ? deps.tracker.getTask(id2b) : Promise.resolve(undefined),
  ]);
  const gone2a = !!id2a && !live2a;
  const gone2b = !!id2b && !live2b;
  if (id2a && id2b) {
    if (gone2a && !gone2b) return { kind: 'resolved', winner: '2b', evidence: `card ${id2a} no longer exists on the board` };
    if (gone2b && !gone2a) return { kind: 'resolved', winner: '2a', evidence: `card ${id2b} no longer exists on the board` };
    if (gone2a && gone2b) return { kind: 'hold', reason: 'both cited cards are missing — neither read checks out' };
  }

  // Step 2 — model, only for what step 1 could not settle.
  const [comments2a, comments2b] = await Promise.all([
    id2a && live2a ? deps.tracker.getComments(id2a).then((cs) => cs.map((c) => `${c.author}: ${c.body}`).join('\n')) : Promise.resolve(undefined),
    id2b && live2b ? deps.tracker.getComments(id2b).then((cs) => cs.map((c) => `${c.author}: ${c.body}`).join('\n')) : Promise.resolve(undefined),
  ]);
  const prompt = buildArbiterPrompt(original, m, verdict, { id2a, id2b, live2a, live2b, comments2a, comments2b });

  let reply: string;
  try {
    reply = await deps.runAgent(prompt, label);
  } catch (err) {
    return { kind: 'hold', reason: `arbiter call failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` };
  }

  const av = parseArbiterVerdict(reply);
  const winner = acceptArbiterResolution(av, dispute);
  if (!winner) return { kind: 'hold', reason: av.rationale || 'arbiter could not resolve with sufficient confidence' };
  return { kind: 'resolved', winner, evidence: av.evidence };
}
