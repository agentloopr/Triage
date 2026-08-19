/**
 * Measure real $ cost across all fixture scenarios, against the live API — either provider, same
 * method. Generalized from `measureDeepSeekCost.ts` so the DeepSeek and Claude tables in
 * PROVIDERS.md are taken the same way and are actually comparable.
 *
 * Writes nothing to fixtures/cassettes — wraps the live client purely to tally usage, so it never
 * touches the pinned recordings and carries none of the cassette-drift risk PROVIDERS.md describes
 * for re-recording. Costs real (small) money: one live pass over every scenario.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=...   npx tsx scripts/measureCost.ts --provider deepseek
 *   ANTHROPIC_API_KEY=...  npx tsx scripts/measureCost.ts --provider anthropic
 */
import { listScenarios, loadScenario } from '../src/fixtures';
import { makeModelClient, type ProviderName } from '../src/providers/factory';
import { runScenario } from '../src/cli/runScenario';
import type { CompletionRequest, CompletionResult, ModelClient } from '../src/providers';

let inputTokens = 0;
let outputTokens = 0;
let cachedInputTokens = 0;
let cacheCreationInputTokens = 0;
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
      cacheCreationInputTokens += res.usage?.cacheCreationInputTokens ?? 0;
      return res;
    },
  };
}

async function main() {
  const i = process.argv.indexOf('--provider');
  const provider = (i >= 0 ? process.argv[i + 1] : undefined) as ProviderName | undefined;
  if (provider !== 'deepseek' && provider !== 'anthropic') {
    console.error('usage: npx tsx scripts/measureCost.ts --provider <deepseek|anthropic>');
    process.exit(1);
  }

  const model = meteredClient(makeModelClient({ provider }));

  for (const name of listScenarios()) {
    const scenario = loadScenario(name);
    process.stderr.write(`▶ ${name}\n`);
    await runScenario(scenario, { model, quiet: true });
  }

  // The two providers report `inputTokens` on genuinely different bases, not just different
  // numbers — DeepSeek's `prompt_tokens` is the TOTAL (cache hit + miss), so the miss count is the
  // remainder after subtracting the hit count. Anthropic's `input_tokens` is ALREADY miss-only (it
  // excludes both `cache_read_input_tokens` AND `cache_creation_input_tokens` by definition) —
  // subtracting `cachedInputTokens` again double-counts and goes negative. Provider-aware on
  // purpose; a single formula silently produced a negative number here the first time this ran
  // live, which is exactly the "measured but wrong" trap LIMITATIONS.md already names once in this
  // file's history. `cacheCreationInputTokens` (Anthropic only, billed at a premium — see
  // PROVIDERS.md) is reported separately rather than folded into either bucket, since it is priced
  // differently from both a cache read and a plain miss.
  const cacheMissTokens = provider === 'deepseek' ? inputTokens - cachedInputTokens : inputTokens;
  console.log(
    JSON.stringify({ provider, calls, inputTokens, cachedInputTokens, cacheCreationInputTokens, cacheMissTokens, outputTokens }, null, 2)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
