/**
 * The one durable-JSON primitive. Everything that persists in this repo — idempotency, the registry,
 * pending human holds, per-role state — goes through here rather than reimplementing the same three
 * hazards badly.
 *
 * **Atomic write (tmp + rename).** A plain `writeFileSync` that is killed halfway leaves a truncated
 * file that still parses as JSON often enough to be dangerous. In production this turned a versioning
 * registry into `{}` and triggered a full re-push of every task. Rename is atomic on POSIX; the file
 * is either the old one or the new one, never half of each.
 *
 * **Corrupt files fail loud, not empty.** Silently starting from `{}` is the worst option: the state
 * is gone, nothing says so, and the next successful write persists the emptiness as the new truth.
 * A corrupt file is renamed aside (so it can be inspected) and reported through an injected notifier.
 *
 * **FIFO write lock.** Concurrent read-modify-write on one file is lost-update by construction.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let onCorrupt: ((msg: string) => void) | null = null;

/**
 * Register a sink for corruption reports. Injected rather than imported so this module has no
 * dependency on any notification channel — and so tests can assert the report actually fires.
 */
export function setCorruptFileNotifier(fn: ((msg: string) => void) | null): void {
  onCorrupt = fn;
}

export function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * Read and parse, or return null. A file that exists but does not parse is quarantined to
 * `<path>.corrupt-<ts>` and reported — never silently treated as absent.
 */
export function readJsonOrNull<T>(path: string, opts?: { quarantine?: boolean }): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    let moved = '(not moved)';
    if (opts?.quarantine !== false) {
      try {
        moved = `${path}.corrupt-${Date.now()}`;
        renameSync(path, moved);
      } catch {
        moved = '(quarantine failed)';
      }
    }
    const msg = `[state] CORRUPT ${path} (${detail}) — quarantined to ${moved}; starting empty. State in that file is LOST.`;
    console.error(msg);
    try {
      onCorrupt?.(msg);
    } catch (notifyErr) {
      console.error(`[state] corrupt-notifier itself failed: ${(notifyErr as Error)?.message ?? notifyErr}`);
    }
    return null;
  }
}

/**
 * Serialize async work FIFO. Failures never break the chain — one rejected write must not wedge
 * every later one.
 */
export function makeFifoLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}
