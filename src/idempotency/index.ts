/**
 * Three-layer idempotency.
 *
 * The layers are not redundancy — each catches a different real failure:
 *
 *   event   — the same webhook delivered twice (platforms retry on a slow ack)
 *   source  — the same meeting/thread processed again after a restart or a manual re-trigger
 *   content — the same content arriving under a *different* id, which neither layer above can see
 *
 * **One method, not `has` + `mark`.** The natural-looking `if (await store.has(k)) return; await
 * store.mark(k)` is a check-then-act with a race window exactly as wide as the work between the two
 * calls — and two concurrent deliveries of the same event both pass the check. `checkAndMark` is a
 * single atomic test-and-set, which is the only shape that actually holds.
 */
import { createHash } from 'node:crypto';

export type Layer = 'event' | 'source' | 'content';

export interface SeenRecord {
  layer: Layer;
  key: string;
  seenAt: string;
  meta?: Record<string, string>;
}

export interface IdempotencyStore {
  /** Atomically test-and-set. Returns the PRIOR record if already seen, else null (and marks it). */
  checkAndMark(layer: Layer, key: string, meta?: Record<string, string>): Promise<SeenRecord | null>;
  forget(layer: Layer, key: string): Promise<void>;
  prune(now?: number): Promise<void>;
}

export const DEFAULT_TTLS: Record<Layer, number> = {
  event: 15 * 60 * 1000,
  source: 48 * 60 * 60 * 1000,
  content: 48 * 60 * 60 * 1000,
};

export interface StoreConfig {
  ttls?: Partial<Record<Layer, number>>;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/** sha256, sliced — long enough that a collision is not a real concern, short enough to read in a log. */
export function contentKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export function resolveTtls(cfg?: StoreConfig): Record<Layer, number> {
  return { ...DEFAULT_TTLS, ...(cfg?.ttls ?? {}) };
}

export function isExpired(rec: SeenRecord, ttlMs: number, nowMs: number): boolean {
  const seen = Date.parse(rec.seenAt);
  // An unparseable timestamp is treated as expired rather than as "seen forever" — a corrupt row
  // must never be able to permanently suppress processing.
  if (!Number.isFinite(seen)) return true;
  return nowMs - seen >= ttlMs;
}

export function namespaced(layer: Layer, key: string): string {
  return `${layer}:${key}`;
}
