/**
 * Passes 1 / 1.5 / 1.7 — the action inventory: its wire format, parser, and the two merge functions.
 *
 * The inventory is a numbered list of actionable items, each optionally carrying a description,
 * timestamp and an unverified match hint. Passes 1.5 (critic) and 1.7 (consolidator) do not rewrite
 * it — they emit *additions* and *merges* that are folded in here, deterministically.
 *
 * **That is the load-bearing decision.** Letting a model return a rebuilt inventory would mean every
 * later pass trusts an LLM's transcription of an earlier LLM's work, and a dropped line would be
 * invisible. Instead a merge is applied only when it can be anchored to specific source line
 * numbers; anything else leaves the original untouched.
 *
 * Everything here is pure and source-agnostic — the same format carries meeting transcripts and
 * channel logs.
 */
import type { EnrichedInventoryItem } from '../types';

export const INVENTORY_START = '--- ACTION INVENTORY ---';
export const INVENTORY_END = '--- END ACTION INVENTORY ---';
export const CONSOLIDATED_START = '--- CONSOLIDATED INVENTORY ---';
export const CONSOLIDATED_END = '--- END CONSOLIDATED INVENTORY ---';

/** Legacy channel markers, normalized to the shared ones so one parser serves both sources. */
const CHANNEL_START = '--- CHANNEL ACTION INVENTORY ---';
const CHANNEL_END = '--- END CHANNEL ACTION INVENTORY ---';

/**
 * `N. <title> | …`. The optional `[Action|Policy]` group keeps older inventories parseable — every
 * line is actionable in the current format, and the category decision belongs to Pass 2a.
 */
const INVENTORY_LINE_RE = /^\s*(\d+)\.\s+(?:\[(Action|Policy)\]\s+)?(.+)$/i;

/** Deictic references — "this is done" names no card, so it cannot be resolved without more evidence. */
const VAGUE_RE = /\b(this|that|it|those|these)\b\s+(one|thing|card|task|ticket)?\s*\b(is|was|are|were|'s)\b\s*\b(done|finished|complete|shipped|fixed|sorted|handled)\b/i;

export type InventoryParse = {
  raw: string;
  lineCount: number;
  /** Items the pipeline will act on. */
  actionableCount: number;
  policyNotes: number;
};

type InventoryBlock = { titleLine: string; num: number; continuations: string[] };

export function normalizeInventoryRaw(raw: string): string {
  return raw.split(CHANNEL_START).join(INVENTORY_START).split(CHANNEL_END).join(INVENTORY_END);
}

/** Split into (title line + its indented continuation lines), preserving multi-line fields. */
function collectInventoryBlocks(text: string): InventoryBlock[] {
  const blocks: InventoryBlock[] = [];
  let current: InventoryBlock | null = null;

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(INVENTORY_LINE_RE);
    if (m) {
      if (current) blocks.push(current);
      current = { num: Number(m[1]), titleLine: line.trim(), continuations: [] };
    } else if (current && line.trim()) {
      current.continuations.push(line.trim());
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function inventoryLineTitle(line: string): string {
  const m = line.match(INVENTORY_LINE_RE);
  const rest = m ? m[3]! : line;
  return rest.split('|')[0]!.trim();
}

/**
 * Where the inventory starts. Falls back to start-of-text when the marker is missing but at least
 * three inventory-shaped lines are present — a model that forgets a delimiter should not cost the
 * whole run. Detection uses the SAME regex as parsing, so the two can never disagree.
 */
function resolveBlockStart(text: string): { startIdx: number; contentStart: number; usedFallback: boolean } {
  const explicit = text.indexOf(INVENTORY_START);
  if (explicit !== -1) {
    return { startIdx: explicit, contentStart: explicit + INVENTORY_START.length, usedFallback: false };
  }
  let matches = 0;
  for (const line of text.split(/\r?\n/)) {
    if (INVENTORY_LINE_RE.test(line)) matches++;
    if (matches >= 3) return { startIdx: 0, contentStart: 0, usedFallback: true };
  }
  return { startIdx: -1, contentStart: -1, usedFallback: false };
}

function resolveBlockEnd(text: string, startIdx: number): number {
  const explicit = text.indexOf(INVENTORY_END);
  return explicit !== -1 && explicit > startIdx ? explicit : text.length;
}

/** The per-item structured form every downstream pass consumes. */
export function parseEnrichedInventoryItems(raw: string): EnrichedInventoryItem[] {
  const text = normalizeInventoryRaw(raw);
  const { startIdx, contentStart } = resolveBlockStart(text);
  if (startIdx === -1) return [];

  const endIdx = resolveBlockEnd(text, startIdx);
  if (endIdx <= startIdx) return [];

  const items: EnrichedInventoryItem[] = [];

  for (const b of collectInventoryBlocks(text.slice(contentStart, endIdx))) {
    const title = inventoryLineTitle(b.titleLine);
    const quote = b.titleLine.match(/quote:\s*"([^"]+)"/i)?.[1] ?? '';

    const descLines: string[] = [];
    let timestamp = '';
    let possibleMatchHint = '(none)';
    let currentField = '';

    for (const cont of b.continuations) {
      if (/^DESC:\s*/i.test(cont)) {
        currentField = 'desc';
        descLines.push(cont.replace(/^DESC:\s*/i, '').trim());
      } else if (/^TIMESTAMP:\s*/i.test(cont)) {
        currentField = 'timestamp';
        timestamp = cont.replace(/^TIMESTAMP:\s*/i, '').trim();
      } else if (/^POSSIBLE_MATCH_HINT:\s*/i.test(cont)) {
        currentField = 'hint';
        possibleMatchHint = cont.replace(/^POSSIBLE_MATCH_HINT:\s*/i, '').trim();
      } else if (currentField === 'desc') {
        descLines.push(cont);
      }
    }

    const desc = descLines.join(' ');
    items.push({
      number: b.num,
      title,
      desc,
      timestamp,
      possibleMatchHint,
      ...(VAGUE_RE.test(`${title} ${desc}`) ? { isVague: true } : {}),
      ...(quote ? { quote } : {}),
    });
  }

  return items;
}

/** Summary counts. Returns null when there is genuinely nothing to parse. */
export function parseInventory(raw: string): InventoryParse | null {
  const text = normalizeInventoryRaw(raw).trim();
  const { startIdx, contentStart } = resolveBlockStart(text);
  if (startIdx === -1) return null;

  const endIdx = resolveBlockEnd(text, startIdx);
  if (endIdx <= startIdx) return null;

  const block = text.slice(contentStart, endIdx).trim();
  let lineCount = 0;
  let policyNotes = 0;

  for (const line of block.split(/\r?\n/)) {
    const m = line.match(INVENTORY_LINE_RE);
    if (!m) continue;
    lineCount++;
    if (m[2]?.toLowerCase() === 'policy') policyNotes++;
  }

  if (lineCount === 0) return null;
  return { raw: text.slice(startIdx, endIdx + INVENTORY_END.length), lineCount, actionableCount: lineCount - policyNotes, policyNotes };
}

/** Renumber a critic reply's items so they continue after the original's last line. */
function renumberFrom(text: string, start: number): string {
  let n = start;
  return text
    .split(/\r?\n/)
    .map((line) => (INVENTORY_LINE_RE.test(line) ? line.replace(/^(\s*)\d+\.(\s+)/, `$1${n++}.$2`) : line))
    .join('\n');
}

/**
 * Pass 1.5 — fold the critic's ADDITIONS into the original inventory.
 *
 * The critic emits only what Pass 1 missed. A reply of "NONE" is the common, healthy case.
 *
 * **A non-NONE reply that yields zero parseable lines is a defect, and it is loud.** That exact
 * shape — substantive text the parser could not read — is how a numbering bug once hid for weeks
 * while the log cheerfully reported "recovered 0 missing items" and everyone moved on.
 */
export function combineInventories(
  originalRaw: string,
  criticRaw: string,
  warn: (msg: string) => void = (m) => console.warn(m)
): string {
  const text = normalizeInventoryRaw(originalRaw);
  const startIdx = text.indexOf(INVENTORY_START);
  const endIdx = text.indexOf(INVENTORY_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return originalRaw;

  if (/^\s*none\s*$/i.test(criticRaw.trim())) return originalRaw;

  const existing = collectInventoryBlocks(text.slice(startIdx, endIdx));
  const additions = collectInventoryBlocks(criticRaw);

  if (additions.length === 0) {
    if (criticRaw.trim().length > 20) {
      warn(
        `[pass1.5] critic returned ${criticRaw.trim().length} chars but ZERO parseable inventory lines — ` +
          'its additions were dropped. This is a defect, not a quiet no-op.'
      );
    }
    return originalRaw;
  }

  const nextNumber = existing.reduce((max, b) => Math.max(max, b.num), 0) + 1;
  const renumbered = renumberFrom(
    additions.map((b) => [b.titleLine, ...b.continuations.map((c) => `   ${c}`)].join('\n')).join('\n'),
    nextNumber
  );

  return `${text.slice(0, endIdx).trimEnd()}\n${renumbered}\n${text.slice(endIdx)}`;
}

/**
 * Pass 1.7 — apply the consolidator's MERGES.
 *
 * **Every merged item must declare `merged_from: <n>, <m>` naming the original line numbers it
 * replaces.** Without that anchor the rebuild is just an LLM retyping the inventory, and a silently
 * dropped line would be undetectable. So: if merges were claimed but none can be anchored, the
 * original is returned unchanged. Fail-open, never fail-quiet.
 */
export function combineConsolidatedInventory(
  originalRaw: string,
  consolidatedRaw: string,
  warn: (msg: string) => void = (m) => console.warn(m)
): string {
  const csIdx = consolidatedRaw.indexOf(CONSOLIDATED_START);
  const ceIdx = consolidatedRaw.indexOf(CONSOLIDATED_END);
  if (csIdx === -1 || ceIdx === -1 || ceIdx <= csIdx) return originalRaw;

  const body = consolidatedRaw.slice(csIdx + CONSOLIDATED_START.length, ceIdx);

  const declared = body.match(/^MERGED_PAIRS:\s*(\d+)/im);
  const mergedPairs = declared ? parseInt(declared[1]!, 10) : -1;
  if (mergedPairs === 0) return originalRaw; // nothing claimed, nothing to do

  const blocks = collectInventoryBlocks(body);
  if (blocks.length === 0) return originalRaw;

  const text = normalizeInventoryRaw(originalRaw);
  const startIdx = text.indexOf(INVENTORY_START);
  const endIdx = text.indexOf(INVENTORY_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return originalRaw;

  const originalBlocks = collectInventoryBlocks(text.slice(startIdx, endIdx));
  const byNum = new Map(originalBlocks.map((b) => [b.num, b]));

  // Which original lines does each consolidated block claim to replace?
  const replaced = new Set<number>();
  let anchored = 0;
  for (const b of blocks) {
    const hint = [b.titleLine, ...b.continuations].join(' ');
    const from = hint.match(/merged_from:\s*([\d,\s]+)/i)?.[1];
    if (!from) continue;
    const nums = from.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && byNum.has(n));
    if (nums.length < 2) continue; // a "merge" of one line is not a merge
    anchored++;
    for (const n of nums) replaced.add(n);
  }

  if (anchored === 0) {
    warn(
      `[pass1.7] consolidator claimed ${mergedPairs} merge(s) but none named the lines they replace — ` +
        'refusing to rebuild the inventory from an unanchored reply. Original kept.'
    );
    return originalRaw;
  }

  // Survivors keep their content; merged blocks replace the lines they name. Renumbered from 1.
  const survivors = originalBlocks.filter((b) => !replaced.has(b.num));
  const merged = blocks.filter((b) => /merged_from:/i.test([b.titleLine, ...b.continuations].join(' ')));

  let n = 0;
  const rendered = [...survivors, ...merged]
    .map((b) => {
      n++;
      const title = b.titleLine.replace(/^(\s*)\d+\.(\s+)/, `$1${n}.$2`).replace(/\s*\|?\s*merged_from:\s*[\d,\s]+/i, '');
      return [title, ...b.continuations.filter((c) => !/^merged_from:/i.test(c)).map((c) => `   ${c}`)].join('\n');
    })
    .join('\n');

  return `${INVENTORY_START}\n${rendered}\n${INVENTORY_END}`;
}
