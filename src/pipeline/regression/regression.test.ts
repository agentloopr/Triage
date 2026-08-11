import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cassetteClient } from '../../providers/cassette';
import { type OpsRegistry, setOpsRegistryPath } from '../../registry/opsRegistry';
import { setCorrectionsPath } from '../../state/corrections';
import { REGRESSION_CASES, type RegressionRunner } from './cases';

export const REGRESSION_CASSETTES = resolve('./fixtures/regression');

const DIR = join(tmpdir(), `regression-test-${process.pid}`);

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Rowan Diaz', externalIds: { clickup: '2' }, email: 'r@example.com', role: 'designer', defaultProjects: ['design'] },
  ],
  routes: [
    { key: 'design', externalIds: {}, pattern: 'design|editor|image|theme|font', defaultAssignee: 'Rowan Diaz', validAssignees: ['Rowan Diaz'], status: 'active' },
  ],
  log: [],
};

/** Replays a case's recorded replies. Keyed by case id so cases cannot borrow each other's. */
function cassetteRunner(caseId: string, dir = REGRESSION_CASSETTES): RegressionRunner {
  const client = cassetteClient(join(dir, caseId));
  return async (prompt, label) => {
    const r = await client.complete({ key: label.replace(/:/g, '-'), messages: [{ role: 'user', content: prompt }] });
    return r.text;
  };
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'ops-registry.json'), JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(join(DIR, 'ops-registry.json'));
  setCorrectionsPath(join(DIR, 'corrections.json'));
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  rmSync(DIR, { recursive: true, force: true });
});

/**
 * Each of these is a real production mistake, locked so it cannot silently return.
 *
 * **Scope, stated so a green run is not over-read:** cassettes freeze the model replies, so this
 * covers the deterministic layers — prompt construction, parsing, the consolidator merge, and the
 * containment decision as it reaches the parser. It cannot catch a prompt edit that makes the model
 * itself reason worse. That needs a re-record against a live provider.
 */
describe('locked regression failures (offline, cassette-driven)', () => {
  // A missing cassette must fail here, loudly. Skipping would turn "we never checked" into a
  // green tick, which is worse than having no suite at all.
  it('has a recording for every case', () => {
    const missing = REGRESSION_CASES.filter((c) => !existsSync(join(REGRESSION_CASSETTES, c.id))).map((c) => c.id);
    expect(missing, `no cassettes for ${missing.join(', ')} — run: npm run record:regression`).toEqual([]);
  });

  for (const c of REGRESSION_CASES) {
    it(`${c.id} — ${c.name}`, async () => {
      const { pass, detail } = await c.run(cassetteRunner(c.id));
      expect(pass, `${c.id} regressed. ${c.why}\n  ${detail}`).toBe(true);
    });
  }
});

describe('the cassette runner cannot fake a pass', () => {
  it('throws naming the missing path rather than returning empty', async () => {
    const run = cassetteRunner('F1', join(DIR, 'nonexistent'));
    await expect(run('some prompt', 'pass1:inventory')).rejects.toThrow(/no cassette for/);
  });
});
