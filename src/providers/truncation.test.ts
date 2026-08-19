import { describe, it, expect, afterEach, vi } from 'vitest';
import { anthropicClient } from './anthropic';
import { deepseekClient } from './deepseek';

/**
 * A hit output ceiling must surface as `truncated`, on both providers, from the real wire field.
 *
 * This is the single most important line in `EXTRACTION.md`'s carried-forward list: a truncated reply
 * is a failure, not a short success. A truncated Pass 1 drops everything discussed in the last ten
 * minutes of a meeting, and the manifest it produces still parses perfectly — so nothing downstream
 * has any way to notice. The only signal is this flag.
 *
 * Both providers set it, and until now neither had a test. That is exactly the shape of the four
 * controls the review before this extraction found: correctly configured, doing nothing. The mapping
 * is one field name away from silently breaking — a rename, or an SDK moving `stop_reason` onto a
 * different event — and every other test in this repo would stay green.
 *
 * `fetch` is stubbed rather than the SDK, so this exercises the providers' own response handling.
 */
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function respondWith(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

const deepseekReply = (finish: string) => ({
  model: 'deepseek-v4-pro',
  choices: [{ message: { content: 'ITEM: 1\nTITLE: half an ans' }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

const anthropicReply = (stop: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'ITEM: 1\nTITLE: half an ans' }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4 },
});

const REQ = { key: '1/inventory', messages: [{ role: 'user' as const, content: 'extract the items' }] };

describe('deepseek — finish_reason', () => {
  it('surfaces truncated when the ceiling was hit', async () => {
    respondWith(deepseekReply('length'));
    const res = await deepseekClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.truncated).toBe(true);
  });

  it('does not flag a reply that finished on its own', async () => {
    respondWith(deepseekReply('stop'));
    const res = await deepseekClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.truncated).toBe(false);
    expect(res.text).toContain('ITEM: 1');
  });

  // A missing field must not read as "fine". Absent is unknown, and unknown is not a guarantee.
  it('does not claim a clean finish when the field is absent', async () => {
    respondWith({ ...deepseekReply('stop'), choices: [{ message: { content: 'text' } }] });
    const res = await deepseekClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.truncated).not.toBe(true);
  });
});

describe('anthropic — stop_reason', () => {
  it('surfaces truncated when max_tokens was hit', async () => {
    respondWith(anthropicReply('max_tokens'));
    const res = await anthropicClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.truncated).toBe(true);
  });

  it('does not flag a reply that ended at a natural stop', async () => {
    respondWith(anthropicReply('end_turn'));
    const res = await anthropicClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.truncated).toBe(false);
    expect(res.text).toContain('ITEM: 1');
  });
});

/** Both providers report usage the same way, which is what makes a cross-provider cost table possible. */
describe('usage is reported in the shared shape', () => {
  it('deepseek', async () => {
    respondWith(deepseekReply('stop'));
    const res = await deepseekClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  it('anthropic', async () => {
    respondWith(anthropicReply('end_turn'));
    const res = await anthropicClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  // cache_read and cache_creation are priced oppositely (a discount vs a premium over base input —
  // see PROVIDERS.md) and Anthropic reports them as two separate fields. Collapsing either into the
  // other silently mispriced every cost figure this repo publishes the first time this ran live.
  it('anthropic reports cache reads and cache writes as two separate fields, not one', async () => {
    respondWith({ ...anthropicReply('end_turn'), usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } });
    const res = await anthropicClient({ apiKey: 'test-key' }).complete(REQ);
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 100, cacheCreationInputTokens: 50 });
  });
});
