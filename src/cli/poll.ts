/**
 * `npm run poll` — cron-able: read every target in a config, run the pipeline over each.
 *
 * The transport this repo has always disclaimed as "your problem" is the scheduler and the
 * deployment that runs this on a timer — `poll.ts` is the loop `npm run pull` needed to become
 * cron-able, not a scheduler of its own. There is still no cursor store: `--since` is a plain
 * argument you widen generously (a day, not an hour), and re-processing the overlap is free — the
 * `source` and `content` idempotency layers `runPipeline` already runs (`ARCHITECTURE.md`) exist
 * exactly for this. A crashed run and a re-triggered one both replay safely for the same reason.
 *
 *   npm run poll -- --config poll.config.json
 *   npm run poll -- --config poll.config.json --since 2026-08-18T00:00:00Z   # overrides the file
 *
 * Config shape:
 *   { "since": "2026-08-18T00:00:00Z", "targets": [
 *       { "source": "github", "repo": "acme/api" },
 *       { "source": "slack", "channel": "C0123ABCD" }
 *   ] }
 *
 * **Writes by default, unlike `npm run pull`.** A human runs `pull` interactively and opts into
 * `--write`; nothing is watching a cron job to notice it only ever planned. Pass `--dry-run` to get
 * `pull`'s plan-only behaviour instead. Exits non-zero if ANY target failed, so cron's own alerting
 * catches it — and keeps going through the rest of the list rather than aborting on the first error,
 * so one dead credential does not silence every other target's run.
 */
import { readFileSync } from 'node:fs';
import { delegateToRoleAgents } from '../agents/boardAgent';
import { AGENT_MAX_DELEGATIONS, MODEL_PROVIDER, RETRIEVAL_DIR } from '../config';
import { buildLiveDeps } from './liveDeps';
import { PipelineEvents } from '../pipeline/events';
import { localRetriever } from '../pipeline/retrieval/local';
import { runPipeline } from '../pipeline/run';
import { makeModelClient, type ProviderName } from '../providers/factory';
import { readSource, type SourceTarget } from './readSource';
import { makeTracker } from '../trackers/factory';
import { printEvent } from './runScenario';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const USAGE = `usage: npm run poll -- --config <path.json> [--since <ISO>] [--dry-run] [--agents]

Config file:
  { "since": "2026-08-18T00:00:00Z", "targets": [
      { "source": "github", "repo": "acme/api" },
      { "source": "gmail", "thread": "<threadId>" },
      { "source": "drive", "file": "<fileId>" },
      { "source": "slack", "channel": "<channelId>" }
  ] }

--since on the command line overrides the file. Widen it generously — overlap is safe, see the
file's header comment. Writes to the tracker by default; --dry-run plans only, like npm run pull.`;

type PollConfig = { since?: string; targets: SourceTarget[] };

function loadConfig(path: string, sinceOverride?: string): PollConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as PollConfig;
  if (!Array.isArray(raw.targets) || !raw.targets.length) throw new Error(`${path}: "targets" must be a non-empty array`);
  const since = sinceOverride ?? raw.since;
  return {
    // Per-target `since` wins; the config-level (or --since override) one only fills gaps. gmail
    // targets have no `since` field at all — the spread is harmless, `readSource` ignores it.
    targets: raw.targets.map((t) => (since && !('since' in t) ? { ...t, since } : t)) as SourceTarget[],
  };
}

async function runOne(target: SourceTarget, opts: { write: boolean; agents: boolean; provider: ProviderName }): Promise<boolean> {
  const label = 'repo' in target ? target.repo : 'thread' in target ? target.thread : 'file' in target ? target.file : target.channel;
  console.log(`\n▶ ${target.source}:${label}`);

  const ingested = await readSource(target);
  if (!ingested.text.trim()) {
    console.log('  ⊘ nothing in this window — no model calls made.');
    return true;
  }

  const emitter = new PipelineEvents();
  emitter.on(printEvent);
  const tracker = makeTracker();
  const { model, deps: liveDeps } = buildLiveDeps({ tracker, model: makeModelClient({ provider: opts.provider }), events: emitter, write: opts.write });
  const complete = async (key: string, prompt: string, system?: string): Promise<string> => {
    const r = await model.complete({ key, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }], determinism: 'strict' });
    if (r.truncated) throw new Error('reply was truncated');
    return r.text;
  };

  const result = await runPipeline(ingested, {
    ...liveDeps,
    runPass: async ({ prompt, label: l }) => ({ text: await complete(l, prompt) }),
    runCategorization: (prompt, l, system) => complete(`2a/${l}`, prompt, system),
    runContractCheck: (prompt, l, system) => complete(`2b/${l}`, prompt, system),
    runDisputeArbiter: (prompt, l) => complete(`arb/${l}`, prompt),
    ...(RETRIEVAL_DIR ? { retrieval: localRetriever(RETRIEVAL_DIR) } : {}),
    ...(opts.agents
      ? { agents: { delegate: (items) => delegateToRoleAgents(items, { model, tracker, maxDelegations: AGENT_MAX_DELEGATIONS, onDelegate: (d) => emitter.emit({ type: 'agent:delegate', ...d }) }) } }
      : {}),
  });

  console.log(
    opts.write
      ? `  ✓ ${result.exec?.created ?? 0} created · ${result.exec?.commented ?? 0} commented · ${result.held.length} held`
      : `  ✓ planned ${result.clean.length} item(s) · ${result.held.length} held — nothing written`
  );
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const configPath = arg(argv, 'config');
  if (!configPath) {
    console.log(USAGE);
    process.exit(argv.length ? 1 : 0);
  }

  const write = !argv.includes('--dry-run');
  const agents = argv.includes('--agents');
  const provider = (arg(argv, 'provider') ?? MODEL_PROVIDER) as ProviderName;
  if (provider === 'cassette') {
    throw new Error('a live poll needs a live model: set MODEL_PROVIDER=deepseek (or anthropic) in .env, or pass --provider deepseek');
  }

  const config = loadConfig(configPath, arg(argv, 'since'));
  console.log(`polling ${config.targets.length} target(s)${write ? '' : ' (dry run)'}`);

  // Every target gets its turn regardless of an earlier failure — one dead credential must not
  // silence the rest of the list, which is exactly the failure mode a cron job cannot see happen.
  let failures = 0;
  for (const target of config.targets) {
    try {
      await runOne(target, { write, agents, provider });
    } catch (err) {
      failures++;
      console.error(`  ✗ ${target.source} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures) {
    console.error(`\n${failures}/${config.targets.length} target(s) failed.\n`);
    process.exit(1);
  }
  console.log(`\nall ${config.targets.length} target(s) polled.\n`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  console.error(USAGE);
  process.exit(1);
});
