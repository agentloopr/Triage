/**
 * A prompt split at the line where it stops being the same for every item in a run.
 *
 * Passes 2a and 2b fan out one call per item over an identical preamble: the taxonomy, the rules,
 * the roster, the board snapshot and the source text. Only the item and its evidence differ. Sent as
 * a single user message, that shared preamble is re-uploaded and re-billed on every call — and the
 * board snapshot alone is the largest thing in the prompt.
 *
 * **This was measured, not assumed.** The Anthropic adapter has always set a prompt-cache breakpoint
 * on the last system block, and the pipeline has always sent no system block at all, so the
 * breakpoint never fired: cache-hit rate across a full run was **zero**, and `PROVIDERS.md` recorded
 * the caching code as decorative. The fix is not new caching logic — the logic was already there and
 * correct. It is putting the stable half where the cache can see it.
 *
 * The boundary is a correctness constraint, not a formatting preference: anything item-specific that
 * leaks into `system` silently poisons the cache for every other item in the run, and the symptom is
 * a cost regression rather than a failing test. `promptParts.test.ts` pins it.
 */
export interface PromptParts {
  /** Identical for every item in a run. The cacheable prefix. */
  system: string;
  /** The per-item tail: the item itself, and the evidence gathered for it. */
  user: string;
}

/** The whole prompt as one string — for tests and traces that care about content, not placement. */
export function joinPrompt(parts: PromptParts): string {
  return `${parts.system}\n${parts.user}`;
}
