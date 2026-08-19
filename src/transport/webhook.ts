/**
 * Webhook signature verification and request routing — the load-bearing half of `npm run serve`.
 *
 * Pure functions over a plain `WebhookRequest`, deliberately decoupled from `node:http`: a test calls
 * `handleWebhookRequest` directly with a fabricated request and asserts on the returned response, no
 * listening socket involved. `src/cli/serve.ts` is the thin adapter that reads a real request into
 * this shape and writes the response back out.
 *
 * **Exactly three routes exist** — `POST /hooks/github`, `POST /hooks/slack`, `GET /healthz` —
 * everything else 404s. That is what keeps §9's "no debug route" gate meaningfully true for a repo
 * that now runs an HTTP server: the route table is closed and a test pins it.
 *
 * Two vendor signature schemes, both HMAC-SHA256 over the RAW body — read as bytes before any JSON
 * parse, because a signature computed over the wire bytes never matches one computed over a
 * re-serialized object:
 *  • **GitHub** — `X-Hub-Signature-256: sha256=<hex>` over the body alone.
 *  • **Slack** — `X-Slack-Signature: v0=<hex>` over `v0:{timestamp}:{body}`, plus a ±5-minute
 *    timestamp window. The window is the only thing that makes a captured, still-valid signature
 *    eventually stop working — the HMAC alone never expires.
 *
 * **Ack fast, then process.** Both platforms retry on a slow acknowledgement — the exact reason the
 * `event` idempotency layer exists (`ARCHITECTURE.md`) — so the handler responds as soon as the
 * signature and JSON parse succeed, and hands the payload to its caller as a background promise
 * (`done`) rather than awaiting it before responding. `serve.ts` lets `done` run and logs a rejection;
 * a test can await it to assert the handler actually ran.
 *
 * **Fail closed on missing configuration.** `requireWebhookSecret` refuses to start rather than
 * accept unsigned deliveries — the same posture `requireToken` already takes for the read clients.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireToken } from '../sources/index';

export type WebhookRequest = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
};

export type WebhookResponse = { status: number; body: string };

export type WebhookConfig = {
  githubSecret: string;
  slackSigningSecret: string;
  onGithub: (payload: unknown, deliveryId: string | undefined) => Promise<void>;
  onSlack: (payload: unknown) => Promise<void>;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
};

const SLACK_TIMESTAMP_TOLERANCE_S = 300;

export const requireWebhookSecret = (secret: string, envVar: string): string =>
  requireToken(secret, envVar, 'the webhook receiver');

/** `timingSafeEqual` throws on a length mismatch rather than returning false — guard it here once. */
function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function verifyGithubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return timingSafeEqualUtf8(header, expected);
}

export function verifySlackSignature(
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
  nowMs: number
): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1_000 - ts) > SLACK_TIMESTAMP_TOLERANCE_S) return false;
  const base = `v0:${timestampHeader}:${rawBody.toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
  return timingSafeEqualUtf8(signatureHeader, expected);
}

function parseJson(rawBody: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawBody.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export async function handleWebhookRequest(
  req: WebhookRequest,
  config: WebhookConfig
): Promise<{ response: WebhookResponse; done: Promise<void> }> {
  const now = config.now ?? Date.now;
  const settled = Promise.resolve();

  if (req.method === 'GET' && req.path === '/healthz') {
    return { response: { status: 200, body: 'ok' }, done: settled };
  }

  if (req.method === 'POST' && req.path === '/hooks/github') {
    if (!verifyGithubSignature(req.rawBody, req.headers['x-hub-signature-256'], config.githubSecret)) {
      return { response: { status: 401, body: 'bad signature' }, done: settled };
    }
    const parsed = parseJson(req.rawBody);
    if (!parsed.ok) return { response: { status: 400, body: 'bad json' }, done: settled };

    const done = Promise.resolve(config.onGithub(parsed.value, req.headers['x-github-delivery'])).catch((err: unknown) => {
      console.error(`[webhook] github handler failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { response: { status: 202, body: 'accepted' }, done };
  }

  if (req.method === 'POST' && req.path === '/hooks/slack') {
    if (!verifySlackSignature(req.rawBody, req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature'], config.slackSigningSecret, now())) {
      return { response: { status: 401, body: 'bad signature' }, done: settled };
    }
    const parsed = parseJson(req.rawBody);
    if (!parsed.ok) return { response: { status: 400, body: 'bad json' }, done: settled };

    // Slack's Events API setup step: sign it like every other request, then echo the challenge back.
    const body = parsed.value as { type?: string; challenge?: string };
    if (body.type === 'url_verification') {
      return { response: { status: 200, body: JSON.stringify({ challenge: body.challenge ?? '' }) }, done: settled };
    }

    const done = Promise.resolve(config.onSlack(parsed.value)).catch((err: unknown) => {
      console.error(`[webhook] slack handler failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { response: { status: 202, body: 'accepted' }, done };
  }

  return { response: { status: 404, body: 'not found' }, done: settled };
}
