/**
 * `npm run record` — capture real model replies as cassettes.
 *
 * Runs a scenario against a live provider and writes every reply to
 * `fixtures/cassettes/<scenario>/<pass>/<key>.txt`, plus a `.sha` sidecar recording the prompt it was
 * recorded against. Existing cassettes are replayed rather than re-fetched, so re-running only fills
 * gaps — pass `--fresh` to re-record from scratch.
 *
 * Usage:
 *   npm run record -- --scenario 01-meeting-mixed --provider deepseek
 *   npm run record -- --all --provider deepseek
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CASSETTE_DIR } from '../config';
import { listScenarios, loadScenario } from '../fixtures';
import { cassetteClient } from '../providers/cassette';
import { makeModelClient, type ProviderName } from '../providers/factory';
import { runScenario } from './runScenario';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const provider = (arg('provider') ?? 'deepseek') as ProviderName;
  const fresh = process.argv.includes('--fresh');
  const scenarios = process.argv.includes('--all') ? listScenarios() : [arg('scenario') ?? ''].filter(Boolean);

  if (scenarios.length === 0) {
    console.error('Pass --scenario <name> or --all.');
    process.exit(1);
  }

  for (const name of scenarios) {
    const scenario = loadScenario(name);
    const dir = join(CASSETTE_DIR, name);
    if (fresh) rmSync(dir, { recursive: true, force: true });

    console.log(`\n▶ recording ${name} against ${provider}`);

    // A miss records through the live provider; a hit replays. That makes re-running cheap and makes
    // a partially-recorded scenario finishable rather than all-or-nothing.
    const model = cassetteClient(dir, { record: makeModelClient({ provider }) });
    const run = await runScenario(scenario, { model });

    console.log(`  ${run.modelCalls} model call(s)`);
    if (run.mismatches.length) {
      console.log('  ⚠ the recorded run does not match expected.json:');
      for (const m of run.mismatches) console.log(`      ${m}`);
      console.log('  Either the fixture expectations need updating, or the model genuinely disagrees.');
      console.log('  Do NOT silently rewrite expected.json to match — decide which one is wrong.');
    } else {
      console.log('  ✓ matches expected.json');
    }

    rmSync(join(scenario.dir, '.corrections.json'), { force: true });
  }
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
