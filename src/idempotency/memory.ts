import {
  type IdempotencyStore,
  type SeenRecord,
  type StoreConfig,
  isExpired,
  namespaced,
  resolveTtls,
} from './index';

/** In-process store. Everything is lost on restart — which is the point of `jsonFileStore`. */
export function memoryStore(cfg?: StoreConfig): IdempotencyStore {
  const seen = new Map<string, SeenRecord>();
  const ttls = resolveTtls(cfg);
  const now = cfg?.now ?? Date.now;

  return {
    async checkAndMark(layer, key, meta) {
      const k = namespaced(layer, key);
      const prior = seen.get(k);
      if (prior && !isExpired(prior, ttls[layer], now())) return prior;

      seen.set(k, {
        layer,
        key,
        seenAt: new Date(now()).toISOString(),
        ...(meta ? { meta } : {}),
      });
      return null;
    },

    async forget(layer, key) {
      seen.delete(namespaced(layer, key));
    },

    async prune(at) {
      const nowMs = at ?? now();
      for (const [k, rec] of seen) {
        if (isExpired(rec, ttls[rec.layer], nowMs)) seen.delete(k);
      }
    },
  };
}
