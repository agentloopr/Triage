/**
 * The ingest seam.
 *
 * **Ingestion itself is deliberately out of scope for this repo** — webhooks, polling, auth and
 * retries are product surface, not architecture, and every team's are different. What matters is the
 * shape everything downstream depends on, and the fact that the pipeline genuinely does not care
 * which source produced it: a meeting transcript and a channel log both arrive as `IngestedSource`
 * and run the identical 1 → 2d chain.
 *
 * The three ids exist to serve the three idempotency layers, and keeping them distinct is what makes
 * "a redelivery costs zero tokens" true rather than aspirational:
 *   `eventId`  — this specific delivery (a webhook retry repeats it)
 *   `sourceId` — the underlying thing (the same meeting, however many times it is delivered)
 *   content    — hashed downstream, catching the same content arriving under a different id
 */

export type SourceKind = 'transcript' | 'channel';

export interface IngestedSource {
  kind: SourceKind;
  /** Stable id for the underlying meeting/thread. The layer-2 idempotency key. */
  sourceId: string;
  /** Id for THIS delivery, when the transport has one. The layer-1 idempotency key. */
  eventId?: string;
  /** The full text the pipeline reasons over. */
  text: string;
  /** A short summary, when the source provides one. Never a substitute for `text`. */
  summary?: string;
  /** "Avery Chen, Rowan Diaz" — speaker mapping only, never routing. */
  participantNames?: string;
  /** ISO date the source is dated to; becomes the due-date fallback. */
  todayIso?: string;
  /**
   * Per-item source confidence in [0,1], keyed by inventory item number, for sources that were
   * transcribed. Absent means "not transcribed", which is treated as trustworthy — the legitimacy
   * gate must not hold a typed message for having no audio confidence.
   */
  provenanceByItem?: Map<number, number>;
}

export interface IngestSource<TRaw = unknown> {
  readonly kind: SourceKind;
  /** Normalize a provider-shaped payload into the pipeline's input. Pure; no I/O. */
  normalize(raw: TRaw): IngestedSource;
}
