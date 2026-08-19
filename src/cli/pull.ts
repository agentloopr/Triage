/**
 * `npm run pull` — read a live service, run the pipeline over it.
 *
 * **Why this file had to exist.** `src/sources/` shipped three read clients, a contract suite and a
 * documented interface, and `grep` found **zero call sites outside their own test file**. Everything
 * about them was true and none of it was reachable: a reader could not get from "the repo reads
 * GitHub" to a command that does it. That is the third time this repo has shipped that exact shape —
 * the observability seam and `makeToolLoopRunner` were the first two — and it is the reason
 * `EXTRACTION.md` says configuration is a claim and only an observed effect is evidence.
 *
 *   npm run pull -- --source github --repo owner/name --since 2026-08-01
 *   npm run pull -- --source gmail  --thread <threadId>
 *   npm run pull -- --source drive  --file <fileId>
 *   npm run pull -- --source github --repo owner/name --write     # actually write
 *
 * **Plans without writing unless you pass `--write`.** The pipeline's own default is to execute, and
 * that is right for a service; it is wrong for a command a person runs by hand against whatever
 * `TRACKER` happens to be set to in their shell. Degrade toward doing less. The plan is printed
 * either way, so a dry run still shows exactly what a real one would do.
 *
 * This is the one path in the repo that needs credentials, and it is deliberately the only one: the
 * demo, the tests and every fixture stay offline because they start from a recorded payload rather
 * than a live read.
 */
import { delegateToRoleAgents } from '../agents/boardAgent';
import { AGENT_MAX_DELEGATIONS, MODEL_PROVIDER, RETRIEVAL_DIR, TRACKER } from '../config';
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

function required(argv: string[], name: string, why: string): string {
  const v = arg(argv, name);
  if (!v) throw new Error(`--${name} is required ${why}`);
  return v;
}

const USAGE = `usage: npm run pull -- --source <github|gmail|drive|slack> [options]

  --source github --repo <owner/name> [--since <ISO>]   repository activity
  --source gmail  --thread <threadId>                   one email thread
  --source drive  --file <fileId>     [--since <ISO>]   comments and revisions
  --source slack  --channel <channelId> [--since <ISO>] channel history

  --write        actually write to the tracker (default: plan only, nothing written)
  --agents       run the optional agent layer (PRD §5)

Credentials come from .env: GITHUB_TOKEN, GOOGLE_ACCESS_TOKEN for gmail/drive, or SLACK_BOT_TOKEN.
Read scopes are sufficient — these clients have no write method.`;

/** argv → the typed target `readSource` (shared with `poll.ts`) actually wants. */
function targetFromArgv(argv: string[], source: string): SourceTarget {
  const since = arg(argv, 'since');
  switch (source) {
    case 'github':
      return { source: 'github', repo: required(argv, 'repo', 'for --source github (e.g. --repo acme/api)'), ...(since ? { since } : {}) };
    case 'gmail':
      return { source: 'gmail', thread: required(argv, 'thread', 'for --source gmail') };
    case 'drive':
      return { source: 'drive', file: required(argv, 'file', 'for --source drive'), ...(since ? { since } : {}) };
    case 'slack':
      return { source: 'slack', channel: required(argv, 'channel', 'for --source slack'), ...(since ? { since } : {}) };
    default:
      throw new Error(`unknown --source "${source}" — expected github | gmail | drive | slack`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const source = arg(argv, 'source');
  if (!source) {
    console.log(USAGE);
    process.exit(argv.length ? 1 : 0);
  }

  const write = argv.includes('--write');
  const agents = argv.includes('--agents');

  console.log(`\n▶ reading ${source} (tracker: ${TRACKER})`);
  const ingested = await readSource(targetFromArgv(argv, source));

  if (!ingested.text.trim()) {
    // An empty read is not a run worth making model calls over, and reporting it as "0 items" would
    // read as "nothing actionable" rather than "nothing was there".
    console.log('\n⊘ the source returned nothing in that window — no model calls made.\n');
    process.exit(0);
  }

  const emitter = new PipelineEvents();
  emitter.on(printEvent);

  // MODEL_PROVIDER defaults to `cassette`, which replays recordings and has nothing recorded for a
  // payload it has never seen. Failing here names the reason; letting it through produces a missing
  // cassette error three passes later that reads like a fixture problem.
  const provider = (arg(argv, 'provider') ?? MODEL_PROVIDER) as ProviderName;
  if (provider === 'cassette') {
    throw new Error(
      'a live read needs a live model: set MODEL_PROVIDER=deepseek (or anthropic) in .env, ' +
        'or pass --provider deepseek'
    );
  }
  const tracker = makeTracker();
  const { model, deps: liveDeps } = buildLiveDeps({ tracker, model: makeModelClient({ provider }), events: emitter, write });
  const complete = async (key: string, prompt: string, system?: string): Promise<string> => {
    const r = await model.complete({
      key,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      determinism: 'strict',
    });
    if (r.truncated) throw new Error('reply was truncated');
    return r.text;
  };

  // Every store a live run persists through — built in `liveDeps.ts` so a test can assert on them
  // without a credential or a network. See that file for what was missing here and for how long.
  const result = await runPipeline(ingested, {
    ...liveDeps,
    runPass: async ({ prompt, label }) => ({ text: await complete(label, prompt) }),
    runCategorization: (prompt, label, system) => complete(`2a/${label}`, prompt, system),
    runContractCheck: (prompt, label, system) => complete(`2b/${label}`, prompt, system),
    // Only ever invoked when DISPUTE_ARBITER_ENABLED is on.
    runDisputeArbiter: (prompt, label) => complete(`arb/${label}`, prompt),
    // Omitted, not `nullRetriever`, when unset — see `retrieval/local.ts`. That is what keeps a
    // default `npm run pull` byte-identical to one run before this seam existed.
    ...(RETRIEVAL_DIR ? { retrieval: localRetriever(RETRIEVAL_DIR) } : {}),
    // Same model and tracker the pipeline uses, so `--agents` exercises the real seam rather than a
    // parallel wiring that could drift from the one the demo proves.
    ...(agents
      ? {
          agents: {
            delegate: (items) =>
              delegateToRoleAgents(items, {
                model,
                tracker,
                maxDelegations: AGENT_MAX_DELEGATIONS,
                onDelegate: (d) => emitter.emit({ type: 'agent:delegate', ...d }),
              }),
          },
        }
      : {}),
  });

  console.log(
    write
      ? `\n✓ ${result.exec?.created ?? 0} created · ${result.exec?.commented ?? 0} commented · ${result.held.length} held` +
        (result.held.length ? `\n  answer them with: npm run answer\n` : '\n')
      : `\n✓ planned ${result.clean.length} item(s) · ${result.held.length} held — nothing written. Re-run with --write.\n`
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  console.error(USAGE);
  process.exit(1);
});
