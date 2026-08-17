/**
 * Measure real DeepSeek $ cost across all fixture scenarios, against the live API.
 *
 * Writes nothing to fixtures/cassettes — wraps the live client purely to tally usage, so it never
 * touches the pinned recordings and carries none of the cassette-drift risk PROVIDERS.md describes
 * for re-recording. Costs real (small) money: one live pass over every scenario.
 *
 * Usage: DEEPSEEK_API_KEY=... npx tsx scripts/measureDeepSeekCost.ts
 */
import { listScenarios, loadScenario } from '../src/fixtures';
import { makeModelClient } from '../src/providers/factory';
import { runScenario } from '../src/cli/runScenario';
import type { CompletionRequest, CompletionResult, ModelClient } from '../src/providers';

let inputTokens = 0;
let outputTokens = 0;
let cachedInputTokens = 0;
let calls = 0;

function meteredClient(inner: ModelClient): ModelClient {
  return {
    name: inner.name,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const res = await inner.complete(req);
      calls++;
      inputTokens += res.usage?.inputTokens ?? 0;
      outputTokens += res.usage?.outputTokens ?? 0;
      cachedInputTokens += res.usage?.cachedInputTokens ?? 0;
      return res;
    },
  };
}

async function main() {
  const model = meteredClient(makeModelClient({ provider: 'deepseek' }));

  for (const name of listScenarios()) {
    const scenario = loadScenario(name);
    process.stderr.write(`▶ ${name}\n`);
    await runScenario(scenario, { model, quiet: true });
  }

  const cacheMissTokens = inputTokens - cachedInputTokens;
  console.log(JSON.stringify({ calls, inputTokens, cachedInputTokens, cacheMissTokens, outputTokens }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
