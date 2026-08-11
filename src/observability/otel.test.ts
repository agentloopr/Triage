import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { PipelineEvents } from '../pipeline/events';
import type { ModelClient } from '../providers';
import { traceEvents, traceModelClient } from './otel';

/**
 * These assertions read real recorded spans rather than checking that the module exists.
 *
 * That distinction is the reason this file is longer than the one it tests. Four separate controls in
 * the review that preceded this extraction looked correctly configured while doing nothing at all —
 * configuration is a claim, and only an observed effect is evidence. A tracing module is unusually
 * good at passing a shallow test: it is *designed* to swallow its own failures, so "no error" is
 * exactly what a completely broken one produces too.
 *
 * The SDK is a devDependency. Nothing here ships it; a consumer registers whatever provider they
 * already run, and with none registered the spans are no-ops.
 */
const exporter = new InMemorySpanExporter();

const spanNamed = (name: string): ReadableSpan | undefined =>
  exporter.getFinishedSpans().find((s) => s.name === name);

const OK: ModelClient = {
  name: 'stub',
  complete: async (req) => ({
    text: `reply to ${req.key}`,
    model: 'stub-model-1',
    provider: 'stub-provider',
    usage: { inputTokens: 1_200, outputTokens: 340, cachedInputTokens: 900 },
  }),
};

beforeEach(() => {
  exporter.reset();
  trace.disable();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  );
});

afterEach(() => {
  trace.disable();
  vi.unstubAllEnvs();
});

describe('traceModelClient', () => {
  it('names the span after the request key, so a span maps to a pass and an item', async () => {
    await traceModelClient(OK).complete({ key: '2a/item-01', messages: [{ role: 'user', content: 'hi' }] });
    expect(spanNamed('2a/item-01')).toBeDefined();
  });

  it('records model, provider and usage under the GenAI convention names', async () => {
    await traceModelClient(OK).complete({
      key: '2a/item-01',
      messages: [{ role: 'user', content: 'hi' }],
      determinism: 'strict',
    });

    expect(spanNamed('2a/item-01')!.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'stub-provider',
      'gen_ai.response.model': 'stub-model-1',
      'gen_ai.request.determinism': 'strict',
      'gen_ai.usage.input_tokens': 1_200,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.usage.cached_input_tokens': 900,
    });
  });

  /** A truncated reply is a failed result that arrived successfully. A span must not call it a win. */
  it('marks a truncated reply as an error, not a cheap success', async () => {
    const truncating: ModelClient = {
      name: 'stub',
      complete: async () => ({ text: 'half a', model: 'm', provider: 'p', truncated: true }),
    };
    await traceModelClient(truncating).complete({ key: '1/inventory', messages: [] });

    const span = spanNamed('1/inventory')!;
    expect(span.attributes['gen_ai.response.truncated']).toBe(true);
    expect(span.status.code).toBe(2); // ERROR
  });

  it('records the exception and still rethrows', async () => {
    const failing: ModelClient = {
      name: 'stub',
      complete: async () => {
        throw new Error('provider exploded');
      },
    };

    await expect(
      traceModelClient(failing).complete({ key: '2b/item-01', messages: [] })
    ).rejects.toThrow('provider exploded');

    const span = spanNamed('2b/item-01')!;
    expect(span.status.code).toBe(2);
    expect(span.events.map((e) => e.name)).toContain('exception');
  });

  /**
   * Prompt text is the meeting. Turning on tracing is not a decision to widen who can read a
   * transcript, so the default has to be the quiet one.
   */
  it('attaches no prompt or completion text by default', async () => {
    await traceModelClient(OK).complete({
      key: '2a/item-01',
      system: 'you are a categorizer',
      messages: [{ role: 'user', content: 'the private thing that was said' }],
    });

    const attrs = spanNamed('2a/item-01')!.attributes;
    expect(attrs['gen_ai.prompt']).toBeUndefined();
    expect(attrs['gen_ai.completion']).toBeUndefined();
    expect(JSON.stringify(attrs)).not.toContain('private thing');
  });

  it('attaches redacted text when capture is explicitly turned on', async () => {
    vi.stubEnv('OTEL_CAPTURE_IO', 'true');
    vi.resetModules();
    const { traceModelClient: fresh } = await import('./otel');

    await fresh(OK).complete({
      key: '2a/item-02',
      messages: [{ role: 'user', content: 'token pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 in the text' }],
    });

    const prompt = String(spanNamed('2a/item-02')!.attributes['gen_ai.prompt']);
    expect(prompt).toContain('in the text');
    expect(prompt).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });
});

describe('traceEvents', () => {
  it('brackets a pass with one span and carries its item count', () => {
    const events = new PipelineEvents();
    traceEvents(events);

    events.emit({ type: 'pass:start', pass: '2a', itemCount: 7 });
    events.emit({ type: 'pass:done', pass: '2a', ms: 12, detail: '7 categorized' });

    const span = spanNamed('pass 2a')!;
    expect(span.attributes['ops.pass.item_count']).toBe(7);
    expect(span.attributes['ops.pass.detail']).toBe('7 categorized');
  });

  it('records outcome counts without recording what the items said', () => {
    const events = new PipelineEvents();
    traceEvents(events);

    events.emit({
      type: 'items:held',
      items: [
        { item: 1, title: 'a confidential-sounding title', gate: 'uncertain field(s)', question: 'which list?' },
        { item: 2, title: 'another one', gate: 'uncertain field(s)', question: 'who owns it?' },
      ],
    });
    events.emit({ type: 'executed', created: 2, commented: 1, skipped: 1, failed: 0, refused: 0, unsupported: 0 });

    const held = spanNamed('items:held')!;
    expect(held.attributes['ops.items.held']).toBe(2);
    expect(held.attributes['ops.held.gates']).toBe('uncertain field(s)');
    expect(JSON.stringify(held.attributes)).not.toContain('confidential-sounding');
    expect(spanNamed('executed')!.attributes['ops.exec.created']).toBe(2);
  });

  it('marks an alert as an error span', () => {
    const events = new PipelineEvents();
    traceEvents(events);
    events.emit({ type: 'alert', detail: 'Pass 1 output was truncated' });
    expect(spanNamed('alert')!.status.code).toBe(2);
  });

  it('stops emitting once unsubscribed', () => {
    const events = new PipelineEvents();
    traceEvents(events)();
    events.emit({ type: 'pass:start', pass: '2a' });
    events.emit({ type: 'pass:done', pass: '2a', ms: 1 });
    expect(spanNamed('pass 2a')).toBeUndefined();
  });
});

/**
 * The fail-open contract, which is the only property here that can break a run.
 *
 * With no provider registered — the default for anyone who just installed this — the API hands back
 * non-recording spans and everything still has to work. An observability outage that takes the
 * pipeline down with it is strictly worse than having no observability.
 */
describe('with no tracer provider registered', () => {
  beforeEach(() => trace.disable());

  it('runs the model call exactly once and returns its result', async () => {
    const complete = vi.fn(OK.complete);
    const res = await traceModelClient({ name: 'stub', complete }).complete({ key: 'k', messages: [] });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.text).toBe('reply to k');
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('still propagates a provider failure rather than swallowing it', async () => {
    const failing: ModelClient = {
      name: 'stub',
      complete: async () => {
        throw new Error('provider exploded');
      },
    };
    await expect(traceModelClient(failing).complete({ key: 'k', messages: [] })).rejects.toThrow('provider exploded');
  });

  it('takes events without throwing', () => {
    const events = new PipelineEvents();
    traceEvents(events);
    expect(() => events.emit({ type: 'alert', detail: 'x' })).not.toThrow();
  });
});
