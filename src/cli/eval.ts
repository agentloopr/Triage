/**
 * `npm run eval` — score the shipped fixture runs on the six dimensions.
 *
 * Strict by default: a trace that cannot be parsed is an error, not an empty result. There is
 * deliberately **no `--strict` flag** — it once existed as a silent no-op, so passing it claimed a
 * guarantee that was never delivered. Passing it now hard-errors, which is the point.
 *
 *   npm run eval                 # the fixture scenarios
 *   npm run eval -- --lenient    # warn instead of throwing (for messy real traces)
 *   npm run eval -- --traces <dir>
 */
import { join } from 'node:path';
import { CASSETTE_DIR } from '../config';
import { listScenarios, loadScenario } from '../fixtures';
import { TraceParseError, evaluate, eventsFromResult, formatReport, loadEventsFromDir, type EvalEvent } from '../eval/harness';
import { cassetteClient } from '../providers/cassette';
import { runScenario } from './runScenario';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // The flag that used to lie. Reject it loudly rather than accepting it as a no-op.
  if (process.argv.includes('--strict')) {
    console.error(
      'error: --strict is not a flag. Strict IS the default, and this flag previously existed as a\n' +
        'silent no-op — so every command that passed it was claiming a guarantee it never provided.\n' +
        'Use --lenient if you genuinely want warnings instead of errors.'
    );
    process.exit(2);
  }

  const strict = !process.argv.includes('--lenient');
  const tracesDir = arg('traces');

  let events: EvalEvent[];

  if (tracesDir) {
    events = loadEventsFromDir(tracesDir, { strict });
  } else {
    events = [];
    for (const name of listScenarios()) {
      const scenario = loadScenario(name);
      const { result } = await runScenario(scenario, {
        model: cassetteClient(join(CASSETTE_DIR, name)),
        quiet: true,
        // Pinned off, not left to `AGENTS_ENABLED`: eval scores the non-agent recordings, and
        // inheriting the environment here would look for cassettes that are not in this directory.
        agents: false,
      });
      events.push(...eventsFromResult(result, name));
    }
  }

  const { dimensions } = evaluate(events);
  console.log(`\n${formatReport(events, dimensions)}\n`);

  // No pass/fail threshold on purpose. This reports where the system stands; deciding what is good
  // enough is a judgement about a specific deployment, not something a fixture suite can assert.
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof TraceParseError) {
    console.error(`\nTrace parse error — ${err.message}`);
    console.error('This is deliberately fatal. An eval that silently reports zero events is worse than no eval.\n');
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
