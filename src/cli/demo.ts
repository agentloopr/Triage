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
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_ENABLED, CASSETTE_DIR, CASSETTE_DIR_AGENTS, CASSETTE_DIR_AGENTS_ANTHROPIC, CASSETTE_DIR_ANTHROPIC } from '../config';
import { listScenarios, loadScenario } from '../fixtures';
import { cassetteClient } from '../providers/cassette';
import { runScenario } from './runScenario';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const twice = args.includes('--twice');
  // Either mechanism turns the layer on, because AGENTS.md documents both. The flag is computed
  // ONCE and drives the cassette directory as well as the run: deciding them separately is how
  // you get an agent run replaying a non-agent recording, which fails as a missing cassette
  // rather than as the configuration mistake it actually is.
  const agents = args.includes('--agents') || AGENTS_ENABLED;
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

  // A scenario with no recording for this provider is NOT a scenario the provider disagreed about.
  // Replaying it produces an empty Pass 1 and then zero of everything, which lands in the "differs
  // from the golden" bucket and reads as a finding. It is an absence, and absence has to look
  // different from disagreement or the summary line quietly overstates what was compared.
  const unrecorded = scenarios.filter((name) => !existsSync(join(cassettes, name)));
  const runnable = scenarios.filter((name) => !unrecorded.includes(name));

  if (unrecorded.length) {
    console.log(
      `\n⊘ no ${provider}${agents ? ' agent' : ''} recording for: ${unrecorded.join(', ')}\n` +
        `  Skipped rather than replayed — an empty replay would be reported as a divergence.\n` +
        `  Record with:  npm run record -- --scenario <name> --provider ${provider}${agents ? ' --agents' : ''}`
    );
  }

  let failures = 0;
  let differing = 0;
  let matched = 0;

  for (const name of runnable) {
    const scenario = loadScenario(name);
    const statePath = join(scenario.dir, '.demo-idempotency.json');
    rmSync(statePath, { force: true });

    console.log(`\n▶ ${name} — ${scenario.expected.description}`);

    const model = cassetteClient(join(cassettes, name));
    const run = await runScenario(scenario, { model, idempotencyPath: statePath, agents });

    if (run.mismatches.length && (comparing || agents)) {
      // Not counted as a failure, for the same reason in both cases: the goldens describe ONE
      // recording of a model reading a source, and any other recording is allowed to extract a
      // different number of items. What would be a failure is the deterministic layers behaving
      // differently on identical replies, and that has its own test.
      //
      // For --agents this now says something stronger than it used to. The agent layer may PROPOSE
      // a different category, list or assignee: a proposal that survives `applyGates` changes what
      // is written, and one that fails it becomes a hold. So an agent run legitimately differs from
      // the deterministic golden — that is the feature working, not drift.
      //
      // No `expected.agents.json` ships, deliberately. A golden per path would pin one recording of
      // a model judgement, which is the mistake EXTRACTION.md records having made twice. What holds
      // the agent path to account instead is `run.test.ts`'s invariants, asserted with scripted
      // replies rather than recordings: a refused proposal holds rather than writes, an agent is
      // never shown an item the gates already held, and the summary reports only what the executor
      // returned.
      differing++;
      const r = run.result;
      console.log(`  ≠ ${r.inventory.length} items · ${r.exec?.created ?? 0} created · ${r.held.length} held — differs from the golden:`);
      for (const m of run.mismatches) console.log(`      ${m}`);
    } else if (run.mismatches.length) {
      failures++;
      console.log('  ✗ does not match expected.json:');
      for (const m of run.mismatches) console.log(`      ${m}`);
    } else {
      matched++;
      const r = run.result;
      console.log(
        `  ✓ ${r.inventory.length} items · ${r.exec?.created ?? 0} created · ${r.held.length} held · ` +
          `${r.skippedNotTask.length} skipped — matches expected.json`
      );
    }

    if (twice) {
      // `agents` is threaded through deliberately: without it the second pass ran the non-agent
      // path, so `--twice --agents` silently proved nothing about the agent path's idempotency.
      const second = await runScenario(scenario, { model, idempotencyPath: statePath, quiet: true, agents });
      const ok = second.result.status === 'skipped' && second.modelCalls === 0;
      if (!ok) failures++;
      // The layer is READ from the run, never hardcoded. It used to print 'source' unconditionally
      // while the skip actually fired at 'event' — the fixtures carry a deliveryId, which is checked
      // first. A hardcoded label that happens to name a real layer is indistinguishable from a
      // correct one, and an audit of this repo believed the string over the code.
      const layer = second.events.find((e) => e.type === 'skipped')?.layer ?? 'unknown';
      console.log(
        ok
          ? `  ✓ re-run: skipped at layer '${layer}' — 0 model calls, $0.00`
          : `  ✗ re-run should have been skipped with 0 model calls; got status=${second.result.status}, calls=${second.modelCalls}`
      );
    }

    rmSync(statePath, { force: true });
    rmSync(join(scenario.dir, '.corrections.json'), { force: true });
  }

  // The summary must never contradict the lines above it. Printing "all scenarios match" directly
  // under a printed `≠` block is the exact shape of failure this repo calls unacceptable elsewhere:
  // "a silent miss produces a green demo that did nothing at all". Divergence from a DIFFERENT
  // recording is still not a failure — that decision is argued above and the exit code is unchanged
  // — but it is reported, because an unreported difference cannot be noticed when it grows.
  if (failures > 0) {
    console.log(`\n✗ ${failures} scenario(s) failed\n`);
    process.exit(1);
  }
  // Skips are counted in the summary for the same reason divergences are: "3 match" under a run of
  // eight scenarios reads as a pass unless the missing five are named. The totals have to add up to
  // the number of scenarios that exist, or the line quietly overstates what was compared.
  const skipped = unrecorded.length ? ` · ⊘ ${unrecorded.length} not recorded for ${provider}` : '';
  console.log(
    differing === 0 && !skipped
      ? '\n✓ all scenarios match\n'
      : `\n✓ ${matched} match` +
          (differing ? ` · ≠ ${differing} differ from the golden` : '') +
          skipped +
          `  (of ${scenarios.length} scenarios; divergence is informational — a different recording may` +
          ' extract a different number of items — and is not gating)\n'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
