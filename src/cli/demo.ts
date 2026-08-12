/**
 * `npm run demo` — the whole pipeline, offline, in a few seconds.
 *
 * No API key, no accounts, no network. Recorded model replies are replayed through the real prompts,
 * the real parsers and the real gates, and the outcome is checked against a golden file.
 *
 * `--twice` runs each scenario a second time against a persisted idempotency store, which is how the
 * "a redelivery costs zero tokens" claim gets demonstrated rather than asserted.
 *
 * `--provider anthropic` replays the parallel recording made from Claude instead. That run is
 * **informational and does not gate**: the scenario goldens describe the DeepSeek run, and the two
 * providers genuinely disagree about what counts as an action item. Reporting those differences is
 * the point — see PROVIDERS.md. Asserting them away would mean picking one provider's judgement and
 * calling it the truth.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CASSETTE_DIR, CASSETTE_DIR_AGENTS, CASSETTE_DIR_AGENTS_ANTHROPIC, CASSETTE_DIR_ANTHROPIC } from '../config';
import { listScenarios, loadScenario } from '../fixtures';
import { cassetteClient } from '../providers/cassette';
import { runScenario } from './runScenario';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const twice = args.includes('--twice');
  const agents = args.includes('--agents');
  const providerIdx = args.indexOf('--provider');
  const provider = providerIdx !== -1 ? args[providerIdx + 1] : 'deepseek';
  const only = args.filter((a) => !a.startsWith('--')).find((a) => a !== provider);

  if (provider !== 'deepseek' && provider !== 'anthropic') {
    console.error(`unknown --provider "${provider}" — expected deepseek | anthropic`);
    process.exit(1);
  }
  const comparing = provider === 'anthropic';
  // The agent path has its OWN recording. Replaying it from the deterministic cassettes would miss
  // every tool turn and quietly look like a pipeline run that happened to mention agents.
  const cassettes = agents
    ? (comparing ? CASSETTE_DIR_AGENTS_ANTHROPIC : CASSETTE_DIR_AGENTS)
    : (comparing ? CASSETTE_DIR_ANTHROPIC : CASSETTE_DIR);

  if (agents) {
    console.log(
      '\nAgent layer ON (PRD §5). A board agent delegates to role agents, which have READ-ONLY tools —\n' +
        'Pass 2c is still the only writer. This is the one part of the repo built rather than extracted;\n' +
        'see AGENTS.md and LIMITATIONS.md.'
    );
  }

  if (comparing) {
    console.log(
      '\nReplaying the Claude recording. The goldens describe the DeepSeek run, so differences below\n' +
        'are the finding, not a failure — see PROVIDERS.md.'
    );
  }

  const scenarios = only ? [only] : listScenarios();
  if (scenarios.length === 0) {
    console.error('No fixture scenarios found under fixtures/scenarios/.');
    process.exit(1);
  }

  let failures = 0;

  for (const name of scenarios) {
    const scenario = loadScenario(name);
    const statePath = join(scenario.dir, '.demo-idempotency.json');
    rmSync(statePath, { force: true });

    console.log(`\n▶ ${name} — ${scenario.expected.description}`);

    const model = cassetteClient(join(cassettes, name));
    const run = await runScenario(scenario, { model, idempotencyPath: statePath, agents });

    if (run.mismatches.length && (comparing || agents)) {
      // Not counted as a failure, for the same reason in both cases: the goldens describe ONE
      // recording of a model reading a meeting, and any other recording is allowed to extract a
      // different number of items. What would be a failure is the deterministic layers behaving
      // differently on identical replies, and that has its own test.
      //
      // For --agents specifically: the agent layer runs AFTER every gate, so it cannot change an
      // inventory count, a category or a hold. Both divergences in the shipped agent recording were
      // traced to earlier passes — scenario 01's Pass 1 extracted 7 items where the deterministic
      // recording got 6, and scenario 04's Pass 1.5 critic raised an item it had previously passed
      // on. Re-recording moves those; agents cannot.
      const r = run.result;
      console.log(`  ≠ ${r.inventory.length} items · ${r.exec?.created ?? 0} created · ${r.held.length} held — differs from the golden:`);
      for (const m of run.mismatches) console.log(`      ${m}`);
    } else if (run.mismatches.length) {
      failures++;
      console.log('  ✗ does not match expected.json:');
      for (const m of run.mismatches) console.log(`      ${m}`);
    } else {
      const r = run.result;
      console.log(
        `  ✓ ${r.inventory.length} items · ${r.exec?.created ?? 0} created · ${r.held.length} held · ` +
          `${r.skippedNotTask.length} skipped — matches expected.json`
      );
    }

    if (twice) {
      const second = await runScenario(scenario, { model, idempotencyPath: statePath, quiet: true });
      const ok = second.result.status === 'skipped' && second.modelCalls === 0;
      if (!ok) failures++;
      console.log(
        ok
          ? `  ✓ re-run: skipped at layer 'source' — 0 model calls, $0.00`
          : `  ✗ re-run should have been skipped with 0 model calls; got status=${second.result.status}, calls=${second.modelCalls}`
      );
    }

    rmSync(statePath, { force: true });
    rmSync(join(scenario.dir, '.corrections.json'), { force: true });
  }

  console.log(failures === 0 ? '\n✓ all scenarios match\n' : `\n✗ ${failures} scenario(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
