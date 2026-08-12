/**
 * Anthropic tool use, over stubbed wire responses.
 *
 * This provider has form: it was written in Phase 1 and did not execute once until Phase 4, and the
 * truncation mapping shipped untested next to it. So the mapping gets tested against the wire shape
 * *before* it is trusted, not after a live call appears to work.
 *
 * Anthropic's tool format differs from the OpenAI one in three ways that are each a 400 when wrong,
 * and one that is worse than a 400 because it looks like a provider failure: a reply that asks for a
 * tool carries no prose, and the old code threw `empty reply` on exactly that.
 *
 * `fetch` is stubbed rather than the SDK, so this exercises the provider's own request building and
 * response handling — the parts that would silently break.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicClient } from './anthropic';
import type { ToolSpec } from './index';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Captures the outgoing request body so the mapping can be asserted, not just the reply parsing. */
function capture(body: unknown): { sent: () => Record<string, unknown> } {
  let seen: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    seen = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent: () => seen };
}

const reply = (content: unknown[], stop = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content,
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 4 },
});

const TOOLS: ToolSpec[] = [
  {
    name: 'get_task',
    description: 'Fetch one board task by id.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
];

const client = () => anthropicClient({ apiKey: 'sk-test', model: 'claude-sonnet-5' });
const ask = (messages: Parameters<ReturnType<typeof client>['complete']>[0]['messages']) => ({
  key: 'agent/turn-1',
  messages,
  determinism: 'strict' as const,
});

describe('outgoing: the shape Anthropic actually wants', () => {
  it('sends tools as input_schema, not parameters', async () => {
    const cap = capture(reply([{ type: 'text', text: 'ok' }]));
    await client().complete({ ...ask([{ role: 'user', content: 'hi' }]), tools: TOOLS });

    const tools = cap.sent().tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: 'get_task', input_schema: { type: 'object' } });
    expect(tools[0]).not.toHaveProperty('parameters');
  });

  it('omits tools entirely when none are offered, rather than sending an empty array', async () => {
    const cap = capture(reply([{ type: 'text', text: 'ok' }]));
    await client().complete(ask([{ role: 'user', content: 'hi' }]));
    expect(cap.sent()).not.toHaveProperty('tools');
  });

  // There is no `tool` role in Anthropic's API. A result is a block inside a USER turn.
  it('turns a tool message into a tool_result block in a user turn', async () => {
    const cap = capture(reply([{ type: 'text', text: 'done' }]));
    await client().complete(
      ask([
        { role: 'user', content: 'check t200' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_task', arguments: { task_id: 't200' } }] },
        { role: 'tool', toolCallId: 'c1', content: '{"id":"t200"}' },
      ])
    );

    const messages = cap.sent().messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"id":"t200"}' }] });
  });

  /**
   * The one most likely to be got wrong. Two results answering one assistant turn must sit in ONE
   * user message; emitting two user turns reads as two conversational turns and is rejected.
   */
  it('merges results for one assistant turn into a single user message', async () => {
    const cap = capture(reply([{ type: 'text', text: 'done' }]));
    await client().complete(
      ask([
        { role: 'user', content: 'check both' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'get_task', arguments: { task_id: 't1' } },
            { id: 'c2', name: 'get_task', arguments: { task_id: 't2' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', content: 'one' },
        { role: 'tool', toolCallId: 'c2', content: 'two' },
      ])
    );

    const messages = cap.sent().messages as Array<{ role: string; content: unknown[] }>;
    expect(messages).toHaveLength(3);
    expect(messages[2]!.content).toHaveLength(2);
  });

  it('sends an assistant tool call as a tool_use block, omitting an empty text block', async () => {
    const cap = capture(reply([{ type: 'text', text: 'done' }]));
    await client().complete(
      ask([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_task', arguments: { task_id: 't1' } }] },
        { role: 'tool', toolCallId: 'c1', content: 'x' },
      ])
    );

    const messages = cap.sent().messages as Array<{ role: string; content: unknown[] }>;
    // An empty text block is itself a 400 — only the tool_use survives.
    expect(messages[1]!.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'get_task', input: { task_id: 't1' } }]);
  });

  it('keeps the prose when the assistant said something before calling a tool', async () => {
    const cap = capture(reply([{ type: 'text', text: 'done' }]));
    await client().complete(
      ask([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'let me look', toolCalls: [{ id: 'c1', name: 'get_task', arguments: {} }] },
        { role: 'tool', toolCallId: 'c1', content: 'x' },
      ])
    );

    const content = (cap.sent().messages as Array<{ content: Array<{ type: string }> }>)[1]!.content;
    expect(content.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('refuses a tool message with no id rather than letting the API return an opaque 400', async () => {
    capture(reply([{ type: 'text', text: 'x' }]));
    await expect(client().complete(ask([{ role: 'tool', content: 'orphan' }]))).rejects.toThrow(/no toolCallId/);
  });
});

describe('incoming: tool_use blocks become ToolCall[]', () => {
  it('extracts id, name and arguments', async () => {
    capture(reply([{ type: 'tool_use', id: 'c9', name: 'get_task', input: { task_id: 't200' } }], 'tool_use'));
    const out = await client().complete({ ...ask([{ role: 'user', content: 'go' }]), tools: TOOLS });

    expect(out.toolCalls).toEqual([{ id: 'c9', name: 'get_task', arguments: { task_id: 't200' } }]);
  });

  /**
   * The failure that would have looked like a broken provider rather than a working model: a reply
   * that asks for a tool carries NO prose, and the previous guard threw `empty reply` on it. Every
   * agent turn would have burned the retry budget on a perfectly good response.
   */
  it('does NOT treat a prose-free tool call as an empty reply', async () => {
    capture(reply([{ type: 'tool_use', id: 'c1', name: 'get_task', input: {} }], 'tool_use'));
    const out = await client().complete({ ...ask([{ role: 'user', content: 'go' }]), tools: TOOLS });

    expect(out.text).toBe('');
    expect(out.toolCalls).toHaveLength(1);
  });

  it('still rejects a genuinely empty reply — no text and no tool calls', async () => {
    capture(reply([]));
    await expect(client().complete(ask([{ role: 'user', content: 'go' }]))).rejects.toThrow(/empty reply/);
  });

  it('carries text and tool calls together when the model does both', async () => {
    capture(
      reply([
        { type: 'text', text: 'checking the board' },
        { type: 'tool_use', id: 'c1', name: 'get_task', input: { task_id: 't1' } },
      ], 'tool_use')
    );
    const out = await client().complete({ ...ask([{ role: 'user', content: 'go' }]), tools: TOOLS });

    expect(out.text).toBe('checking the board');
    expect(out.toolCalls).toHaveLength(1);
  });

  it('omits toolCalls entirely on a plain text answer, so the loop knows to stop', async () => {
    capture(reply([{ type: 'text', text: 'CATEGORY: NEW_TASK' }]));
    const out = await client().complete({ ...ask([{ role: 'user', content: 'go' }]), tools: TOOLS });

    expect(out.toolCalls).toBeUndefined();
  });
});
