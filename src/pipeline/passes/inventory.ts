/**
 * Passes 0 → 1.7: cleanup, inventory, critic, consolidator.
 *
 * **The contract every pass here keeps — and the reason to be careful editing them — is FAIL-OPEN.**
 * None of these may break the run. A pass that throws, times out, or returns nothing yields its
 * input unchanged and the pipeline continues on the previous stage's output:
 *
 *   Pass 0   fails → the RAW source is used (not an abort)
 *   Pass 1.5 fails → Pass 1's inventory is kept
 *   Pass 1.7 fails → the Pass 1 + 1.5 inventory is kept
 *
 * Pass 1 is the one exception: it has no earlier output to fall back to, so a failure returns null
 * and the caller decides.
 *
 * **A truncated reply is treated as a failure, not as a shorter success.** This is the subtle one: a
 * long PARTIAL is more dangerous than an empty reply, because it parses cleanly and silently ships
 * half a transcript or half an inventory. An empty reply is caught for the same reason — it is what
 * a refused or truncated generation looks like.
 */
import { type InventoryParse, combineConsolidatedInventory, combineInventories, parseInventory } from '../parsing/inventory';
import {
  type InventoryPromptOptions,
  buildCleanupPrompt,
  buildConsolidatorPrompt,
  buildCriticPrompt,
  buildInventoryPrompt,
} from '../prompts/inventory';

export type PassReply = { text: string; truncated?: boolean };

/** The model seam. Mirrors `ModelClient.complete` so a provider drops straight in. */
export type PassRunner = (req: {
  prompt: string;
  label: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}) => Promise<PassReply>;

export type PassDeps = {
  run: PassRunner;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Called when a pass is abandoned because its output was cut off — worth alerting on for Pass 1. */
  onTruncated?: (pass: string) => void;
};

const noop = (): void => {};

/** Run one pass and return undefined on ANY failure — error, empty, or truncated. */
async function attempt(deps: PassDeps, pass: string, label: string, prompt: string): Promise<string | undefined> {
  const warn = deps.warn ?? noop;
  try {
    const reply = await deps.run({ prompt, label });

    if (reply.truncated) {
      warn(`[pass${pass}] output TRUNCATED — treated as failure; not shipping the partial result`);
      deps.onTruncated?.(pass);
      return undefined;
    }
    if (!reply.text.trim()) {
      warn(`[pass${pass}] empty reply — treated as failure`);
      return undefined;
    }
    return reply.text;
  } catch (err) {
    warn(`[pass${pass}] failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    return undefined;
  }
}

// ── Pass 0 — cleanup ─────────────────────────────────────────────────────────

export type CleanupInput = { rawSource: string; participantNames?: string };

/** The cleaned source, or the raw one unchanged if cleanup failed. Never throws. */
export async function runCleanup(input: CleanupInput, deps: PassDeps): Promise<string> {
  const out = await attempt(
    deps,
    '0',
    'pass0:cleanup',
    buildCleanupPrompt(input.rawSource, { ...(input.participantNames ? { participantNames: input.participantNames } : {}) })
  );
  if (!out) {
    (deps.log ?? noop)('[pass0] cleanup unavailable — continuing with the raw source');
    return input.rawSource;
  }
  return out;
}

// ── Pass 1 — inventory ───────────────────────────────────────────────────────

export type InventoryInput = { sourceText: string } & InventoryPromptOptions;

export type InventoryResult = {
  raw: string;
  parsed: InventoryParse | null;
  /** True when the reply was cut off — the tail of a long source is missing, which is worth alerting on. */
  outputTruncated: boolean;
};

/**
 * The one pass with no fallback: there is no earlier output to keep. A failure returns a null parse
 * and the caller decides what to do about it.
 */
export async function runInventory(input: InventoryInput, deps: PassDeps): Promise<InventoryResult> {
  let truncated = false;
  const wrapped: PassDeps = {
    ...deps,
    onTruncated: (pass) => {
      truncated = true;
      deps.onTruncated?.(pass);
    },
  };

  const raw = await attempt(wrapped, '1', 'pass1:inventory', buildInventoryPrompt(input.sourceText, input));
  if (!raw) return { raw: '', parsed: null, outputTruncated: truncated };

  const parsed = parseInventory(raw);
  if (!parsed) (deps.warn ?? noop)('[pass1] inventory produced no parseable lines');
  return { raw, parsed, outputTruncated: truncated };
}

// ── Pass 1.5 — critic ────────────────────────────────────────────────────────

export type CriticInput = { sourceText: string; inventoryRaw: string };

/** The inventory plus anything the critic recovered. Returns the input unchanged on failure. */
export async function runInventoryCritic(input: CriticInput, deps: PassDeps): Promise<string> {
  const out = await attempt(deps, '1.5', 'pass1.5:critic', buildCriticPrompt(input.sourceText, input.inventoryRaw));
  if (!out) {
    (deps.log ?? noop)('[pass1.5] critic unavailable — keeping the Pass 1 inventory');
    return input.inventoryRaw;
  }
  return combineInventories(input.inventoryRaw, out, deps.warn ?? noop);
}

// ── Pass 1.7 — consolidator ──────────────────────────────────────────────────

export type ConsolidatorInput = { inventoryRaw: string };

/** The inventory with same-deliverable duplicates merged. Returns the input unchanged on failure. */
export async function runInventoryConsolidator(input: ConsolidatorInput, deps: PassDeps): Promise<string> {
  const out = await attempt(deps, '1.7', 'pass1.7:consolidator', buildConsolidatorPrompt(input.inventoryRaw));
  if (!out) {
    (deps.log ?? noop)('[pass1.7] consolidator unavailable — keeping the inventory as-is');
    return input.inventoryRaw;
  }
  return combineConsolidatedInventory(input.inventoryRaw, out, deps.warn ?? noop);
}
