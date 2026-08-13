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
import { CASSETTE_DIR, CASSETTE_DIR_AGENTS, CASSETTE_DIR_AGENTS_ANTHROPIC, CASSETTE_DIR_ANTHROPIC } from '../config';
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
  const agents = process.argv.includes('--agents');
  const scenarios = process.argv.includes('--all') ? listScenarios() : [arg('scenario') ?? ''].filter(Boolean);

  if (scenarios.length === 0) {
    console.error('Pass --scenario <name> or --all.');
    process.exit(1);
  }

  for (const name of scenarios) {
    const scenario = loadScenario(name);
    // The agent path records into its own set — see CASSETTE_DIR_AGENTS for why they are not mixed.
    const root = agents
      ? (provider === 'anthropic' ? CASSETTE_DIR_AGENTS_ANTHROPIC : CASSETTE_DIR_AGENTS)
      : (provider === 'anthropic' ? CASSETTE_DIR_ANTHROPIC : CASSETTE_DIR);
    const dir = join(root, name);
    if (fresh) rmSync(dir, { recursive: true, force: true });

    console.log(`\n▶ recording ${name} against ${provider}${agents ? ' (agent layer ON)' : ''}`);

    // A miss records through the live provider; a hit replays. That makes re-running cheap and makes
    // a partially-recorded scenario finishable rather than all-or-nothing.
    const model = cassetteClient(dir, { record: makeModelClient({ provider }) });
    const run = await runScenario(scenario, { model, agents });

    console.log(`  ${run.modelCalls} model call(s)`);

    // An empty inventory is never a recording, whatever the reason. The pipeline fails OPEN on a
    // provider error — correct for a production run, where a degraded answer beats no answer — but
    // for the recorder it means an auth failure, a quota wall or an outage comes out looking like a
    // golden mismatch: "inventory: expected 2, got 0", with no cassette on disk and nothing saying
    // why. That happened here with an invalid API key, and the message sent the reader to check
    // their fixture rather than their credentials.
    // ...unless the scenario is *supposed* to extract nothing. `03-meeting-noise` exists precisely to
    // prove the pipeline does not invent work out of pure discussion, and its golden says zero.
    if (run.result.inventory.length === 0 && scenario.expected.inventoryCount > 0) {
      console.error(
        `\n✗ ${name}: Pass 1 produced no items, so nothing was recorded.\n` +
          '  This is almost never the fixture. Check, in order:\n' +
          `    1. the ${provider} credential — an auth failure fails open and looks exactly like this\n` +
          '    2. quota or rate limits on that account\n' +
          '    3. the provider being down\n' +
          '  Re-run once it is fixed; already-recorded cassettes are reused, so nothing is wasted.\n'
      );
      process.exit(1);
    }

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
