/**
 * The ingest seam.
 *
 * **Normalization ships; transport does not.** Five sources normalize here — a meeting transcript, a
 * channel log, a GitHub activity feed, an email thread and a document activity feed — and all five
 * arrive as `IngestedSource` and run the identical 1 → 2d chain. What is *not* here is the delivery
 * mechanism: webhooks, polling, cron and retry policy are product surface, and every team's are
 * different. Reading a service is a separate concern again, and lives in `src/sources/`.
 *
 * An earlier version of this file said ingestion was "out of scope entirely". That was overstated,
 * and it hardened into a constraint nobody had actually imposed — the repo shipped two sources and
 * read as a meeting pipeline with a second entry point, which is the exact thing `channel.ts` was
 * written to disprove. The boundary is narrower than that sentence claimed: **shapes in, transport
 * out.**
 *
 * The three ids exist to serve the three idempotency layers, and keeping them distinct is what makes
 * "a redelivery costs zero tokens" true rather than aspirational:
 *   `eventId`  — this specific delivery (a webhook retry repeats it)
 *   `sourceId` — the underlying thing (the same meeting, however many times it is delivered)
 *   content    — hashed downstream, catching the same content arriving under a different id
 */

/**
 * Slack is deliberately absent: a team-chat log **is** `channel`. Adding a fifth kind that rendered
 * identically would be a name, not a capability.
 */
export type SourceKind = 'transcript' | 'channel' | 'github' | 'gmail' | 'drive';

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
