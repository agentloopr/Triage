/**
 * Types shared across the pipeline, kept in a leaf module so passes never import each other just to
 * borrow a shape.
 */

/** One actionable item, as Pass 1 (and 1.5/1.7) leave it — the input to Pass 2a and, separately, 2b. */
export type EnrichedInventoryItem = {
  number: number;
  title: string;
  /** Factual extraction from the source, a few sentences. */
  desc: string;
  /** Verbatim timestamp range from the source, e.g. "00:04:06-00:04:36". Empty for non-timed sources. */
  timestamp: string;
  /** "(none)" or `board title… | id:xxx | list:yyy` — an UNVERIFIED hint for Pass 2a, never a decision. */
  possibleMatchHint: string;
  /**
   * The item points at something only deictically — "this is done", "that one's shipped" — so it
   * names no card. Detected from the text by Pass 1; *resolving* which card was meant needs evidence
   * this repo does not have, so a vague reference to an existing card is held for a human.
   */
  isVague?: boolean;
  quote?: string;
};

/**
 * Provenance of the source text, used by the legitimacy gate. Transcripts from automatic speech
 * recognition carry a confidence signal; a low-confidence source plus an unsure verdict is held
 * rather than guessed at.
 */
export type SourceProvenance = {
  kind: 'transcript' | 'channel';
  /** 0–1. 1 for text sources that were never transcribed. */
  confidence: number;
};
