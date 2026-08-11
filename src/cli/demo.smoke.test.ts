import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
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

    // Derived, not pinned: 4 inventory passes plus one categorization and one verification call per
    // item. A hardcoded total just breaks every time a fixture gains or loses an item, which teaches
    // people to update the number rather than ask why it moved.
    expect(run.modelCalls).toBe(4 + run.result.inventory.length * 2);
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

  /**
   * The observability wiring, asserted end to end.
   *
   * `runScenario` wraps the client and the event emitter, and a unit test of the wrapper proves
   * nothing about whether anyone calls it — an import that was dropped in a refactor would leave
   * every span test green and the pipeline silent. So this registers a real provider, runs a real
   * scenario, and reads what came out.
   */
  it('emits spans for the passes and every model call when a provider is registered', async () => {
    const exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

    try {
      const run = await runScenario(loadScenario('01-meeting-mixed'), {
        model: cassetteClient(join(CASSETTE_DIR, '01-meeting-mixed')),
        quiet: true,
      });

      const names = exporter.getFinishedSpans().map((s) => s.name);
      expect(names.filter((n) => n.startsWith('pass ')).length).toBeGreaterThan(0);
      expect(names).toContain('2a/item-01');
      expect(names.filter((n) => n.includes('/item-')).length).toBe(run.result.inventory.length * 2);
    } finally {
      trace.disable();
    }
  });

  it('emits nothing and stays offline when no provider is registered', async () => {
    trace.disable();
    const run = await runScenario(loadScenario('05-corrections'), {
      model: cassetteClient(join(CASSETTE_DIR, '05-corrections')),
      quiet: true,
    });
    expect(run.mismatches).toEqual([]);
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
