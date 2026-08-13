/**
 * The model seam. Every pass in this pipeline reaches a model through exactly one interface, which
 * is what lets the whole thing run offline against recorded cassettes.
 *
 * Two decisions here are load-bearing and are NOT stylistic:
 *
 *  1. `determinism` is a portable enum, never a raw sampling number. Anthropic's current models
 *     reject `temperature`/`top_p`/`top_k` outright, so a shared `temperature: 0` field would make
 *     the interface unimplementable by one of its two real providers.
 *
 *  2. `timeoutMs` is the TOTAL wall-clock budget for a call INCLUDING retries — not a per-attempt
 *     timeout. Getting this wrong is how a "600s" call becomes a 30-minute hang: three attempts each
 *     granted the full timeout, plus backoffs, with no overall ceiling.
 */

export type Determinism = 'strict' | 'balanced' | 'exploratory';

/**
 * A tool the model may call.
 *
 * Read-only by construction here: the loop only ever offers reads, and the adapter behind it refuses
 * writes regardless of what the model asks for. Tool definitions are a request, not a guarantee —
 * the guarantee lives at the adapter.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** On a `tool` message: which call this answers. */
  toolCallId?: string;
  /** On an `assistant` message that requested calls, so the provider can echo them back. */
  toolCalls?: ToolCall[];
}

export interface CompletionRequest {
  /** e.g. "2a/item-07" — both the cassette lookup key and the trace label. */
  key: string;
  system?: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  /** TOTAL wall-clock budget across all retries. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  determinism?: Determinism;
  /** Offering tools does not oblige the model to use them; absent or empty disables tool use. */
  tools?: ToolSpec[];
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  usage?: CompletionUsage;
  /**
   * The model hit its output ceiling and the reply is INCOMPLETE.
   *
   * This is a failure, not a success with less text. A truncated Pass 1 silently drops the tail of a
   * long meeting — every item discussed in the last ten minutes vanishes, and the manifest still
   * parses cleanly, so nothing downstream notices. Callers must route `truncated` to their fallback
   * rather than accepting the partial.
   */
  truncated?: boolean;
  /** Present when the model asked to call tools instead of answering. */
  toolCalls?: ToolCall[];
}

export interface ModelClient {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Don't start a RETRY with less budget left than this — a doomed second call just burns the
 * remainder to arrive at the same failure.
 *
 * The first attempt is deliberately exempt. Gating it too means any `timeoutMs` below this floor
 * makes zero calls and fails with "no result within the Nms budget", which is true, useless, and
 * looks exactly like a provider outage.
 */
const MIN_RETRY_MS = 5_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;

export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/**
 * Run `attempt` up to MAX_ATTEMPTS times inside a single wall-clock budget.
 *
 * Each attempt is handed a signal that aborts at whatever is LEFT of the budget, and every backoff
 * is clamped to the remaining time — so a server-controlled `Retry-After` cannot push the call past
 * its deadline. Shared by both live providers because both had to get this identically right.
 */
export async function withRetryBudget<T>(
  label: string,
  timeoutMs: number,
  attempt: (signal: AbortSignal, attemptNo: number) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const remaining = deadline - Date.now();
    // The first attempt always runs if any budget remains; only retries are subject to the floor.
    if (remaining <= 0 || (n > 1 && remaining < MIN_RETRY_MS)) break;

    try {
      return await attempt(AbortSignal.timeout(remaining), n);
    } catch (err) {
      lastErr = err;
      const askedMs = err instanceof ModelError ? err.retryAfterMs : RETRY_BASE_MS * n;
      if (askedMs === null) throw err; // provider says this one is not worth retrying

      const backoffMs = Math.min(askedMs, Math.max(0, deadline - Date.now()));
      if (n >= MAX_ATTEMPTS || deadline - Date.now() - backoffMs < MIN_RETRY_MS) break;

      console.warn(
        `[${label}] attempt ${n}/${MAX_ATTEMPTS} failed (${errText(err)}) — retrying in ${backoffMs}ms`
      );
      await sleep(backoffMs);
    }
  }

  throw new ModelError(
    `[${label}] no result within the ${timeoutMs}ms budget: ${errText(lastErr)}`
  );
}

export function errText(err: unknown): string {
  return ((err as Error)?.message || String(err)).slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
