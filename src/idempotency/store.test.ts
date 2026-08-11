import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type IdempotencyStore, type Layer, DEFAULT_TTLS, contentKey } from './index';
import { memoryStore } from './memory';
import { jsonFileStore } from './jsonFile';
import { setCorruptFileNotifier } from '../state/jsonStore';

const DIR = join(tmpdir(), `idem-test-${process.pid}`);
const FILE = join(DIR, 'seen.json');
const LAYERS: Layer[] = ['event', 'source', 'content'];

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => {
  setCorruptFileNotifier(null);
  rmSync(DIR, { recursive: true, force: true });
});

// One suite, both implementations — a store that behaves differently depending on where it persists
// is not an abstraction. `now` is injected so TTL tests don't sleep.
const IMPLS: [string, (now: () => number) => IdempotencyStore][] = [
  ['memoryStore', (now) => memoryStore({ now })],
  ['jsonFileStore', (now) => jsonFileStore(FILE, { now })],
];

describe.each(IMPLS)('%s', (_name, make) => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const now = () => clock;

  beforeEach(() => {
    clock = Date.parse('2026-01-01T00:00:00.000Z');
  });

  it.each(LAYERS)('marks %s once: first call null, second returns the prior record', async (layer) => {
    const store = make(now);
    expect(await store.checkAndMark(layer, 'k1')).toBeNull();

    const second = await store.checkAndMark(layer, 'k1');
    expect(second).not.toBeNull();
    expect(second?.layer).toBe(layer);
    expect(second?.key).toBe('k1');
  });

  it('keeps layers independent — the same key in two layers is two facts', async () => {
    const store = make(now);
    expect(await store.checkAndMark('event', 'same')).toBeNull();
    expect(await store.checkAndMark('source', 'same')).toBeNull();
    expect(await store.checkAndMark('event', 'same')).not.toBeNull();
  });

  it('forgets a key so it can be processed again', async () => {
    const store = make(now);
    await store.checkAndMark('source', 'k');
    await store.forget('source', 'k');
    expect(await store.checkAndMark('source', 'k')).toBeNull();
  });

  it('expires a mark once its layer TTL has passed', async () => {
    const store = make(now);
    await store.checkAndMark('event', 'k');

    clock += DEFAULT_TTLS.event - 1;
    expect(await store.checkAndMark('event', 'k')).not.toBeNull(); // still inside the window

    clock += 2;
    expect(await store.checkAndMark('event', 'k')).toBeNull(); // window passed
  });

  it('uses the per-layer TTL, not one global one', async () => {
    const store = make(now);
    await store.checkAndMark('event', 'k');
    await store.checkAndMark('source', 'k');

    clock += DEFAULT_TTLS.event + 1; // past event's 15m, far short of source's 48h
    expect(await store.checkAndMark('event', 'k')).toBeNull();
    expect(await store.checkAndMark('source', 'k')).not.toBeNull();
  });

  it('prunes only expired records', async () => {
    const store = make(now);
    await store.checkAndMark('event', 'short');
    await store.checkAndMark('source', 'long');

    clock += DEFAULT_TTLS.event + 1;
    await store.prune();

    expect(await store.checkAndMark('event', 'short')).toBeNull(); // pruned → treated as new
    expect(await store.checkAndMark('source', 'long')).not.toBeNull(); // survived
  });

  // The race the single-method design exists to close: `has()` then `mark()` would let both of these
  // through, and the same meeting would be processed twice.
  it('marks once under concurrent calls for the same key', async () => {
    const store = make(now);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.checkAndMark('event', 'stampede'))
    );
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it('carries meta through to the prior record', async () => {
    const store = make(now);
    await store.checkAndMark('content', 'k', { sourceId: 'meeting-42' });
    expect((await store.checkAndMark('content', 'k'))?.meta).toEqual({ sourceId: 'meeting-42' });
  });
});

describe('jsonFileStore durability', () => {
  it('survives a restart — a new instance on the same path still knows', async () => {
    const first = jsonFileStore(FILE);
    expect(await first.checkAndMark('source', 'meeting-1')).toBeNull();

    const afterRestart = jsonFileStore(FILE); // fresh instance, no shared memory
    expect(await afterRestart.checkAndMark('source', 'meeting-1')).not.toBeNull();
  });

  it('never leaves a .tmp file behind on a normal write', async () => {
    const store = jsonFileStore(FILE);
    await store.checkAndMark('event', 'k');
    expect(readdirSync(DIR).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  // Silently starting empty is the failure this guards: the state is gone, nothing says so, and the
  // next write persists the emptiness as the new truth.
  it('quarantines a corrupt file loudly instead of starting empty in silence', async () => {
    writeFileSync(FILE, '{ this is not json', 'utf8');
    const reports: string[] = [];
    setCorruptFileNotifier((m) => reports.push(m));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = jsonFileStore(FILE);
    expect(await store.checkAndMark('source', 'k')).toBeNull(); // starts empty, as it must

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('CORRUPT');
    expect(readdirSync(DIR).some((f) => f.includes('.corrupt-'))).toBe(true);
    expect(existsSync(FILE)).toBe(true); // and the store rewrote a clean one
    vi.restoreAllMocks();
  });
});

describe('contentKey', () => {
  it('is stable for identical text and differs for any change', () => {
    expect(contentKey('hello world')).toBe(contentKey('hello world'));
    expect(contentKey('hello world')).not.toBe(contentKey('hello world '));
    expect(contentKey('a')).toHaveLength(32);
  });
});
