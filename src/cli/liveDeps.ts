/**
 * The dependency set a LIVE run gets — as a function, so it can be inspected without a network.
 *
 * ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────────────────────────
 *
 * `pull.ts` built this inline, and for the whole of Phase 7 it built it *wrong*: an in-memory
 * idempotency store, no `pendingHuman`, no `roleState`, no OTel — every one of which the fixture
 * runner supplies. The consequence was that **the only command able to write to a real tracker
 * announced a human hold and then dropped it**, and `npm run answer` read a file nothing ever wrote.
 *
 * The first attempt at a guard read `pull.ts` with regular expressions and asserted the calls were
 * present. That is presence, not behaviour: it would pass with the calls sitting in a dead branch,
 * a comment or a string. An outside audit said so, and it was right.
 *
 * So the construction lives here and returns a plain object. A test can call it with a temp
 * directory and assert on what comes back — the actual stores, the actual decorated client — with no
 * credential, no network and no live service. The thing being protected is precisely the code path
 * that cannot run in CI, so it has to be separable from the thing that runs it.
 */

import {
  IDEMPOTENCY_PATH,
  IDEMPOTENCY_PLAN_PATH,
  PENDING_HUMAN_PATH,
} from '../config';
import { jsonFileStore } from '../idempotency/jsonFile';
import { traceEvents, traceModelClient } from '../observability/otel';
import type { PipelineEvents } from '../pipeline/events';
import type { PipelineDeps } from '../pipeline/run';
import type { ModelClient } from '../providers';
import { pendingHumanStore } from '../state/pendingHuman';
import { fileRoleStateStore } from '../state/roleState';
import type { TrackerAdapter } from '../trackers';

/**
 * How long startup pruning will wait for the lock before giving up.
 *
 * Short on purpose. Contention means another process holds this file — pruning it, or just marking
 * a delivery — and waiting out the default 5s to drop expired records is the wrong trade for a run
 * with real work to do. The next startup prunes anyway; nothing is lost by giving up.
 */
const PRUNE_LOCK_TIMEOUT_MS = 250;

export type LiveDepsInput = {
  tracker: TrackerAdapter;
  model: ModelClient;
  events: PipelineEvents;
  /** True for `--write`. Selects the idempotency namespace and the pipeline's execute flag. */
  write: boolean;
  /** Overridable for tests. Production passes nothing and gets the configured paths. */
  paths?: { idempotency?: string; idempotencyPlan?: string; pendingHuman?: string; roleStateDir?: string };
};

/** The decorated model plus every store a live run must persist through. */
export type LiveDeps = {
  model: ModelClient;
  deps: Pick<PipelineDeps, 'tracker' | 'idempotency' | 'pendingHuman' | 'roleState' | 'events' | 'execute'>;
  /** Detaches the event tracer. */
  untrace: () => void;
};

export function buildLiveDeps(input: LiveDepsInput): LiveDeps {
  const p = input.paths ?? {};

  // Spans on the one path that touches live systems. This was the path that had none: the seam was
  // built, tested, and wired into the *fixture* runner only, so "OTel ships" was true and useless.
  const untrace = traceEvents(input.events);
  const model = traceModelClient(input.model);

  // Persistent, and split by mode. An in-memory store forgot every key when the process exited, so
  // the three-layer idempotency the README leads with protected nothing here. Plan and write use
  // separate files so a dry run cannot silently suppress the `--write` that follows it.
  const idempotencyPath = input.write
    ? (p.idempotency ?? IDEMPOTENCY_PATH)
    : (p.idempotencyPlan ?? IDEMPOTENCY_PLAN_PATH);
  const idempotency = jsonFileStore(idempotencyPath);

  // **Expired records are dropped here or nowhere.** `prune` was implemented, unit-tested and on the
  // interface — and called by nothing outside its own test. Expiry is checked only when the same key
  // comes back, so a key seen once and never again stays forever, and every new source writes three
  // of them. That is unbounded disk and parse cost; worse, the cross-process lock is held for the
  // length of a read-modify-write, so an unbounded file is an unbounded contention window.
  //
  // Startup is the boundary: one pass, before the run, under the same lock as every other mutation.
  //
  // **It blocks, and the first version of this comment claimed it did not.** `prune` is `async` but
  // its body is entirely synchronous — lock, parse, mutate, write, all before the promise settles —
  // so dropping the `await` moved nothing into the background. Measured with the lock held by
  // another process, `buildLiveDeps` returned after 5,020ms: the whole acquisition timeout, spent
  // inside a call documented as non-blocking. "Not awaited" and "not blocking" are not the same
  // claim, and only one of them was true.
  //
  // So the bound is made explicit rather than described away: a separate handle with a short
  // timeout, and fail-open on top of it.
  void jsonFileStore(idempotencyPath, { lock: { timeoutMs: PRUNE_LOCK_TIMEOUT_MS } })
    .prune()
    .catch((err: unknown) => {
      console.warn(`[idempotency] could not prune expired records: ${(err as Error)?.message ?? err}`);
    });

  return {
    model,
    untrace,
    deps: {
      tracker: input.tracker,
      idempotency,
      // `npm run answer` reads this exact path. With no store supplied, the pipeline held items in
      // memory and exited.
      pendingHuman: pendingHumanStore(p.pendingHuman ?? PENDING_HUMAN_PATH),
      roleState: fileRoleStateStore(p.roleStateDir),
      events: input.events,
      execute: input.write,
    },
  };
}
