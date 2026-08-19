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
 * Tool use is a sixth deliberate difference: Anthropic has **no `tool` role**. A result is a
 * `tool_result` block inside a user turn, all results for one assistant turn share a single user
 * message, and a reply that asks for a tool carries no prose at all — see `toAnthropicMessages`.
 *
 * Validated live: auth, model id, `output_config.effort`, truncation mapping, usage, and a full
 * two-turn tool exchange (empty-text tool call → tool_result → final answer).
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MAX_OUTPUT_TOKENS,
  ANTHROPIC_MODEL,
  MODEL_TIMEOUT_MS,
} from '../config';
import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type Determinism,
  type ModelClient,
  ModelError,
  type ToolCall,
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
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                // Anthropic calls it `input_schema`; the OpenAI shape calls it `parameters`. Same
                // JSON Schema, different key — one of the two places this mapping is not one-to-one.
                //
                // The cast narrows `Record<string, unknown>` to the SDK's schema type, which requires
                // a literal `type: 'object'`. Every ToolSpec in this repo supplies it; a tool that did
                // not would be rejected by the API rather than silently misbehave.
                input_schema: t.parameters as Anthropic.Beta.BetaTool['input_schema'],
              })),
            }
          : {}),
        messages: toAnthropicMessages(req.messages),
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
            const toolCalls = msg.content
              .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
              .map((b) => ({ id: b.id, name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> }));

            // A tool-use reply legitimately carries NO prose — the model asked for a tool instead of
            // answering. Throwing "empty reply" there would make every agent turn look like a
            // provider failure, and the retry budget would burn on a response that was perfectly fine.
            if (!text.trim() && toolCalls.length === 0) throw new ModelError('empty reply');

            return {
              text,
              ...(toolCalls.length ? { toolCalls } : {}),
              model,
              provider: 'anthropic',
              truncated: msg.stop_reason === 'max_tokens',
              usage: {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                ...(msg.usage.cache_read_input_tokens != null
                  ? { cachedInputTokens: msg.usage.cache_read_input_tokens }
                  : {}),
                ...(msg.usage.cache_creation_input_tokens != null
                  ? { cacheCreationInputTokens: msg.usage.cache_creation_input_tokens }
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

/**
 * Portable `ChatMessage[]` → Anthropic's content blocks.
 *
 * Three differences from the OpenAI shape, and each one is a 400 if you get it wrong:
 *
 *  1. There is **no `tool` role.** A tool result is a `tool_result` block inside a *user* turn.
 *  2. All results answering one assistant turn must sit in **one** user message. Emitting a separate
 *     user turn per result reads as several conversational turns and the API rejects it.
 *  3. An assistant turn that called tools carries `tool_use` blocks, with its prose (if any) as a
 *     `text` block first. An empty text block is itself a 400, so it is omitted when there is none.
 */
function toAnthropicMessages(messages: readonly ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      // Anthropic pairs a result to its call by id and rejects the request without one. Failing here
      // names the caller's bug; letting it through produces an opaque 400 about message content.
      if (!m.toolCallId) {
        throw new ModelError('a tool message has no toolCallId — cannot pair it to the tool_use block it answers', null);
      }
      const block = { type: 'tool_result' as const, tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      const isResultTurn =
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((b) => (b as { type?: string }).type === 'tool_result');

      if (isResultTurn) (last!.content as unknown[]).push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content.trim() ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.arguments })),
        ],
      });
      continue;
    }

    out.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }

  return out;
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
  let cacheCreationInputTokens: number | undefined;

  // Tool calls arrive split across events: `content_block_start` names the tool, then the arguments
  // stream in as PARTIAL JSON fragments that only parse once the block closes. Parsing early yields
  // a syntax error on perfectly valid input.
  const pending = new Map<number, { id: string; name: string; json: string }>();
  const toolCalls: ToolCall[] = [];

  for await (const event of stream as AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
    } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      const acc = pending.get(event.index);
      if (acc) acc.json += event.delta.partial_json;
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      pending.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
    } else if (event.type === 'content_block_stop') {
      const acc = pending.get(event.index);
      if (acc) {
        pending.delete(event.index);
        let args: Record<string, unknown> = {};
        try {
          args = acc.json.trim() ? (JSON.parse(acc.json) as Record<string, unknown>) : {};
        } catch {
          // A tool call whose arguments did not parse is a failed call, not a failed run: the loop
          // dispatches it, the tool reports what it needed, and the model corrects on the next turn.
          args = { __unparsed: acc.json };
        }
        toolCalls.push({ id: acc.id, name: acc.name, arguments: args });
      }
    } else if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens;
      if (event.message.usage.cache_read_input_tokens != null) {
        cachedInputTokens = event.message.usage.cache_read_input_tokens;
      }
      if (event.message.usage.cache_creation_input_tokens != null) {
        cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens;
      }
    } else if (event.type === 'message_delta') {
      outputTokens = event.usage.output_tokens;
      if (event.delta.stop_reason === 'max_tokens') truncated = true;
    }
  }

  // Same rule as the non-streaming path: a reply that asked for a tool instead of answering is a
  // valid reply with no prose in it.
  if (!text.trim() && toolCalls.length === 0) throw new ModelError('empty reply');
  return {
    text,
    ...(toolCalls.length ? { toolCalls } : {}),
    model,
    provider: 'anthropic',
    truncated,
    usage: {
      inputTokens,
      outputTokens,
      ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
      ...(cacheCreationInputTokens != null ? { cacheCreationInputTokens } : {}),
    },
  };
}
