/**
 * File-backed idempotency — survives a restart, which is the whole reason it exists.
 *
 * All three layers live in ONE file so a single atomic rename covers them together; a crash can
 * never leave `event` marked and `source` not.
 */
import { atomicWriteJson, makeFifoLock, readJsonOrNull } from '../state/jsonStore';
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
  const withLock = makeFifoLock();

  // Re-read under the lock on every mutation rather than caching: another process (or a hand edit)
  // may have touched the file, and this is a few hundred bytes, not a hot path.
  const load = (): Persisted => readJsonOrNull<Persisted>(path) ?? {};

  return {
    checkAndMark(layer, key, meta) {
      return withLock(async () => {
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

    forget(layer, key) {
      return withLock(async () => {
        const data = load();
        delete data[namespaced(layer, key)];
        atomicWriteJson(path, data);
      });
    },

    prune(at) {
      return withLock(async () => {
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
