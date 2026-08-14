/**
 * File-backed idempotency — survives a restart, which is the whole reason it exists.
 *
 * All three layers live in ONE file so a single atomic rename covers them together; a crash can
 * never leave `event` marked and `source` not.
 *
 * **And it locks across processes, because surviving a restart is the point.** This used to order
 * its mutations with an in-process FIFO lock. That is a category error for a store whose entire
 * reason to be on disk is that the next reader is a different process: `checkAndMark` is documented
 * as "a single atomic test-and-set, which is the only shape that actually holds", and an in-process
 * lock cannot make it one.
 *
 * The gap was not theoretical and not small. Measured, 20 processes racing one delivery key with a
 * start barrier:
 *
 *   empty file      2–4 of 20 accepted the same delivery as new
 *   75,000 records  **20 of 20**, in every round
 *
 * The window is the read-modify-write, so it widens with the file — and the file only grows (see
 * `prune`). Atomic rename kept the JSON well-formed the whole time; it never had anything to say
 * about lost updates. `npm run pull -- --write` uses this store, so that was concurrent workers all
 * passing idempotency and writing the same cards.
 */
import { atomicWriteJson, readJsonOrNull, withExclusiveFileLock } from '../state/jsonStore';
import {
  type IdempotencyStore,
  type Layer,
  type SeenRecord,
  type StoreConfig,
  isExpired,
  namespaced,
  resolveTtls,
} from './index';

type Persisted = Record<string, SeenRecord>;

export function jsonFileStore(path: string, cfg?: StoreConfig): IdempotencyStore {
  const ttls = resolveTtls(cfg);
  const now = cfg?.now ?? Date.now;

  // Synchronous, and that is the point: nothing can interleave between the read and the write, in
  // this process or any other. It also subsumes the FIFO lock it replaced — a synchronous body
  // cannot yield to another caller in the same process either.
  const withLock = <T>(fn: () => T): T => withExclusiveFileLock(path, fn, cfg?.lock);

  // Re-read under the lock on every mutation rather than caching: another process (or a hand edit)
  // may have touched the file, and this is a few hundred bytes, not a hot path.
  const load = (): Persisted => readJsonOrNull<Persisted>(path) ?? {};

  return {
    async checkAndMark(layer, key, meta) {
      return withLock(() => {
        const data = load();
        const k = namespaced(layer, key);
        const prior = data[k];
        if (prior && !isExpired(prior, ttls[prior.layer] ?? ttls[layer], now())) return prior;

        data[k] = {
          layer,
          key,
          seenAt: new Date(now()).toISOString(),
          ...(meta ? { meta } : {}),
        };
        atomicWriteJson(path, data);
        return null;
      });
    },

    async forget(layer, key) {
      return withLock(() => {
        const data = load();
        delete data[namespaced(layer, key)];
        atomicWriteJson(path, data);
      });
    },

    async prune(at) {
      return withLock(() => {
        const nowMs = at ?? now();
        const data = load();
        let dropped = 0;
        for (const [k, rec] of Object.entries(data)) {
          const ttl = ttls[rec.layer as Layer];
          if (ttl == null || isExpired(rec, ttl, nowMs)) {
            delete data[k];
            dropped++;
          }
        }
        if (dropped) atomicWriteJson(path, data);
      });
    },
  };
}
