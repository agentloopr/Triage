/**
 * DeepSeek provider — OpenAI-shaped `/chat/completions` over plain fetch.
 *
 * This is the provider the shipped cassettes were recorded against, and the one production runs.
 */
import {
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
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

/** DeepSeek is OpenAI-shaped, so portable intent maps straight onto a sampling temperature. */
const TEMPERATURE: Record<Determinism, number> = {
  strict: 0,
  balanced: 0.3,
  exploratory: 0.8,
};

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  error?: { message?: string };
}

export function deepseekClient(opts?: { model?: string; apiKey?: string }): ModelClient {
  const apiKey = opts?.apiKey ?? DEEPSEEK_API_KEY;
  const model = opts?.model ?? DEEPSEEK_MODEL;

  return {
    name: 'deepseek',

    async complete(req: CompletionRequest): Promise<CompletionResult> {
      if (!apiKey) throw new ModelError('DEEPSEEK_API_KEY is not set', null);

      const messages = [
        ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
        ...req.messages,
      ];
      const body = JSON.stringify({
        model,
        messages,
        temperature: TEMPERATURE[req.determinism ?? 'strict'],
        max_tokens: req.maxOutputTokens ?? DEEPSEEK_MAX_OUTPUT_TOKENS,
        stream: false,
      });

      return withRetryBudget(
        `deepseek:${req.key}`,
        req.timeoutMs ?? MODEL_TIMEOUT_MS,
        async (signal) => {
          let res: Response;
          try {
            res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body,
              signal,
            });
          } catch (err) {
            // Network-level failure (including our own abort) — worth another go if budget allows.
            throw new ModelError(`network: ${errText(err)}`);
          }

          if (!res.ok) {
            const detail = (await res.text().catch(() => '')).slice(0, 200);
            // 429/5xx are transient; 4xx otherwise means the request itself is wrong, and
            // re-sending an identical bad request just burns the budget.
            const retryable = res.status === 429 || res.status >= 500;
            throw new ModelError(
              `HTTP ${res.status}: ${detail}`,
              retryable ? retryAfterMs(res) : null
            );
          }

          const data = (await res.json()) as ChatCompletionResponse;
          if (data.error?.message) throw new ModelError(`API error: ${data.error.message}`, null);

          const choice = data.choices?.[0];
          const text = choice?.message?.content ?? '';
          if (!text.trim()) throw new ModelError('empty reply');

          return {
            text,
            model,
            provider: 'deepseek',
            // R4: finish_reason=length means the ceiling was hit and this reply is a fragment.
            truncated: choice?.finish_reason === 'length',
            usage: {
              inputTokens: data.usage?.prompt_tokens ?? 0,
              outputTokens: data.usage?.completion_tokens ?? 0,
              ...(data.usage?.prompt_cache_hit_tokens != null
                ? { cachedInputTokens: data.usage.prompt_cache_hit_tokens }
                : {}),
            },
          };
        }
      );
    },
  };
}

function retryAfterMs(res: Response): number {
  const raw = res.headers.get('retry-after');
  const secs = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 2_000;
}
