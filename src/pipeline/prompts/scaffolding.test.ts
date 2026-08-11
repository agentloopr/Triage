import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OpsRegistry, setOpsRegistryPath } from '../../registry/opsRegistry';
import { setCorrectionsPath } from '../../state/corrections';
import type { EnrichedInventoryItem } from '../types';
import { buildCategorizationPrompt } from './categorization';
import { buildContractCheckerPrompt } from './contractCheck';

const DIR = join(tmpdir(), `scaffolding-test-${process.pid}`);

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [{ name: 'Avery Chen', externalIds: { clickup: '1' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] }],
  routes: [{ key: 'backend', externalIds: {}, pattern: 'backend', defaultAssignee: 'Avery Chen', validAssignees: ['Avery Chen'], status: 'active' }],
  log: [],
};

const ITEM: EnrichedInventoryItem = {
  number: 1, title: 'Add rate limiting', desc: 'Throttle the public endpoints.',
  timestamp: '00:04:00-00:05:00', possibleMatchHint: '(none)',
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'r.json'), JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(join(DIR, 'r.json'));
  setCorrectionsPath(join(DIR, 'c.json'));
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  rmSync(DIR, { recursive: true, force: true });
});

const PROMPTS: Array<[string, () => string]> = [
  ['2a categorization', () => buildCategorizationPrompt(ITEM, 't1 | Existing | backend | Avery Chen | to do | x', 'summary', 'source')],
  ['2b contract check', () => buildContractCheckerPrompt(ITEM, 't1 | Existing | backend | Avery Chen | to do | x', 'summary', 'source')],
];

/**
 * The de-tuning guard.
 *
 * Worked examples are sentinel-delimited so they can be located by grep and replaced wholesale. The
 * failure this catches is a careless find-and-replace that deletes the whole examples block: the
 * prompt still works afterwards, it just works *worse*, and nothing else in the suite notices —
 * every parser still parses, every gate still fires, the demo still goes green.
 */
describe.each(PROMPTS)('%s prompt scaffolding', (_name, build) => {
  it('emits exactly one WORKED EXAMPLES block', () => {
    expect((build().match(/WORKED EXAMPLES/g) ?? []).length).toBe(1);
  });

  it('has substantial content between the sentinel and the output contract', () => {
    const body = build().split('WORKED EXAMPLES')[1]!.split('OUTPUT — emit EXACTLY')[0]!;
    expect(body.trim().length).toBeGreaterThan(500);
  });

  it('keeps the examples in the emitted grammar, so they teach the right shape', () => {
    const body = build().split('WORKED EXAMPLES')[1]!.split('OUTPUT — emit EXACTLY')[0]!;
    expect(body).toMatch(/^\s*(VERDICT_)?CATEGORY:\s*\w+/m);
    expect(body).toMatch(/^\s*RATIONALE:/m);
  });

  it('states the output contract before the data it is meant to act on', () => {
    const p = build();
    expect(p.indexOf('OUTPUT — emit EXACTLY')).toBeLessThan(p.lastIndexOf('FULL BOARD SNAPSHOT'));
  });

  it('ends with the single item to act on, so the ask is the last thing read', () => {
    expect(build().trimEnd().split('\n').slice(-8).join('\n')).toMatch(/POSSIBLE_MATCH_HINT:|TIER-2 EVIDENCE/);
  });

  it('carries the sentinel rule pair the anchor-based de-tuning depends on', () => {
    // Phase 3 locates every de-tuning target by grepping these, never by line number.
    expect(build()).toContain('══════════════════════════════════════════════════════════════════════');
  });
});

/** The taxonomy is the most load-bearing text in the repo and must survive any de-tuning edit. */
describe('2a categorization prompt keeps the load-bearing taxonomy', () => {
  const p = (): string => buildCategorizationPrompt(ITEM, '', '', '');

  it.each([
    ['all five categories', /NEW_TASK[\s\S]*DUPLICATE[\s\S]*SUBTASK[\s\S]*UPDATE[\s\S]*RELATE/],
    ['the containment test', /If the parent is marked\s*\n?\s*done, is THIS automatically done too\?/],
    ['keyword overlap is not containment', /Topic\/keyword\/product overlap is NOT containment/],
    ['the NEW_TASK vs SUBTASK tie-breaker', /TIE-BREAKER[\s\S]{0,120}choose NEW_TASK/],
    ['same assignee is not containment', /Same ASSIGNEE alone is NOT containment/],
    ['the evidence-citation requirement the gate enforces', /does not cite evidence will be HELD/],
    ['ask-dont-guess for uncertain fields', /UNCERTAIN_FIELDS/],
  ])('keeps %s', (_label, re) => {
    expect(p()).toMatch(re);
  });

  it('never names a tracker-specific script or path', () => {
    expect(p()).not.toMatch(/clickup-query|\.sh\b|SOUL\.md|SKILL\.md/);
  });

  it('lists the real routes and members rather than hardcoding names', () => {
    expect(p()).toContain('backend');
    expect(p()).toContain('Avery Chen');
  });
});
