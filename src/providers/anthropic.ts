/**
 * Anthropic provider.
 *
 * Five things here are deliberate and each one is a 400 (or a silent corruption) if you "simplify"
 * it back to the OpenAI shape:
 *
 *  1. NO sampling parameters. `temperature` / `top_p` / `top_k` are rejected by current models.
 *     Portable intent arrives as `determinism` and leaves as `output_config.effort`.
 *  2. NO `thinking.budget_tokens` — omitted entirely, so the model uses its adaptive default.
 *  3. `max_tokens` bounds thinking AND visible text together, so it is sized generously. Undersizing
 *     it does not produce a shorter answer; it produces a manifest cut off mid-item.
 *  4. Thinking is never disabled. Disabling it has a documented failure mode where tool-call-shaped
 *     text leaks into the visible reply — which would corrupt the `ITEM:` grammar every parser and
 *     the eval depend on. Use `effort: 'low'` to spend less instead.
 *  5. Prompt caching is wired from day one. Passes 2a/2b fan out N calls over one ~114K-char board
 *     snapshot; without a cache breakpoint that prefix is re-billed N times.
 *
 * ⚠️ Not yet validated against the live API — written against @anthropic-ai/sdk 0.71.2's types.
 *    Scheduled for live validation before the Anthropic cassettes are recorded.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MAX_OUTPUT_TOKENS,
  ANTHROPIC_MODEL,
  MODEL_TIMEOUT_MS,
} from '../config';
import {
  type CompletionRequest,
  type CompletionResult,
  type Determinism,
  type ModelClient,
  ModelError,
  withRetryBudget,
  errText,
} from './index';

/**
 * `output_config.effort` is a three-value enum in this SDK version — there is no 'xhigh'. The
 * pipeline runs 'strict' almost everywhere (determinism is load-bearing for the ITEM grammar), so
 * the upper two rungs are mostly theoretical here.
 */
const EFFORT: Record<Determinism, 'low' | 'medium' | 'high'> = {
  strict: 'low',
  balanced: 'medium',
  exploratory: 'high',
};

/** Above this, the SDK refuses a non-streaming request that could outlive its HTTP timeout. */
const STREAM_ABOVE_TOKENS = 16_384;

export function anthropicClient(opts?: { model?: string; apiKey?: string }): ModelClient {
  const apiKey = opts?.apiKey ?? ANTHROPIC_API_KEY;
  const model = opts?.model ?? ANTHROPIC_MODEL;

  return {
    name: 'anthropic',

    async complete(req: CompletionRequest): Promise<CompletionResult> {
      if (!apiKey) throw new ModelError('ANTHROPIC_API_KEY is not set', null);

      // Anthropic expresses tool use as content blocks rather than an OpenAI-shaped `tool` role, so
      // it is a genuinely different mapping. Declining loudly beats shipping an untested translation
      // for a provider that has never made a live call — the tool loop runs on DeepSeek today.
      if (req.tools?.length || req.messages.some((m) => m.role === 'tool')) {
        throw new ModelError('tool use is not implemented for the Anthropic provider — use deepseek for the tool loop', null);
      }

      const client = new Anthropic({ apiKey, maxRetries: 0 }); // retries are ours — see withRetryBudget
      const maxTokens = req.maxOutputTokens ?? ANTHROPIC_MAX_OUTPUT_TOKENS;

      const params = {
        model,
        max_tokens: maxTokens,
        output_config: { effort: EFFORT[req.determinism ?? 'strict'] },
        // The cache breakpoint goes on the LAST system block, so everything above it — the board
        // snapshot and the taxonomy — is the reusable prefix and only the per-item user turn varies.
        ...(req.system
          ? { system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }] }
          : {}),
        // The `tool` role is refused above, so what is left maps one-to-one.
        messages: req.messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      };

      return withRetryBudget(
        `anthropic:${req.key}`,
        req.timeoutMs ?? MODEL_TIMEOUT_MS,
        async (signal) => {
          try {
            if (maxTokens > STREAM_ABOVE_TOKENS) return await streamed(client, params, model, signal);

            const msg = await client.beta.messages.create({ ...params, stream: false }, { signal });
            const text = msg.content
              .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('');
            if (!text.trim()) throw new ModelError('empty reply');

            return {
              text,
              model,
              provider: 'anthropic',
              truncated: msg.stop_reason === 'max_tokens',
              usage: {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                ...(msg.usage.cache_read_input_tokens != null
                  ? { cachedInputTokens: msg.usage.cache_read_input_tokens }
                  : {}),
              },
            };
          } catch (err) {
            if (err instanceof ModelError) throw err;
            const status = (err as { status?: number })?.status;
            // 4xx other than 429 means the request itself is wrong; resending it wastes the budget.
            const retryable = status == null || status === 429 || status >= 500;
            throw new ModelError(errText(err), retryable ? retryAfterMs(err) : null);
          }
        }
      );
    },
  };
}

function retryAfterMs(err: unknown): number {
  const hdr = (err as { headers?: Record<string, string> })?.headers?.['retry-after'];
  const secs = Number.parseInt(hdr ?? '', 10);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 2_000;
}

/** Long outputs must stream, or the SDK rejects the request before it is ever sent. */
async function streamed(
  client: Anthropic,
  params: Record<string, unknown>,
  model: string,
  signal: AbortSignal
): Promise<CompletionResult> {
  const stream = await client.beta.messages.create(
    { ...params, stream: true } as Parameters<typeof client.beta.messages.create>[0],
    { signal }
  );

  let text = '';
  let truncated = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | undefined;

  for await (const event of stream as AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
    } else if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens;
      if (event.message.usage.cache_read_input_tokens != null) {
        cachedInputTokens = event.message.usage.cache_read_input_tokens;
      }
    } else if (event.type === 'message_delta') {
      outputTokens = event.usage.output_tokens;
      if (event.delta.stop_reason === 'max_tokens') truncated = true;
    }
  }

  if (!text.trim()) throw new ModelError('empty reply');
  return {
    text,
    model,
    provider: 'anthropic',
    truncated,
    usage: { inputTokens, outputTokens, ...(cachedInputTokens != null ? { cachedInputTokens } : {}) },
  };
}
