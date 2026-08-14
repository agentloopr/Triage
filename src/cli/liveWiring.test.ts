/**
 * The live path must SUPPLY the stores it depends on — asserted by calling the builder, not by
 * reading its source.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 *
 * `reachable.test.ts` catches a module nothing outside a test imports. `pull.ts` passed it: it
 * imported the pipeline, the clients and the normalizers, and every one of them ran. What it did
 * *not* do was pass `pendingHuman`, `roleState`, a persistent idempotency store, or the OTel
 * decorators — all four of which the fixture runner supplies.
 *
 * The consequence was not subtle. **The only command that can write to a real tracker announced a
 * human hold and then dropped it**, because `runPipeline` persists holds only when handed a store.
 * `npm run answer` read an always-empty file. Every existing test passed, because every existing
 * test uses the fixture runner, which wires all four.
 *
 * That is a second species of the repo's recurring defect. The first was *unreachable* code. This
 * one is reachable code that is never **supplied**, and no reachability analysis can see it: an
 * optional dependency left out looks exactly like one deliberately declined.
 *
 * **The first version of this test read `pull.ts` and matched regular expressions.** An outside
 * audit pointed out that presence is not behaviour — it would have passed with the calls sitting in
 * a dead branch, a comment or a string literal. So the construction moved into `buildLiveDeps`, and
 * this calls it against a temp directory and asserts on the objects that come back. No credential,
 * no network, no live service.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PipelineEvents } from '../pipeline/events';
import type { CompletionResult, ModelClient } from '../providers';
import { memoryTracker } from '../trackers/memory';
import { buildLiveDeps } from './liveDeps';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-deps-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stub: ModelClient = {
  name: 'stub',
  complete: async (): Promise<CompletionResult> => ({ text: 'ok', model: 'm', provider: 'stub' }),
};

const build = (write: boolean) =>
  buildLiveDeps({
    tracker: memoryTracker({ tasks: [] }),
    model: stub,
    events: new PipelineEvents(),
    write,
    paths: {
      idempotency: join(dir, 'idem.json'),
      idempotencyPlan: join(dir, 'idem-plan.json'),
      pendingHuman: join(dir, 'holds.json'),
      roleStateDir: join(dir, 'roles'),
    },
  });

describe('a live run is given every store it needs', () => {
  it('supplies a hold store that actually persists, not an absent one', async () => {
    const { deps } = build(true);
    expect(deps.pendingHuman).toBeDefined();

    // The property, not the presence: register a hold, then read it back through a SECOND store on
    // the same path. An in-memory stand-in passes the first assertion and fails this one.
    deps.pendingHuman!.register('src-1', [
      { item: 1, title: 'Add rate limiting', category: 'NEW_TASK', gate: 'uncertain field(s)', question: 'who owns this?' },
    ]);
    const reopened = build(true).deps.pendingHuman!;
    expect(reopened.list().map((h) => h.title)).toEqual(['Add rate limiting']);
  });

  it('supplies idempotency that survives the process, not a memory store', async () => {
    const { deps } = build(true);
    expect(await deps.idempotency.checkAndMark('source', 'src-1')).toBeNull(); // first sight
    // A fresh builder is the stand-in for a fresh process. `memoryStore()` forgets here; a file does not.
    expect(await build(true).deps.idempotency.checkAndMark('source', 'src-1')).not.toBeNull();
  });

  it('keeps planning and writing in separate idempotency namespaces', async () => {
    // A dry run must not consume the source key and turn the following `--write` into a silent
    // no-op — "I planned it, then it refused to do it" is the worst outcome for a look-before-you-leap
    // flag.
    expect(await build(false).deps.idempotency.checkAndMark('source', 'src-1')).toBeNull();
    // Seen in the PLAN namespace; the write namespace must not know about it.
    expect(await build(true).deps.idempotency.checkAndMark('source', 'src-1')).toBeNull();
  });

  it('supplies a role-state store that writes where it says it does', () => {
    const { deps } = build(true);
    expect(deps.roleState).toBeDefined();
    deps.roleState!.record('engineer', [{ title: 'Add rate limiting', at: '2026-01-01T00:00:00.000Z' }]);
    expect(existsSync(join(dir, 'roles', 'engineer.json'))).toBe(true);
  });

  it('decorates the model client rather than handing the raw one through', async () => {
    const { model } = build(true);
    expect(model).not.toBe(stub);
    expect(model.name).toBe(stub.name); // the decorator is transparent to callers
    expect((await model.complete({ key: 'k', messages: [{ role: 'user', content: 'hi' }] })).text).toBe('ok');
  });

  it('attaches an event tracer, and returns the handle that detaches it', () => {
    // Asserted through behaviour: the tracer must not throw on a real event, and detaching must be
    // callable without one. A leaked listener in a long-lived process is the failure this returns for.
    const events = new PipelineEvents();
    const { untrace } = buildLiveDeps({
      tracker: memoryTracker({ tasks: [] }),
      model: stub,
      events,
      write: false,
      paths: { pendingHuman: join(dir, 'h.json'), idempotencyPlan: join(dir, 'i.json'), roleStateDir: join(dir, 'r') },
    });

    expect(() => events.emit({ type: 'pass:start', pass: '0-cleanup' })).not.toThrow();
    expect(() => events.emit({ type: 'pass:done', pass: '0-cleanup', ms: 1 })).not.toThrow();
    expect(typeof untrace).toBe('function');
    expect(() => untrace()).not.toThrow();
  });

  it('sets execute from the write flag, so a plan cannot write', () => {
    expect(build(false).deps.execute).toBe(false);
    expect(build(true).deps.execute).toBe(true);
  });
});
