/**
 * The cassette format, with the agent path's requirements on it.
 *
 * The test that matters most is the tool-call round-trip. The format used to store `result.text`
 * only, so a replayed agent turn came back with no tool calls, the loop exited on turn 0, and the
 * demo went green having done nothing — the exact failure mode the "a miss is always loud" rule
 * exists to prevent, arriving through a different door.
 *
 * The second-most-important one is backward compatibility: every cassette recorded before agents
 * existed must still replay, and its fingerprint must not move.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cassetteClient } from './cassette';
import type { CompletionRequest, CompletionResult, ModelClient } from './index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cassette-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Records whatever it is told to, once. */
const recorder = (result: Partial<CompletionResult>): ModelClient => ({
  name: 'stub',
  complete: async () => ({ text: '', model: 'm', provider: 'p', ...result }),
});

const ask = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  key: '2a/item-01',
  messages: [{ role: 'user', content: 'categorize this' }],
  determinism: 'strict',
  ...over,
});

describe('text-only replies keep the .txt format they always had', () => {
  it('records to .txt and replays byte-identically', async () => {
    const rec = cassetteClient(dir, { record: recorder({ text: 'CATEGORY: NEW_TASK' }) });
    await rec.complete(ask());

    expect(readFileSync(join(dir, '2a', 'item-01.txt'), 'utf8')).toBe('CATEGORY: NEW_TASK');

    const replay = cassetteClient(dir);
    const out = await replay.complete(ask());
    expect(out.text).toBe('CATEGORY: NEW_TASK');
    expect(out.toolCalls).toBeUndefined();
  });

  /**
   * Pinned literal, never recomputed — recomputing would pass no matter what the code did.
   *
   * This guards the tool-free fingerprint specifically. If it moves, every cassette in the repo
   * warns at once about drift that did not happen, and the warning stops meaning anything. (That the
   * committed cassettes are in fact unmoved is proven separately, by the suite emitting zero drift
   * warnings — this test is the fast, local half of that.)
   */
  it('fingerprints a tool-free request exactly as it did before tools existed', async () => {
    const rec = cassetteClient(dir, { record: recorder({ text: 'x' }) });
    await rec.complete(ask());
    expect(readFileSync(join(dir, '2a', 'item-01.txt.sha'), 'utf8')).toBe('d103045e6454');
  });
});

describe('replies that used tools round-trip in full', () => {
  const toolCalls = [
    { id: 'call_1', name: 'get_task_comments', arguments: { task_id: 't200', limit: 20 } },
    { id: 'call_2', name: 'search_tasks', arguments: { query: 'rate limiting' } },
  ];

  it('records tool calls and gives them back on replay', async () => {
    const rec = cassetteClient(dir, { record: recorder({ text: 'let me look', toolCalls }) });
    await rec.complete(ask({ key: '2a/item-01/turn-1' }));

    const replay = cassetteClient(dir);
    const out = await replay.complete(ask({ key: '2a/item-01/turn-1' }));

    expect(out.text).toBe('let me look');
    expect(out.toolCalls).toEqual(toolCalls);
  });

  it('stores them as .json, so a reader can see the whole turn', async () => {
    const rec = cassetteClient(dir, { record: recorder({ text: 'looking', toolCalls }) });
    await rec.complete(ask({ key: 'agent/turn-1' }));

    const written = readdirSync(join(dir, 'agent'));
    expect(written).toContain('turn-1.json');
    expect(written).not.toContain('turn-1.txt');

    const stored = JSON.parse(readFileSync(join(dir, 'agent', 'turn-1.json'), 'utf8')) as Record<string, unknown>;
    expect(stored).toEqual({ text: 'looking', toolCalls });
  });

  it('prefers .json when both exist — the .txt would be the same turn with its calls missing', async () => {
    mkdirSync(join(dir, 'agent'), { recursive: true });
    writeFileSync(join(dir, 'agent', 'turn-1.txt'), 'stale text-only copy', 'utf8');
    writeFileSync(join(dir, 'agent', 'turn-1.json'), JSON.stringify({ text: 'real', toolCalls }), 'utf8');

    const out = await cassetteClient(dir).complete(ask({ key: 'agent/turn-1' }));
    expect(out.text).toBe('real');
    expect(out.toolCalls).toHaveLength(2);
  });

  it('separate turns get separate cassettes', async () => {
    const rec = cassetteClient(dir, { record: recorder({ text: 'a', toolCalls }) });
    await rec.complete(ask({ key: 'agent/turn-1' }));
    await rec.complete(ask({ key: 'agent/turn-2' }));
    expect(readdirSync(join(dir, 'agent')).filter((f) => f.endsWith('.json')).sort()).toEqual(['turn-1.json', 'turn-2.json']);
  });
});

describe('the fingerprint notices what shapes an agent turn', () => {
  it('changes when the offered tools change, because the reply would too', async () => {
    const a = cassetteClient(join(dir, 'a'), { record: recorder({ text: 'x' }) });
    const b = cassetteClient(join(dir, 'b'), { record: recorder({ text: 'x' }) });
    await a.complete(ask({ key: 'k', tools: [{ name: 'get_task', description: 'd', parameters: {} }] }));
    await b.complete(ask({ key: 'k', tools: [{ name: 'search_tasks', description: 'd', parameters: {} }] }));

    expect(readFileSync(join(dir, 'a', 'k.txt.sha'), 'utf8')).not.toBe(readFileSync(join(dir, 'b', 'k.txt.sha'), 'utf8'));
  });

  it('changes when a prior turn asked for different tools, even with identical prose', async () => {
    const withCall = (taskId: string): CompletionRequest =>
      ask({
        key: 'k',
        messages: [
          { role: 'user', content: 'same' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_task', arguments: { task_id: taskId } }] },
        ],
      });

    const a = cassetteClient(join(dir, 'a'), { record: recorder({ text: 'x' }) });
    const b = cassetteClient(join(dir, 'b'), { record: recorder({ text: 'x' }) });
    await a.complete(withCall('t100'));
    await b.complete(withCall('t900'));

    expect(readFileSync(join(dir, 'a', 'k.txt.sha'), 'utf8')).not.toBe(readFileSync(join(dir, 'b', 'k.txt.sha'), 'utf8'));
  });

  it('is unmoved by tools being absent rather than empty', async () => {
    const a = cassetteClient(join(dir, 'a'), { record: recorder({ text: 'x' }) });
    const b = cassetteClient(join(dir, 'b'), { record: recorder({ text: 'x' }) });
    await a.complete(ask({ key: 'k' }));
    await b.complete(ask({ key: 'k', tools: [] }));

    expect(readFileSync(join(dir, 'a', 'k.txt.sha'), 'utf8')).toBe(readFileSync(join(dir, 'b', 'k.txt.sha'), 'utf8'));
  });
});

describe('a miss is still loud', () => {
  it('throws and names the record command rather than returning an empty reply', async () => {
    await expect(cassetteClient(dir).complete(ask({ key: 'agent/turn-3' }))).rejects.toThrow(/no cassette for "agent\/turn-3"/);
  });
});
