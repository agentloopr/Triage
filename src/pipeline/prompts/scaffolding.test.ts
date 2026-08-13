import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OpsRegistry, setOpsRegistryPath } from '../../registry/opsRegistry';
import { setCorrectionsPath } from '../../state/corrections';
import type { EnrichedInventoryItem } from '../types';
import { buildCategorizationPrompt } from './categorization';
import { buildContractCheckerPrompt } from './contractCheck';
import { joinPrompt } from './parts';

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
  ['2a categorization', () => joinPrompt(buildCategorizationPrompt(ITEM, 't1 | Existing | backend | Avery Chen | to do | x', 'summary', 'source'))],
  ['2b contract check', () => joinPrompt(buildContractCheckerPrompt(ITEM, 't1 | Existing | backend | Avery Chen | to do | x', 'summary', 'source'))],
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

  it('carries the sentinel rule pair that makes the examples locatable', () => {
    // Anything that edits an examples block finds it by grepping this, never by line number — line
    // citations in a prompt file go stale within a commit or two and then point at the wrong text.
    expect(build()).toContain('══════════════════════════════════════════════════════════════════════');
  });
});

/**
 * Every card id in a worked example must be one we invented.
 *
 * This is not the same check CI's identifier scan performs, and it exists because that scan missed
 * the one real leak in this repo. A worked example carried `t-e1yj` — the middle of a production
 * ClickUp id, truncated to four characters and given the same `t-` prefix as the fixtures. By shape
 * it is indistinguishable from `t-abc1`; no pattern can tell them apart. Only an allowlist can.
 *
 * Adding an id here should feel deliberate. That is the entire mechanism.
 */
describe('worked examples use only invented card ids', () => {
  const ALLOWED = new Set(['t-abc1', 't-abc2', 't-def4', 't-c3n8', 't100', 't200']);
  const FILES = ['categorization.ts', 'contractCheck.ts', 'inventory.ts'];

  // `t-` + exactly four alphanumerics, or `t` + three digits. The hyphen or the all-digit tail is
  // what separates an id from a hyphenated phrase like "t-history", which has no digits at all.
  const ID_SHAPES = [/\bt-[a-z0-9]{4}\b/g, /\bt\d{3}\b/g];

  it.each(FILES)('%s', (file) => {
    const src = readFileSync(join(__dirname, file), 'utf8');
    const found = ID_SHAPES.flatMap((re) => [...src.matchAll(re)].map((m) => m[0]));
    expect([...new Set(found)].filter((id) => !ALLOWED.has(id))).toEqual([]);
  });
});

/** The taxonomy is the most load-bearing text in the repo and must survive any de-tuning edit. */
describe('2a categorization prompt keeps the load-bearing taxonomy', () => {
  const p = (): string => joinPrompt(buildCategorizationPrompt(ITEM, '', '', ''));

  it.each([
    ['all five categories', /NEW_TASK[\s\S]*DUPLICATE[\s\S]*SUBTASK[\s\S]*UPDATE[\s\S]*RELATE/],
    ['the containment test', /If the parent is marked\s*\n?\s*done, is THIS automatically done too\?/],
    ['keyword overlap is not containment', /Topic\/keyword\/product overlap is NOT containment/],
    ['the NEW_TASK vs SUBTASK tie-breaker', /TIE-BREAKER[\s\S]{0,120}choose NEW_TASK/],
    ['same assignee is not containment', /Same ASSIGNEE alone is NOT containment/],
    ['the evidence-citation requirement the gate enforces', /does not cite evidence will be HELD/],
    // The gate matches the literal string "task-comments". The prompt used to show that only inside
    // an "e.g.", so a reworded-but-correct rationale was held for not citing evidence it had read.
    ['the citation form the parser actually checks for', /literally contain "task-comments"/],
    ['ask-dont-guess for uncertain fields', /UNCERTAIN_FIELDS/],
    // Without this, the model flags an absent due date as uncertain, which HOLDS the card to ask a
    // human a question nobody can answer. Found by re-recording after the roster block landed.
    ['an unstated due date is omitted, not flagged', /unstated deadline is absent, not uncertain/],
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

  /**
   * The roster block has to carry what each role OWNS, not just who exists.
   *
   * A bare list of names gives the model nothing to route an unnamed deliverable on, which is the
   * whole reason role profiles are loaded rather than being documentation.
   */
  it('carries role ownership, and says it never overrides a name the source gave', () => {
    expect(p()).toMatch(/Avery Chen — Engineer:/);
    expect(p()).toMatch(/never overrides a person the source named/);
  });
});
