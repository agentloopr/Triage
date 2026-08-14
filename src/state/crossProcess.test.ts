/**
 * The state files, hit by real processes at the same instant.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
 *
 * Every other test in this repo runs in one process, and **an in-process lock is indistinguishable
 * from a cross-process one when there is only one process.** That is not a gap in coverage, it is a
 * gap in what the harness can observe at all: `makeFifoLock` ordered promises, the tests were
 * single-threaded, and so the tests agreed the store was safe for as long as it wasn't.
 *
 * An outside audit spawned processes and found what one process cannot see. Measured against the
 * code before this file, 20 workers racing one delivery key through the persistent idempotency
 * store:
 *
 *   empty state file          2–4 of 20 accepted the same delivery as new
 *   75,000-record state file  **20 of 20**, in five rounds out of five
 *
 * The second row is the one that matters, and the file only ever grows in the direction of the
 * second row: the read-modify-write window scales with parse time. `npm run pull -- --write` uses
 * this store, so that was every concurrent worker passing idempotency and writing the same cards —
 * under a README that leads with three-layer idempotency.
 *
 * So the assertions here are about **effect across processes**, and the only honest way to make
 * them is to start processes. Every worker signals ready and then waits to be released together,
 * because process startup jitter is otherwise generous enough to serialize the workers for us and
 * hand back a green run that proves nothing — see `race` for the two ways that went wrong.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_OPEN_ITEMS } from './roleState';

const REPO = join(__dirname, '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');

/** Enough to collide reliably; small enough that the boot cost stays in the tens of seconds. */
const WORKERS = 16;
/** How long to wait for every worker to report ready. Exceeded means a broken run, not a slow one. */
const READY_TIMEOUT_MS = 60_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cross-process-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `act` in `count` separate processes, all released at the same instant.
 *
 * Both halves are source text, not closures — they are compiled in another process and share
 * nothing with this one, which is the entire point.
 *
 * **`setup` runs before the barrier and `act` after it, and that split is load-bearing.** The first
 * version of this helper put the imports inside the raced body, so each worker was still compiling
 * `roleState.ts` when the barrier fell and the compile jitter — hundreds of milliseconds, and
 * uneven — spread the workers out far enough that they never touched the file at the same time. It
 * ran green against code with no lock at all, three times over, at 5, 8 and 16 workers. A
 * concurrency test that quietly serializes its own workers is the exact failure it exists to catch,
 * wearing a tick.
 *
 * **The barrier is an acknowledgement, not a deadline, for the same reason.** Moving the imports
 * earlier fixed the *typical* case and left the mechanism unchanged: a fixed start time assumes
 * every child is ready by then, which a loaded CI runner does not owe us. Demonstrated by skewing
 * worker readiness past the deadline — the workers ran in sequence and the critical test passed
 * against code with no lock. So each child now signals ready and spins on a release file, the parent
 * waits for every signal before writing it, and a child that never reports is a loud failure rather
 * than a silent serialization.
 */
async function race(setup: string, act: string, count = WORKERS): Promise<string[]> {
  const worker = join(dir, 'worker.mts'); // .mts, not .ts: the repo is CJS, and tsx refuses top-level await there
  const go = join(dir, 'go');
  writeFileSync(
    worker,
    `export {};\n` + // forces ESM, so the top-level await below is legal
      `import { existsSync as __exists, writeFileSync as __write } from 'node:fs';\n` +
      `const [dir, n] = process.argv.slice(2);\n` +
      `const index = Number(n);\n` +
      `${setup}\n` +
      // Ready only once every import above has been compiled and evaluated.
      `__write(dir + '/ready-' + index, '');\n` +
      // A synchronous spin, so nothing still on the event loop can delay the release, and a 1ms
      // granularity so the whole cohort enters `act` within about a millisecond of each other.
      `while (!__exists(dir + '/go')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);\n` +
      `try {\n  const out = await (async () => {\n${act}\n  })();\n` +
      `  process.stdout.write(String(out ?? ''));\n` +
      `} catch (err) {\n  process.stdout.write('ERR:' + ((err as Error)?.message ?? err));\n}\n` +
      `process.exit(0);\n`
  );

  const runs = Array.from(
    { length: count },
    (_, i) =>
      new Promise<string>((resolve) =>
        execFile(TSX, [worker, dir, String(i)], { cwd: REPO }, (err, stdout) =>
          resolve(err ? `ERR:${err.message}` : stdout.trim())
        )
      )
  );

  const ready = (): number =>
    Array.from({ length: count }, (_, i) => existsSync(join(dir, `ready-${i}`))).filter(Boolean).length;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (ready() < count) {
    if (Date.now() > deadline) {
      writeFileSync(go, ''); // release the ones that did start, so nothing hangs
      throw new Error(`only ${ready()} of ${count} workers signalled ready within ${READY_TIMEOUT_MS}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  writeFileSync(go, '');

  return Promise.all(runs);
}

const TIMEOUT = 90_000;

describe('state survives a second process', () => {
  /**
   * The release blocker, as an assertion.
   *
   * The state file is grown to 40,000 records first, and that is not a contrived shape — `prune` had
   * no caller outside its own test until this round, so unique keys accumulated for the life of the
   * deployment. A big file is the normal steady state, and it is where the failure was total rather
   * than occasional.
   */
  it(
    'lets exactly one of sixteen processes claim a delivery key',
    async () => {
      const path = join(dir, 'idem.json');
      const seed: Record<string, unknown> = {};
      for (let i = 0; i < 40_000; i++) {
        seed[`event:filler-${i}`] = { layer: 'event', key: `filler-${i}`, seenAt: new Date().toISOString() };
      }
      writeFileSync(path, JSON.stringify(seed));

      const out = await race(
        `const { jsonFileStore } = await import(${JSON.stringify(join(REPO, 'src/idempotency/jsonFile.ts'))});
         const store = jsonFileStore(dir + '/idem.json', { lock: { timeoutMs: 60000 } });`,
        `return (await store.checkAndMark('source', 'delivery-1')) === null ? 'NEW' : 'SEEN';`
      );

      expect(out.filter((o) => o.startsWith('ERR'))).toEqual([]);
      expect(out.filter((o) => o === 'NEW')).toHaveLength(1);
    },
    TIMEOUT
  );

  /**
   * A correction the CLI acknowledges and then drops is the worst shape this store has: the human
   * believes the pipeline has been told, and the next run repeats the decision they overrode. One
   * distinct note per worker goes in; every one must be readable afterwards.
   */
  it(
    'keeps every correction when sixteen processes record at once',
    async () => {
      const path = join(dir, 'corrections.json');

      const out = await race(
        `const c = await import(${JSON.stringify(join(REPO, 'src/state/corrections.ts'))});
         c.setCorrectionsPath(dir + '/corrections.json');`,
        `await c.recordCorrection({ kind: 'note', text: 'fact-' + index }, 'tester');
         return 'OK';`
      );

      expect(out.filter((o) => o.startsWith('ERR'))).toEqual([]);
      const notes = (JSON.parse(readFileSync(path, 'utf8')) as { notes: { text: string }[] }).notes;
      expect(new Set(notes.map((n) => n.text)).size).toBe(WORKERS);
    },
    TIMEOUT
  );

  /**
   * Role memory merges into a five-item cap, so a lost update here is not an error anywhere — it is
   * a prompt that quietly knows less than it should. Exactly as many writers as slots: every one must
   * be present at the end, which is only true if each read-modify-write saw the one before it.
   */
  it(
    'fills the role-memory cap rather than losing merges',
    async () => {
      mkdirSync(join(dir, 'roles'), { recursive: true });

      const out = await race(
        `const r = await import(${JSON.stringify(join(REPO, 'src/state/roleState.ts'))});
         r.setRoleStateDir(dir + '/roles');`,
        `r.recordRoleWork('engineer', [{ title: 'work-' + index, at: new Date().toISOString() }]);
         return 'OK';`,
        MAX_OPEN_ITEMS
      );

      expect(out.filter((o) => o.startsWith('ERR'))).toEqual([]);
      const state = JSON.parse(readFileSync(join(dir, 'roles', 'engineer.json'), 'utf8')) as {
        openItems: { title: string }[];
      };
      expect(new Set(state.openItems.map((i) => i.title)).size).toBe(MAX_OPEN_ITEMS);
    },
    TIMEOUT
  );

  /**
   * The roster mutator, which no shipped CLI calls — and that is a reason to test it here, not a
   * reason to skip it. It is exported for a consumer building their own admin command, so the first
   * person to hit concurrent writes is someone this repo never sees, debugging a roster that quietly
   * forgot half its additions.
   */
  it(
    'keeps every roster addition when sixteen processes mutate at once',
    async () => {
      const path = join(dir, 'ops-registry.json');
      writeFileSync(path, JSON.stringify({ version: 1, members: [], routes: [], log: [] }));

      const out = await race(
        `const reg = await import(${JSON.stringify(join(REPO, 'src/registry/opsRegistry.ts'))});
         const path = dir + '/ops-registry.json';`,
        `await reg.mutateRegistry((r) => {
           r.members.push({ name: 'Member ' + index, role: 'engineer', externalIds: {} });
           return 'added ' + index;
         }, 'tester', path);
         return 'OK';`
      );

      expect(out.filter((o) => o.startsWith('ERR'))).toEqual([]);
      const members = (JSON.parse(readFileSync(path, 'utf8')) as { members: { name: string }[] }).members;
      expect(new Set(members.map((m) => m.name)).size).toBe(WORKERS);
    },
    TIMEOUT
  );
});
