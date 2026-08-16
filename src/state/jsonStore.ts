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
 * **One cross-process lock.** Concurrent read-modify-write on one file is lost-update by
 * construction, and the processes doing it are usually not the same process — see
 * `withExclusiveFileLock`.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let onCorrupt: ((msg: string) => void) | null = null;

/**
 * Register a sink for corruption reports. Injected rather than imported so this module has no
 * dependency on any notification channel — and so tests can assert the report actually fires.
 */
export function setCorruptFileNotifier(fn: ((msg: string) => void) | null): void {
  onCorrupt = fn;
}

/**
 * Owner-only, because of what these files hold rather than what they are.
 *
 * Holds, corrections, role memory and the roster carry task titles, member names and the content of
 * decisions a human made. None of it is a credential, so no secret scanner would ever flag it — and
 * under a default `022` umask it was landing as world-readable `0644` inside a `0755` directory. On
 * a shared host or a CI runner with other tenants, "not a secret" and "fine for anyone to read" are
 * different claims, and only the first one was true.
 */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.tmp-${process.pid}`;
  // The mode is set on the temp file, before the rename, so the final path is never briefly
  // world-readable — `writeFileSync`'s mode applies only when it creates the file, and a rename
  // carries the source's permissions with it.
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE); // explicit: `mode` above is masked by the umask on creation
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
 * Serialize a read-modify-write **across processes**, not just within one.
 *
 * This is the only lock in the repo, and that is deliberate. There used to be a second — a
 * `makeFifoLock` that ordered promises inside one process — held by the idempotency store, the
 * corrections store and the registry mutator. Every one of those files exists *because* the next
 * reader is a different process, so an in-process lock was the wrong primitive at all three, and it
 * read as protection in every review. It is deleted rather than kept for the cases that "only need
 * ordering": a codebase with two locks invites picking the cheap one.
 *
 * The failure was measured, not theorised. Two operators answering the same queue both read the
 * holds file, both saw the item unclaimed, and both wrote — two cards on the board from one
 * decision. Twenty processes racing one delivery key against a 75,000-record idempotency file all
 * twenty accepted it as new. Eight processes recording eight distinct corrections kept four.
 *
 * `openSync(..., 'wx')` is the primitive: it creates the file or throws `EEXIST`, atomically, in one
 * syscall. That is the only part that has to be atomic — everything inside the callback is protected
 * by holding it.
 *
 * **A stale lock is broken after `staleMs`.** A process killed mid-write leaves its lock file behind,
 * and a queue that can never be answered again is a worse failure than the double write this
 * prevents. The lock records its pid so a human reading the directory can tell what left it.
 *
 * Deliberately synchronous, because the callers are. The wait is a bounded spin — this guards a
 * few file operations, not a network call.
 */
export function withExclusiveFileLock<T>(
  path: string,
  fn: () => T,
  opts: { staleMs?: number; timeoutMs?: number; now?: () => number } = {}
): T {
  const lockPath = `${path}.lock`;
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const started = now();

  // The lock lives beside the file it guards, so the directory has to exist before the first
  // acquisition — not after the first write. Taking the lock ahead of `atomicWriteJson`'s own
  // `mkdirSync` meant a first run on a fresh checkout threw ENOENT from the lock, before any of the
  // code that creates the directory could run.
  //
  // **And it carries the same mode as `atomicWriteJson`'s, because it usually wins.** Locking
  // happens before writing on every real path, so this is the call that actually creates the state
  // directory; `atomicWriteJson`'s `existsSync` check then finds it already there and its mode is
  // never applied. Setting the mode in only one of the two left every lock-before-write path with a
  // 0755 directory holding 0600 files — the file permissions looked fixed while the directory they
  // sat in was still world-traversable.
  mkdirSync(dirname(lockPath), { recursive: true, mode: DIR_MODE });

  // A sync sleep without busy-burning a core. `Atomics.wait` on a private buffer is the standard
  // idiom; the buffer is never shared, so nothing can notify it and it always times out.
  const pause = (ms: number): void => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      const until = now() + ms;
      while (now() < until) {
        /* SharedArrayBuffer unavailable — spin, still bounded by timeoutMs */
      }
    }
  };

  const readHolder = (): string | null => {
    try {
      return readFileSync(lockPath, 'utf8');
    } catch {
      return null;
    }
  };

  for (;;) {
    const token = `${process.pid}:${now()}:${Math.random().toString(36).slice(2, 10)}`;

    // ── ACQUIRE ────────────────────────────────────────────────────────────────────────────────
    //
    // **Only `openSync` is inside this try.** It used to wrap the callback too, so a callback that
    // itself threw an `EEXIST` — any code creating a file that already exists — was mistaken for
    // lock contention, retried, and retried: measured at **2,442 executions of the callback**, with
    // the real error swallowed and replaced by a misleading "timed out waiting for lock". For a
    // callback that writes to a tracker that is not a slow failure, it is thousands of writes.
    //
    // The fix is structural rather than a check on the error's shape: the catch cannot see anything
    // but the acquisition, so it cannot misread anything else.
    let fd: number;
    try {
      // Owner-only like everything else here. The token is a pid and a timestamp rather than
      // anything sensitive, but a 0644 file sitting inside a 0700 directory is a loose end that
      // invites the question of which one is the mistake.
      fd = openSync(lockPath, 'wx', FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;

      // ── Breaking a stale lock, safely ────────────────────────────────────────────────────────
      //
      // An earlier version unlinked whatever was at `lockPath` once it looked old. That let a third
      // process in: A holds, B judges it stale and replaces it, C — which had judged the SAME old
      // lock stale — unlinks B's brand-new lock and takes its own. Two live holders, from two
      // individually correct stale judgements about different files.
      //
      // So the identity observed when judging must be the identity deleted. Re-acquisition is `wx`,
      // which is atomic, so even when two processes both break the same stale lock only one gets it.
      //
      // *Residual, stated rather than papered over:* between the identity re-read and the `unlink`
      // there is still a window in which the holder could change. It is a few microseconds against a
      // 30-second staleness threshold, and closing it properly needs an OS-level advisory lock —
      // reasonable for a service, disproportionate for a CLI answering a queue.
      const holder = readHolder();
      let age = 0;
      let vanished = false;
      try {
        age = now() - statSync(lockPath).mtimeMs;
      } catch {
        vanished = true; // gone between the open and the stat
      }

      // The timeout is checked on EVERY path out of here, including the ones that retry immediately.
      // It used to sit below the stale handling, so both `continue`s skipped it — and a lock whose
      // holder kept changing spun forever. Found by a test written for a different bug, which is the
      // usual way liveness failures surface.
      const expired = now() - started > timeoutMs;
      const giveUp = (): never => {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${lockPath} (held ${Math.round(age)}ms by ${holder || 'an unknown process'}). ` +
            'Another process is answering this queue; retry, or remove the lock file if it is orphaned.'
        );
      };

      if (vanished) {
        if (expired) giveUp();
        continue;
      }

      // **An empty lock is judged by its age, like every other lock.**
      //
      // Empty means created but not yet stamped — `openSync` and the token write are two syscalls,
      // and a reader catching the gap must not conclude the holder is dead. That gap is microseconds
      // wide. It used to be excluded from stale-breaking *at every age*, which quietly converted a
      // microsecond window into a permanent one: kill a process between those two syscalls and the
      // empty file it leaves is a lock nobody can ever remove — its creator is gone, and every
      // passer-by is forbidden from touching it. C-01 fixed the case where the write *fails*;
      // nothing in JavaScript runs when the process is killed instead.
      //
      // So the rule is just `age > staleMs`. Thirty seconds between two adjacent syscalls is not a
      // live process, and this is exactly the inference the stale-break already makes for a stamped
      // lock whose holder went quiet. The identity re-read below still applies: `''` is an identity
      // like any other, so a creator that stamps its token in the meantime is no longer a match and
      // does not get unlinked.
      if (holder !== null && age > staleMs) {
        try {
          if (readHolder() === holder) unlinkSync(lockPath);
        } catch {
          /* someone else broke it first */
        }
        if (expired) giveUp();
        continue;
      }

      if (expired) giveUp();
      pause(25);
      continue;
    }

    // ── OWNERSHIP IS PART OF ACQUISITION, NOT BEST EFFORT ──────────────────────────────────────
    //
    // Written immediately, because the identity is what makes stale-breaking safe above. A reader
    // catching the file in the gap sees empty and treats it as fresh, which is right: a file created
    // microseconds ago cannot be stale.
    //
    // **This used to be best-effort, and swallowing the failure created an immortal lock.** With no
    // token on disk the release below (`readHolder() === token`) never matches, so the holder does
    // not remove its own file — and at the time the stale-break skipped empty holders at every age,
    // so nobody else removed it either. Two individually right rules, jointly permanent: one
    // transient ENOSPC and every later mutation of that file timed out until a human deleted the
    // lock by hand. Probed at the time: `openSync` succeeded under a zero-byte output limit, the
    // callback ran, and a retry 30s later with `staleMs: 1` still refused to break the empty lock.
    //
    // The stale-break no longer grants that exemption, so the wedge is recoverable either way. It is
    // still not something to leave lying around: a failure here is a failed acquisition, so undo it
    // and propagate. **Nothing may run under a lock that cannot be released.**
    //
    // The cleanup re-reads before unlinking, exactly like the release path. Ours is microseconds old
    // and cannot yet be stale, so in practice it is always still there — but "cannot be stale yet"
    // is a fact about `staleMs`, and deriving safety from a constant somewhere else is how the pair
    // of rules above became a bug in the first place.
    try {
      writeFileSync(fd, token);
    } catch (err) {
      closeSync(fd);
      try {
        if (readHolder() === '') unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
      throw err;
    }

    // ── HELD. Anything the callback throws is the CALLBACK's, and propagates untouched. ─────────
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        // Only remove OUR lock. If a stale-breaker already took it, the file belongs to someone else
        // and deleting it would drop them out of the critical section.
        if (readHolder() === token) unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}
