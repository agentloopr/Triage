/**
 * The cross-process lock, and the two ways its first version was unsafe.
 *
 * Both were found by an outside audit running probes rather than reading code, which is the only
 * method that has caught anything in this area.
 */
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('treats an empty lock as fresh, not as stale', () => {
    // There is a window between `openSync(wx)` and writing the token. A reader catching the file in
    // that gap must not conclude the holder is dead — it was created microseconds ago.
    writeFileSync(LOCK, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(LOCK, old, old);
    expect(() => withExclusiveFileLock(FILE, () => 'never', { staleMs: 1_000, timeoutMs: 60 })).toThrow(/timed out/);
  });
});
