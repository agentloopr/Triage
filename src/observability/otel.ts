/**
 * OpenTelemetry spans, opt-in and vendor-neutral.
 *
 * This is a **library**, so it takes `@opentelemetry/api` and nothing else — no SDK, no exporter, no
 * backend. That package is a no-op until the host application registers a tracer provider, which is
 * what lets the offline demo keep running with zero configuration and zero network access while the
 * same code emits real spans inside an app that already has tracing.
 *
 * Two seams cover the whole pipeline, and neither requires touching a pass:
 *
 *   • `traceModelClient` — every model call in this repo goes through `ModelClient`, so one decorator
 *     instruments all of them. The request `key` ("2a/item-07") is already the span name.
 *   • `traceEvents` — every pass already announces itself on `PipelineEvents`.
 *
 * Attribute names follow the OTel GenAI semantic conventions (`gen_ai.*`) rather than the vocabulary
 * of the system this was extracted from, whose spans were shaped by its tracing vendor. Reproducing
 * a vendor's attribute names in a module advertised as vendor-neutral would make the label false in
 * the only place a user would check.
 *
 * **Tracing never changes behaviour.** If span creation throws, the work still runs, exactly once —
 * the same fail-open contract the production version carries, for the same reason: an observability
 * outage that takes down the pipeline is worse than no observability.
 */
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { OTEL_CAPTURE_IO, OTEL_CAPTURE_IO_MAX_CHARS } from '../config';
import type { PipelineEvent, PipelineEvents } from '../pipeline/events';
import type { CompletionRequest, CompletionResult, ModelClient } from '../providers';
import { redactSecretsInText } from '../utils/security';

const TRACER_NAME = 'ops-agent-reference';

/** Wrap a client so each `complete()` becomes a span. Returns a client, so it composes anywhere. */
export function traceModelClient(client: ModelClient): ModelClient {
  return {
    name: client.name,
    complete: (req) => withSpan(req.key, (span) => runModelCall(client, req, span)),
  };
}

async function runModelCall(
  client: ModelClient,
  req: CompletionRequest,
  span: Span | null
): Promise<CompletionResult> {
  if (span) {
    span.setAttribute('gen_ai.operation.name', 'chat');
    span.setAttribute('gen_ai.system', client.name);
    if (req.determinism) span.setAttribute('gen_ai.request.determinism', req.determinism);
    if (req.maxOutputTokens) span.setAttribute('gen_ai.request.max_tokens', req.maxOutputTokens);
    if (OTEL_CAPTURE_IO) span.setAttribute('gen_ai.prompt', capture(promptText(req)));
  }

  try {
    const res = await client.complete(req);
    if (span) {
      span.setAttribute('gen_ai.system', res.provider);
      span.setAttribute('gen_ai.response.model', res.model);
      if (res.usage) {
        span.setAttribute('gen_ai.usage.input_tokens', res.usage.inputTokens);
        span.setAttribute('gen_ai.usage.output_tokens', res.usage.outputTokens);
        if (res.usage.cachedInputTokens !== undefined) {
          span.setAttribute('gen_ai.usage.cached_input_tokens', res.usage.cachedInputTokens);
        }
      }
      if (OTEL_CAPTURE_IO) span.setAttribute('gen_ai.completion', capture(res.text));
      // Not an exception — the call succeeded. It is still a failed *result*, and a span that does
      // not say so makes a truncated pass look like a cheap one.
      if (res.truncated) {
        span.setAttribute('gen_ai.response.truncated', true);
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'output truncated' });
      }
    }
    return res;
  } catch (err) {
    if (span) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
    }
    throw err;
  }
}

/**
 * Turn pipeline events into spans. Returns the unsubscribe.
 *
 * `pass:start`/`pass:done` bracket a span. Everything else is emitted between passes rather than
 * inside one, so it lands as its own zero-duration span carrying the counts — which is what a
 * dashboard wants anyway: "how many were held on this run" is a fact about the run, not about a pass.
 */
export function traceEvents(events: PipelineEvents): () => void {
  const open = new Map<string, Span>();

  return events.on((event) => {
    try {
      if (event.type === 'pass:start') {
        const span = tracer()?.startSpan(`pass ${event.pass}`);
        if (!span) return;
        if (event.itemCount !== undefined) span.setAttribute('ops.pass.item_count', event.itemCount);
        open.set(event.pass, span);
        return;
      }

      if (event.type === 'pass:done') {
        const span = open.get(event.pass);
        if (!span) return;
        open.delete(event.pass);
        if (event.detail) span.setAttribute('ops.pass.detail', event.detail);
        span.end();
        return;
      }

      const span = tracer()?.startSpan(event.type);
      if (!span) return;
      for (const [k, v] of Object.entries(eventAttributes(event))) span.setAttribute(k, v);
      if (event.type === 'alert') span.setStatus({ code: SpanStatusCode.ERROR, message: event.detail });
      span.end();
    } catch {
      // A listener that throws must not reach the pipeline. `PipelineEvents` already swallows this,
      // but relying on a caller's error handling for our own correctness is how it stops being true.
    }
  });
}

/** Counts only. The item titles are the meeting's content, and spans are not where that belongs. */
function eventAttributes(event: PipelineEvent): Record<string, string | number | boolean> {
  switch (event.type) {
    case 'skipped':
      return { 'ops.skip.layer': event.layer, 'ops.skip.reason': event.reason };
    case 'items:uncategorized':
      return { 'ops.items.uncategorized': event.items.length };
    case 'items:held':
      return {
        'ops.items.held': event.items.length,
        'ops.held.gates': [...new Set(event.items.map((i) => i.gate))].sort().join(','),
      };
    case 'items:skipped-not-task':
      return { 'ops.items.skipped_not_task': event.items.length };
    case 'flags':
      return { 'ops.flags.kinds': [...new Set(event.flags.map((f) => f.kind))].sort().join(',') };
    case 'executed':
      return {
        'ops.exec.created': event.created,
        'ops.exec.commented': event.commented,
        'ops.exec.skipped': event.skipped,
        'ops.exec.failed': event.failed,
        'ops.exec.refused': event.refused,
        'ops.exec.unsupported': event.unsupported,
      };
    case 'audit':
      return { 'ops.audit.passed': event.passed, 'ops.audit.mismatched': event.mismatched };
    case 'alert':
      return { 'ops.alert.detail': event.detail };
    default:
      return {};
  }
}

/**
 * Run `fn` inside a span, or without one if tracing is unavailable or refuses to start.
 *
 * The body runs exactly once on every path. That is the whole contract.
 */
async function withSpan<T>(name: string, fn: (span: Span | null) => Promise<T>): Promise<T> {
  let span: Span | null = null;
  try {
    span = tracer()?.startSpan(name) ?? null;
  } catch {
    span = null;
  }

  try {
    return await fn(span);
  } finally {
    try {
      span?.end();
    } catch {
      /* ending a span must not mask the result of the work it measured */
    }
  }
}

function tracer() {
  try {
    return trace.getTracer(TRACER_NAME);
  } catch {
    return null;
  }
}

function promptText(req: CompletionRequest): string {
  return [req.system ?? '', ...req.messages.map((m) => `${m.role}: ${m.content}`)].join('\n\n').trim();
}

function capture(text: string): string {
  const redacted = redactSecretsInText(text);
  return redacted.length > OTEL_CAPTURE_IO_MAX_CHARS
    ? `${redacted.slice(0, OTEL_CAPTURE_IO_MAX_CHARS)}… [${redacted.length} chars total]`
    : redacted;
}

function errMessage(err: unknown): string {
  return ((err as Error)?.message || String(err)).slice(0, 200);
}
