/**
 * `npm run record:regression` — capture the locked-failure cases against a live provider.
 *
 * Each case gets its own cassette directory, so one case can never accidentally replay another's
 * reply. Re-running only fills gaps; `--fresh` re-records from scratch.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGRESSION_CASES } from '../pipeline/regression/cases';
import { cassetteClient } from '../providers/cassette';
import { makeModelClient, type ProviderName } from '../providers/factory';
import { setOpsRegistryPath } from '../registry/opsRegistry';
import { setCorrectionsPath } from '../state/corrections';

const OUT = './fixtures/regression';

const REGISTRY = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [{ name: 'Rowan Diaz', externalIds: { clickup: '2' }, email: 'r@example.com', role: 'designer', defaultProjects: ['design'] }],
  routes: [{ key: 'design', externalIds: {}, pattern: 'design|editor|image|theme|font', defaultAssignee: 'Rowan Diaz', validAssignees: ['Rowan Diaz'], status: 'active' }],
  log: [],
};

async function main(): Promise<void> {
  const i = process.argv.indexOf('--provider');
  const provider = (i !== -1 ? process.argv[i + 1] : 'deepseek') as ProviderName;
  if (process.argv.includes('--fresh')) rmSync(OUT, { recursive: true, force: true });

  const tmp = join(tmpdir(), `record-regression-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'ops-registry.json'), JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(join(tmp, 'ops-registry.json'));
  setCorrectionsPath(join(tmp, 'corrections.json'));

  let failed = 0;

  for (const c of REGRESSION_CASES) {
    const client = cassetteClient(join(OUT, c.id), { record: makeModelClient({ provider }) });
    const runner = async (prompt: string, label: string): Promise<string> => {
      const r = await client.complete({ key: label.replace(/:/g, '-'), messages: [{ role: 'user', content: prompt }], determinism: 'strict' });
      return r.text;
    };

    process.stdout.write(`▶ ${c.id} — ${c.name}\n`);
    const { pass, detail } = await c.run(runner);
    if (!pass) failed++;
    console.log(pass ? `  ✓ locked behaviour holds` : `  ✗ REGRESSED: ${detail}`);
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(
    failed === 0
      ? `\n✓ all ${REGRESSION_CASES.length} locked cases hold against ${provider}\n`
      : `\n✗ ${failed} case(s) regressed against ${provider} — the cassettes are recorded, but do NOT commit them as a new baseline until you know why\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
