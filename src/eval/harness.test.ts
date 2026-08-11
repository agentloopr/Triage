import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EvalEvent,
  TraceParseError,
  aggregate,
  codeChecks,
  evaluate,
  formatReport,
  loadEventsFromDir,
  loadEventsFromTrace,
  mergeResults,
} from './harness';

const DIR = join(tmpdir(), `eval-test-${process.pid}`);

const event = (over: Partial<EvalEvent> = {}): EvalEvent => ({
  runId: 'r1', item: 1, title: 'Add rate limiting', category: 'NEW_TASK',
  list: 'backend', assignee: 'Avery Chen', disposition: 'created',
  tier2Cited: false, uncertainFieldCount: 0, ...over,
});

const write = (name: string, body: unknown): string => {
  const p = join(DIR, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return p;
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

/**
 * The property this file exists to protect.
 *
 * The version this was extracted from returned `[]` on three separate paths, so a prompt edit that
 * changed the manifest's shape produced an eval reporting zero events and NO error — visually
 * identical to a clean run. Every one of these must throw.
 */
describe('fails loud — strict is the default, not a flag', () => {
  it.each([
    ['a missing file', () => join(DIR, 'nope.json')],
    ['an empty file', () => write('empty.json', '')],
    ['a file that is not JSON', () => write('bad.json', 'not json at all')],
    ['a trace with no events array', () => write('noarr.json', { runId: 'r', sourceId: 's', recordedAt: 'x' })],
    ['a trace with zero events', () => write('zero.json', { runId: 'r', sourceId: 's', recordedAt: 'x', events: [] })],
  ])('throws on %s', (_label, make) => {
    expect(() => loadEventsFromTrace(make())).toThrow(TraceParseError);
  });

  it('names the file in the error, so the failure is actionable', () => {
    const p = write('bad.json', 'nope');
    expect(() => loadEventsFromTrace(p)).toThrow(/bad\.json/);
  });

  it('throws on a missing or empty trace directory', () => {
    expect(() => loadEventsFromDir(join(DIR, 'nope'))).toThrow(TraceParseError);
    expect(() => loadEventsFromDir(DIR)).toThrow(/no trace files/);
  });

  it('warns instead of throwing only when lenient is explicitly asked for', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadEventsFromTrace(join(DIR, 'nope.json'), { strict: false })).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('loads a valid trace', () => {
    const p = write('ok.json', { runId: 'r', sourceId: 's', recordedAt: 'x', events: [event()] });
    expect(loadEventsFromTrace(p)).toHaveLength(1);
  });
});

describe('codeChecks', () => {
  it('passes creation when work that should exist does', () => {
    const r = codeChecks(event());
    expect(r.find((x) => x.dimension === 'creation')).toMatchObject({ score: 'pass', source: 'code' });
  });

  it('scores a hold as partial, not a failure — asking is a valid outcome', () => {
    const r = codeChecks(event({ disposition: 'held', gate: 'uncertain field(s)' }));
    expect(r.find((x) => x.dimension === 'creation')?.score).toBe('partial');
  });

  it('fails creation when the write failed', () => {
    expect(codeChecks(event({ disposition: 'failed' })).find((x) => x.dimension === 'creation')?.score).toBe('fail');
  });

  it('fails routing when either half is missing', () => {
    expect(codeChecks(event({ list: undefined })).find((x) => x.dimension === 'routing')?.score).toBe('fail');
    expect(codeChecks(event({ assignee: undefined })).find((x) => x.dimension === 'routing')?.score).toBe('fail');
  });

  it('does not score routing on a held item — it was never routed', () => {
    expect(codeChecks(event({ disposition: 'held' })).find((x) => x.dimension === 'routing')).toBeUndefined();
  });

  it('scores comment quality on an update', () => {
    const short = codeChecks(event({ category: 'UPDATE', finalDesc: 'done', disposition: 'commented' }));
    expect(short.find((x) => x.dimension === 'comment')?.score).toBe('partial');

    const full = codeChecks(event({ category: 'UPDATE', finalDesc: 'x'.repeat(80), disposition: 'commented' }));
    expect(full.find((x) => x.dimension === 'comment')?.score).toBe('pass');
  });

  // An existing-card decision with no cited evidence is exactly how a wrong nudge reaches someone.
  it('fails false_alarms when an existing-card decision cites no evidence', () => {
    const bad = codeChecks(event({ category: 'DUPLICATE', tier2Cited: false }));
    expect(bad.find((x) => x.dimension === 'false_alarms')?.score).toBe('fail');

    const good = codeChecks(event({ category: 'DUPLICATE', tier2Cited: true }));
    expect(good.find((x) => x.dimension === 'false_alarms')?.score).toBe('pass');
  });

  // Scoring a blind spot would be worse than admitting it.
  it('never scores miss_rate from events — a dropped item leaves no event', () => {
    for (const category of ['NEW_TASK', 'UPDATE', 'DUPLICATE', 'SUBTASK']) {
      expect(codeChecks(event({ category })).find((x) => x.dimension === 'miss_rate')).toBeUndefined();
    }
  });
});

describe('mergeResults', () => {
  it('lets an objective check override an opinion, never the reverse', () => {
    const merged = mergeResults(
      [{ dimension: 'routing', score: 'fail', why: 'no list', source: 'code' }],
      [{ dimension: 'routing', score: 'pass', why: 'looks fine to me', source: 'judge' }]
    );
    expect(merged).toEqual([{ dimension: 'routing', score: 'fail', why: 'no list', source: 'code' }]);
  });

  it('keeps a judge result where no code check exists', () => {
    const merged = mergeResults([], [{ dimension: 'miss_rate', score: 'pass', why: 'nothing missed', source: 'judge' }]);
    expect(merged).toHaveLength(1);
  });
});

describe('aggregate', () => {
  it('scores a partial as half a pass', () => {
    const evals = [
      { event: event(), results: codeChecks(event()) },
      { event: event(), results: codeChecks(event({ disposition: 'held' })) },
    ];
    expect(aggregate(evals).creation).toMatchObject({ pass: 1, partial: 1, n: 2, score: 0.75 });
  });

  // null, not 0 — "nothing to score" and "scored zero" are completely different claims.
  it('reports null rather than zero for a dimension with no applicable events', () => {
    expect(aggregate([{ event: event(), results: [] }]).miss_rate).toMatchObject({ n: 0, score: null });
  });
});

describe('formatReport', () => {
  it('always states how many events were parsed, so even a lenient run looks wrong', () => {
    const { dimensions } = evaluate([]);
    expect(formatReport([], dimensions)).toContain('parsed 0 event(s)');
  });

  it('distinguishes "not scored" from a zero score', () => {
    const { dimensions } = evaluate([event()]);
    const report = formatReport([event()], dimensions);
    expect(report).toContain('not scored');
    expect(report).toContain('miss_rate is never scored from events alone');
  });
});
