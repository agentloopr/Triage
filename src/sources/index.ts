/**
 * The source-read seam — how the repo gets a payload out of a real service.
 *
 * This is the other half of `src/ingest/`. A `SourceClient` talks to a service and returns the raw
 * shape; the matching `IngestSource` turns that shape into an `IngestedSource`. Keeping them apart is
 * what lets the whole pipeline be tested with no network at all: every fixture is a raw payload, and
 * the client is the only thing that ever needs a credential.
 *
 * **Read-only by construction, not by policy.** There is no write method on this interface, so there
 * is nothing to guard, disable or review. That is the same guarantee `readOnlyTracker` gives the
 * agent layer, moved one level earlier — enforced by the type rather than by a wrapper that has to
 * remember to refuse.
 *
 * What is deliberately NOT here, and is your problem: webhooks, polling schedules, cron, OAuth token
 * refresh, and the queue that hands a payload to `runPipeline`. Those are product surface and every
 * team's are different.
 *
 * These clients are proven against **hand-written fakes speaking each vendor's documented wire
 * format** — the same standard, and the same limitation, as the tracker adapters. A fake proves the
 * client's own logic: pagination, field mapping, error handling, the credential check. It cannot
 * prove an endpoint path, a field name or an auth header, because the fake was written from the same
 * reading of the docs as the client it tests. See LIMITATIONS.md.
 */
import type { SourceKind } from '../ingest';

/** Injectable for tests; defaults to `globalThis.fetch` in each client. */
export type FetchImpl = typeof globalThis.fetch;

export interface SourceClientOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Overrides the credential from `config.ts`. Tests pass a placeholder. */
  token?: string;
}

/**
 * A read-only client for one service.
 *
 * `TQuery` is per-service on purpose. A single "fetch a window" shape would need a repo, a thread id
 * and a file id all optional, and every client would start by checking which one it got.
 */
export interface SourceClient<TRaw, TQuery> {
  readonly kind: SourceKind;
  fetch(query: TQuery): Promise<TRaw>;
}

/** Shared by the clients that read a time window rather than a single addressed object. */
export type WindowQuery = {
  /** ISO timestamp; only activity at or after this is returned. */
  since?: string;
  /** Hard cap on pages, so a busy repo cannot turn one run into an unbounded crawl. */
  maxPages?: number;
};

export const DEFAULT_MAX_PAGES = 10;

/**
 * Fail at construction with a named error rather than at the first request with a 401.
 *
 * A 401 from a missing token reads exactly like a 401 from a wrong one, and the two have completely
 * different fixes. `makeTracker()` does this for the same reason.
 */
export function requireToken(token: string | undefined, envVar: string, what: string): string {
  if (!token) throw new Error(`${what} needs ${envVar}`);
  return token;
}
