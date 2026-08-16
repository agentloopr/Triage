/**
 * The cross-process lock, and the two ways its first version was unsafe.
 *
 * Both were found by an outside audit running probes rather than reading code, which is the only
 * method that has caught anything in this area.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one thing here that cannot be arranged with real files: a write to the lock's own descriptor
 * failing. `vi.spyOn` cannot touch an ESM namespace, so `node:fs` is wrapped instead — pass-through
 * in every case except an fd write while the flag below is set. `atomicWriteJson` writes to a
 * *path*, so nothing else in this file or in the code under test changes behaviour.
 */
const ctl = vi.hoisted(() => ({ failFdWrite: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const write = actual.writeFileSync as (...args: unknown[]) => void;
  return {
    ...actual,
    writeFileSync: (target: unknown, ...rest: unknown[]) => {
      if (ctl.failFdWrite && typeof target === 'number') {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return write(target, ...rest);
    },
  };
});

import { withExclusiveFileLock } from './jsonStore';

const DIR = join(tmpdir(), `file-lock-${process.pid}`);
const FILE = join(DIR, 'state.json');
const LOCK = `${FILE}.lock`;

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe('withExclusiveFileLock', () => {
  /**
   * The lock creates the state directory, so the lock is what decides its permissions.
   *
   * `atomicWriteJson` was given `mode: 0o700` and that looked like the fix. It was not: locking
   * happens before writing on every real path, so this `mkdirSync` runs first, and the writer's
   * `existsSync` check then finds the directory already present and never applies its mode. The
   * result was 0600 files inside a 0755 directory — the permissions that were easy to check were
   * right, and the one that actually gates access to them was not.
   *
   * Asserted on the mode bits of a directory created BY the lock, on a path where nothing else has
   * run, because that is the only arrangement that can tell the two fixes apart.
   */
  it('creates the state directory owner-only, not just the files in it', () => {
    const fresh = join(DIR, 'brand', 'new', 'state.json');
    withExclusiveFileLock(fresh, () => 'ran');

    const mode = statSync(join(DIR, 'brand', 'new')).mode & 0o777;
    expect(mode.toString(8), 'state directory is traversable by other local users').toBe('700');
  });

  /**
   * ...and a directory that ALREADY exists at 0755 gets tightened, which the create-time mode
   * could never do.
   *
   * `mkdirSync`'s `mode` applies only on creation. Setting it fixed fresh checkouts and left every
   * existing deployment exactly as it was — the state directory from before the fix, or from
   * someone's `mkdir -p`, stayed world-traversable forever while the files inside it were 0600.
   * "The new path is secure" is not the same claim as "the deployment is secure".
   */
  it('tightens a pre-existing world-traversable state directory', () => {
    const dir = join(DIR, 'preexisting');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755); // explicit: mkdirSync's mode is masked by the umask

    withExclusiveFileLock(join(dir, 'state.json'), () => 'ran');

    expect((statSync(dir).mode & 0o777).toString(8), 'a pre-existing 0755 directory was left open').toBe('700');
  });

  it('creates the directory rather than throwing ENOENT on a fresh checkout', () => {
    // The lock is taken BEFORE `atomicWriteJson`, which is the code that used to create the
    // directory — so the very first run on a clean machine died in the lock.
    const fresh = join(DIR, 'nested', 'deeper', 'state.json');
    expect(withExclusiveFileLock(fresh, () => 'ran')).toBe('ran');
  });

  it('releases the lock afterwards, including when the body throws', () => {
    withExclusiveFileLock(FILE, () => 'ok');
    expect(existsSync(LOCK)).toBe(false);

    expect(() => withExclusiveFileLock(FILE, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(LOCK)).toBe(false);
  });

  it("does not mistake the CALLBACK's EEXIST for lock contention", () => {
    // The catch used to wrap the callback as well as the acquisition, so a callback that threw an
    // `EEXIST` — any code creating a file that already exists — was read as contention and retried.
    // Measured at 2,442 executions of the callback, with the real error swallowed and replaced by a
    // misleading "timed out waiting for lock". For a callback that writes to a tracker, that is not
    // a slow failure; it is thousands of writes.
    let runs = 0;
    expect(() =>
      withExclusiveFileLock(
        FILE,
        () => {
          runs++;
          const err = new Error('the callback made a file that already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        },
        { timeoutMs: 200 }
      )
    ).toThrow('the callback made a file that already exists'); // the real error, not a lock timeout

    expect(runs, 'the callback must run exactly once').toBe(1);
    expect(existsSync(LOCK), 'and the lock must still be released').toBe(false);
  });

  it('refuses to enter while another holder is live, and says who has it', () => {
    writeFileSync(LOCK, 'pid-999:held');
    expect(() => withExclusiveFileLock(FILE, () => 'never', { timeoutMs: 60 })).toThrow(/timed out.*pid-999/s);
  });

  it('breaks a genuinely stale lock', () => {
    writeFileSync(LOCK, 'pid-999:dead');
    const old = new Date(Date.now() - 60_000);
    utimesSync(LOCK, old, old);
    expect(withExclusiveFileLock(FILE, () => 'took it', { staleMs: 1_000 })).toBe('took it');
  });

  it('does NOT delete a lock that changed hands since it was judged stale', () => {
    // The third-process bug: A holds, B judges it stale and replaces it, C — which judged the SAME
    // old lock stale — deletes B's brand-new lock and enters. Two live holders, from two
    // individually correct stale judgements about two different files.
    //
    // The first version of THIS test swapped in a new holder and let its mtime be fresh, so it
    // passed for the wrong reason — freshness saved the lock, not the ownership check, and it went
    // on passing with the check deleted. Mutation-testing caught that. Here the holder changes on
    // every clock read and every version of it is stale, so ONLY re-verifying identity before the
    // unlink can prevent the theft.
    const stale = new Date(Date.now() - 60_000);
    writeFileSync(LOCK, 'holder-0');
    utimesSync(LOCK, stale, stale);

    let n = 0;
    const now = (): number => {
      if (existsSync(LOCK)) {
        writeFileSync(LOCK, `holder-${++n}`);
        utimesSync(LOCK, stale, stale); // always old: staleness never rescues it
      }
      return Date.now();
    };

    expect(
      () => withExclusiveFileLock(FILE, () => 'stolen', { staleMs: 1_000, timeoutMs: 80, now }),
      'the lock was taken while its holder kept changing — identity was not re-checked before unlink'
    ).toThrow(/timed out/);
    expect(existsSync(LOCK)).toBe(true); // still held by whoever last wrote it
  });

  it('treats a NEW empty lock as fresh, not as stale', () => {
    // There is a window between `openSync(wx)` and writing the token. A reader catching the file in
    // that gap must not conclude the holder is dead — it was created microseconds ago.
    writeFileSync(LOCK, '');
    expect(() => withExclusiveFileLock(FILE, () => 'never', { staleMs: 1_000, timeoutMs: 60 })).toThrow(/timed out/);
  });

  /**
   * ...and an OLD empty lock is a creator that died before it could stamp itself.
   *
   * **This test asserted the opposite for one round.** "Empty means freshly created" was treated as
   * true at every age, which turned the microsecond gap above into a permanent one: kill a process
   * between `openSync` and the token write, and the file it leaves behind is a lock nobody may
   * remove — the creator is gone and every passer-by is forbidden to touch it. C-01 covered the
   * token write *failing*; no cleanup code runs at all when the process is killed instead.
   *
   * Thirty seconds between two adjacent syscalls is not a live process. This is the same inference
   * the stale-break already makes about a stamped lock whose holder went quiet, so it adds no new
   * assumption — it removes an exemption.
   */
  it('breaks an empty lock once it is older than a live acquisition could be', () => {
    writeFileSync(LOCK, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(LOCK, old, old);
    expect(withExclusiveFileLock(FILE, () => 'recovered', { staleMs: 1_000, timeoutMs: 200 })).toBe('recovered');
    expect(existsSync(LOCK)).toBe(false);
  });

  /**
   * The rule above, plus a best-effort token write, used to make a lock nobody could ever remove.
   *
   * A holder releases only what it can identify as its own (`readHolder() === token`), and the
   * stale-break refuses to touch an empty holder — both correct in isolation. With the token write
   * swallowed, the file stays empty forever: its owner will not delete it, and no one else is
   * allowed to. One transient ENOSPC and every later mutation of that file times out until a human
   * finds the lock file. The audit reproduced it under a zero-byte output limit; here the write is
   * made to fail directly, which is the same event with less ceremony.
   *
   * Only the fd write is broken — `atomicWriteJson` passes a path — so this is about the lock alone.
   */
  it('fails acquisition, rather than the callback, when ownership cannot be recorded', () => {
    let ran = false;
    ctl.failFdWrite = true;
    try {
      expect(() => withExclusiveFileLock(FILE, () => { ran = true; return 'x'; })).toThrow(/ENOSPC/);
    } finally {
      ctl.failFdWrite = false;
    }

    // Nothing may run under a lock that cannot be released.
    expect(ran, 'the callback ran while ownership was unrecorded').toBe(false);
    // And the failure must be transient — no immortal empty lock left behind.
    expect(existsSync(LOCK), 'an unreleasable empty lock survived the failure').toBe(false);
    expect(withExclusiveFileLock(FILE, () => 'recovered')).toBe('recovered');
  });
});
