/**
 * Prompts for passes 0 → 1.7: cleanup, inventory, critic, consolidator.
 *
 * Each pass has a deliberately narrow job. The reason the pipeline is staged this way rather than
 * asking one model to do everything is that a narrow job has a checkable output — the inventory
 * either parses or it doesn't — and deterministic code sits between the stages.
 */
import type { SourceKind } from '../../ingest';
import { INVENTORY_END, INVENTORY_START, CONSOLIDATED_END, CONSOLIDATED_START } from '../parsing/inventory';
import { screenedPrimary } from '../../utils/security';

/**
 * Pass 0 — clean up a raw source without changing what it says.
 *
 * `rawSource` is the least-trusted string in the pipeline: a meeting transcript, a Slack log, an
 * inbound email, or GitHub issue text that anyone on the internet can write. It is screened here,
 * at the first prompt that reads it, so every later pass works from already-redacted text — a
 * secret stripped at Pass 0 cannot be echoed back into an item description by Pass 1.
 */
export function buildCleanupPrompt(rawSource: string, opts: { participantNames?: string } = {}): string {
  const source = screenedPrimary(rawSource, 'source/cleanup');
  const participantNames = opts.participantNames
    ? screenedPrimary(opts.participantNames, 'participants/cleanup')
    : opts.participantNames;
  rawSource = source;
  opts = { ...opts, ...(participantNames ? { participantNames } : {}) };
  return [
    'You are cleaning up a raw transcript so a later pass can read it accurately.',
    '',
    'RULES:',
    '- Fix only mechanical damage: speaker attribution, obvious transcription errors, broken sentences.',
    '- NEVER add, remove, summarize or reinterpret content. If someone said something unclear, leave it',
    '  unclear — a later pass is allowed to say "I could not tell"; you are not allowed to decide for it.',
    '- Keep all timestamps exactly as they appear.',
    '- Preserve speaker labels.',
    '- If a term is garbled and you are confident of the correction, fix it. If you are guessing, leave it.',
    '',
    ...(opts.participantNames ? [`PARTICIPANTS: ${opts.participantNames}`, ''] : []),
    'Output ONLY the cleaned transcript. No preamble, no commentary, no summary.',
    '',
    '--- RAW TRANSCRIPT ---',
    rawSource,
    '--- END RAW TRANSCRIPT ---',
  ].join('\n');
}

export type InventoryPromptOptions = {
  participantNames?: string;
  /** Compact board rows (id | title | list | assignee | status) — for match hints only. */
  boardCompact?: string;
  sourceKind?: SourceKind;
};

/**
 * What Pass 1 is told it is reading. Naming the medium is the whole of the source-specific prompt
 * surface — every other line below applies unchanged to all five.
 *
 * `transcript` and `channel` must keep rendering the exact strings the previous boolean produced, or
 * every recorded cassette drifts. The default is `transcript` for the same reason: the old expression
 * fell through to "meeting transcript" whenever `sourceKind` was absent.
 */
const SOURCE_LABEL: Record<SourceKind, { long: string; short: string; delim: string }> = {
  transcript: { long: 'meeting transcript', short: 'transcript', delim: 'TRANSCRIPT' },
  channel: { long: 'channel log', short: 'log', delim: 'CHANNEL LOG' },
  github: { long: 'GitHub activity feed', short: 'activity feed', delim: 'GITHUB ACTIVITY' },
  gmail: { long: 'email thread', short: 'thread', delim: 'EMAIL THREAD' },
  drive: { long: 'document activity feed', short: 'activity feed', delim: 'DOCUMENT ACTIVITY' },
};

/** Pass 1 — extract every actionable item. */
export function buildInventoryPrompt(sourceText: string, opts: InventoryPromptOptions = {}): string {
  const src = SOURCE_LABEL[opts.sourceKind ?? 'transcript'];

  // Screened even though Pass 0 already screened the source: this builder is also reachable with a
  // raw source when cleanup is skipped, and `boardCompact` is tracker text that has not been through
  // Pass 0 at all. Screening is idempotent, so the overlap costs nothing.
  sourceText = screenedPrimary(sourceText, 'source/inventory');
  opts = {
    ...opts,
    ...(opts.participantNames ? { participantNames: screenedPrimary(opts.participantNames, 'participants/inventory') } : {}),
    ...(opts.boardCompact ? { boardCompact: screenedPrimary(opts.boardCompact, 'board/inventory') } : {}),
  };

  return [
    `You are extracting every ACTIONABLE item from a ${src.long}.`,
    '',
    'An actionable item is a concrete deliverable someone committed to, or a reported change in the',
    'state of existing work. Extract the SUBSTANCE, not the wording.',
    '',
    'INCLUDE:',
    '- work someone said they would do, or was asked to do;',
    '- progress or status reported on existing work;',
    '- a blocker that is gating a concrete deliverable someone is actively working on.',
    '',
    'EXCLUDE:',
    '- discussion, opinion, and explanation with no committed deliverable;',
    '- questions that need an answer rather than work;',
    '- work already finished with nothing remaining;',
    '- **ongoing norms and policies** — "going forward, always X", "from now on we should Y",',
    '  "make sure to do Z every time". These have no finish line, so a card for one sits open',
    '  forever and quietly rots the board. A norm is a decision to record somewhere else, not work;',
    '- **people management** — "talk to X about their availability / attitude / showing up",',
    '  "have a word with Y". These are private conversations between two people. A shared board is',
    '  the wrong place for them, and putting one there is a real harm, not just noise.',
    '',
    'Both exclusions above are absolute: if the ONLY thing in a passage is a norm or a conversation',
    'about someone, extract nothing from it. Do not restate it as a task to be safe.',
    '',
    'GROUNDING — the single most important rule:',
    `  Everything you write MUST trace to the ${src.short} below. It is the ONLY source.`,
    '  The board rows (if provided) are for suggesting a possible MATCH — never a source of content.',
    '  Do not import a term, a name or a label from a board row into an item. If a detail was not said,',
    '  it does not go in.',
    '',
    'For EACH item emit a numbered line plus its indented fields:',
    '',
    `${INVENTORY_START}`,
    '1. <short imperative title> | quote: "<the words that committed to it>"',
    '   DESC: <a few factual sentences, drawn only from the source>',
    '   TIMESTAMP: <verbatim time range, or (none)>',
    '   POSSIBLE_MATCH_HINT: <board title | id:<id>, or (none)>',
    `${INVENTORY_END}`,
    '',
    'POSSIBLE_MATCH_HINT is an UNVERIFIED pointer to save a later pass some scanning. It is never a',
    'decision, and being wrong about it is cheap. Omit it rather than guess wildly.',
    '',
    ...(opts.participantNames ? [`PARTICIPANTS: ${opts.participantNames}`, ''] : []),
    ...(opts.boardCompact
      ? ['--- BOARD (for match hints ONLY — never a source of content) ---', opts.boardCompact, '']
      : []),
    `--- ${src.delim} ---`,
    sourceText,
    '--- END ---',
  ].join('\n');
}

/**
 * Pass 1.5 — the critic. Emits ONLY what Pass 1 missed, never a rewritten inventory, because a
 * rewrite means the next pass trusts one model's retyping of another's work.
 */
export function buildCriticPrompt(sourceText: string, inventoryRaw: string): string {
  // `inventoryRaw` is our own model's output over already-screened text, so it is not screened again
  // — screening a model's own reply would be theatre. The source is, because this builder is a
  // separate entry point and must not depend on who called it first.
  sourceText = screenedPrimary(sourceText, 'source/critic');
  return [
    'A first pass extracted an action inventory from the source below. Your job is to find what it MISSED.',
    '',
    'Read the source independently and look for committed deliverables or reported status changes that',
    'do NOT appear in the inventory.',
    '',
    'OUTPUT RULES — read carefully:',
    '- If nothing was missed, output exactly: NONE',
    '- Otherwise output ONLY the missing items, in the same numbered format as the inventory.',
    '- Do NOT restate, renumber, reword or "improve" items that are already there. Additions only.',
    '- Every addition must be grounded in the source, with the words that committed to it.',
    '',
    'Be conservative. A false addition costs a human a question; silence about a genuine miss costs the',
    'work itself. But do not pad the list to look thorough.',
    '',
    '--- EXISTING INVENTORY ---',
    inventoryRaw,
    '--- END EXISTING INVENTORY ---',
    '',
    '--- SOURCE ---',
    sourceText,
    '--- END SOURCE ---',
  ].join('\n');
}

/**
 * Pass 1.7 — the consolidator. Merges items that are the same deliverable said twice.
 *
 * The `merged_from` requirement is not cosmetic: it is the anchor that lets the merge be applied
 * deterministically. A merged item without it is discarded rather than trusted.
 */
export function buildConsolidatorPrompt(inventoryRaw: string): string {
  return [
    'The inventory below may contain the same deliverable captured more than once — the same work',
    'discussed at two points in the conversation, phrased differently.',
    '',
    'Find those, and ONLY those. Two items are the same deliverable when completing one would complete',
    'the other. Related work, or work on the same project, is NOT the same deliverable.',
    '',
    'OUTPUT:',
    `${CONSOLIDATED_START}`,
    'MERGED_PAIRS: <how many merges you are proposing; 0 if none>',
    '1. <merged title> | merged_from: 3, 7',
    '   DESC: <combined description, drawn only from the two originals>',
    '   TIMESTAMP: <the earlier of the two>',
    '   POSSIBLE_MATCH_HINT: <carried over, or (none)>',
    `${CONSOLIDATED_END}`,
    '',
    'EVERY merged item MUST carry `merged_from:` naming the original line numbers it replaces.',
    'A merged item without it will be DISCARDED — the merge cannot be applied safely without knowing',
    'exactly which lines it stands in for. Emit only the merged items, not the untouched ones.',
    '',
    'If nothing should merge, emit MERGED_PAIRS: 0 and no items.',
    '',
    '--- INVENTORY ---',
    inventoryRaw,
    '--- END INVENTORY ---',
  ].join('\n');
}
