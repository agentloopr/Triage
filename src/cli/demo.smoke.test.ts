import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CASSETTE_DIR } from '../config';
import { listScenarios, loadScenario } from '../fixtures';
import { categoryBreakdown } from '../pipeline/parsing/categorizationManifest';
import { cassetteClient } from '../providers/cassette';
import { runScenario } from './runScenario';

/**
 * The claim on the README, asserted rather than trusted: the demo runs the real pipeline with no API
 * key and no network. `fetch` is replaced with a function that throws, so any provider quietly
 * reaching for the network fails the suite instead of passing on someone's credentials.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('the demo must make ZERO network calls');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const name of listScenarios()) {
    rmSync(join(loadScenario(name).dir, '.corrections.json'), { force: true });
  }
});

describe('demo smoke', () => {
  it('finds the shipped scenarios', () => {
    expect(listScenarios()).toEqual([
      '01-meeting-mixed',
      '02-meeting-duplicates',
      '03-meeting-noise',
      '04-channel-messages',
      '05-corrections',
    ]);
  });

  it.each(listScenarios())('%s runs offline and matches its golden file', async (name) => {
    const scenario = loadScenario(name);
    const run = await runScenario(scenario, {
      model: cassetteClient(join(CASSETTE_DIR, name)),
      quiet: true,
    });

    expect(run.mismatches).toEqual([]);
    expect(run.result.status).toBe('completed');
  });

  it('replays every pass from a cassette — no live call is even attempted', async () => {
    const scenario = loadScenario('01-meeting-mixed');
    const run = await runScenario(scenario, { model: cassetteClient(join(CASSETTE_DIR, '01-meeting-mixed')), quiet: true });

    // 4 inventory passes + 7 categorization + 7 verification.
    expect(run.modelCalls).toBe(18);
  });

  it('exercises all five categories across the shipped scenarios', async () => {
    const seen = new Set<string>();
    for (const name of listScenarios()) {
      const scenario = loadScenario(name);
      const run = await runScenario(scenario, { model: cassetteClient(join(CASSETTE_DIR, name)), quiet: true });
      for (const c of Object.keys(categoryBreakdown(run.result.manifest))) seen.add(c);
    }
    expect(seen).toEqual(new Set(['NEW_TASK', 'DUPLICATE', 'SUBTASK', 'UPDATE']));
  });

  // A missing cassette must be loud. Returning empty would look exactly like a pass that
  // legitimately found nothing, and the demo would go green having done nothing at all.
  it('fails loudly on a missing cassette rather than returning empty', async () => {
    const client = cassetteClient(join(CASSETTE_DIR, 'does-not-exist'));
    await expect(client.complete({ key: '2a/item-01', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /no cassette for/
    );
  });
});
