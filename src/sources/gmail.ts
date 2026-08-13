/**
 * Gmail read client — one thread, over the Gmail API v1.
 *
 * `GET /gmail/v1/users/me/threads/{id}?format=full` returns every message with its MIME tree. Two
 * things about that tree are worth knowing before reading the code, because both are silent failures
 * rather than errors:
 *
 *  1. **The body is base64url, not base64.** Gmail substitutes `-` and `_` for `+` and `/`. Node's
 *     `Buffer` decoder is lenient and accepts both alphabets, so naming the wrong one is survivable
 *     *here* — it is named correctly anyway, because that leniency is a Node implementation detail
 *     and not a property of base64. A stricter decoder (`atob`, most other languages) rejects or
 *     mangles the same input.
 *  2. **The body is not always at the top.** A message with an attachment or an HTML alternative is
 *     `multipart/*`, and the text lives in a nested part. Reading `payload.body.data` alone returns
 *     empty for exactly the messages people write in practice, so the tree is walked for the first
 *     `text/plain`. HTML-only mail is skipped rather than stripped of tags — a bad text extraction
 *     that reaches Pass 1 is worse than an absent one, because the grounding rule then binds the
 *     inventory to markup.
 */
import { GOOGLE_ACCESS_TOKEN, TRACKER_TIMEOUT_MS } from '../config';
import type { EmailMessage, RawEmailThread } from '../ingest/gmail';
import { ModelError, withRetryBudget } from '../providers';
import { requireToken, type SourceClient, type SourceClientOptions } from './index';

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1';

export type GmailQuery = {
  threadId: string;
  deliveryId?: string;
};

type PartJson = {
  mimeType?: string;
  body?: { data?: string };
  parts?: PartJson[];
};

type MessageJson = {
  id: string;
  internalDate?: string;
  payload?: PartJson & { headers?: Array<{ name: string; value: string }> };
};

type ThreadJson = { id: string; messages?: MessageJson[] };

const header = (m: MessageJson, name: string): string | undefined =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

/** Gmail's base64url → text. `Buffer` handles the alphabet natively given the right encoding name. */
export function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Depth-first walk for the first `text/plain` part. Returns '' when the message is HTML-only. */
export function firstTextPart(part: PartJson | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBody(part.body.data);
  for (const child of part.parts ?? []) {
    const found = firstTextPart(child);
    if (found) return found;
  }
  return '';
}

export function makeGmailClient(opts: SourceClientOptions = {}): SourceClient<RawEmailThread, GmailQuery> {
  const token = requireToken(opts.token ?? GOOGLE_ACCESS_TOKEN, 'GOOGLE_ACCESS_TOKEN', 'the Gmail source');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TRACKER_TIMEOUT_MS;

  async function call<T>(path: string): Promise<T> {
    return withRetryBudget(`gmail:GET ${path}`, timeoutMs, async (signal) => {
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal,
        });
      } catch (err) {
        throw new ModelError(`network: ${(err as Error)?.message ?? String(err)}`);
      }

      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        throw new ModelError('rate limited', Number.isFinite(after) && after > 0 ? after * 1_000 : 5_000);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new ModelError(`HTTP ${res.status}: ${detail}`, res.status >= 500 ? 2_000 : null);
      }
      return (await res.json()) as T;
    });
  }

  return {
    kind: 'gmail',

    async fetch(query: GmailQuery): Promise<RawEmailThread> {
      const thread = await call<ThreadJson>(`/users/me/threads/${encodeURIComponent(query.threadId)}?format=full`);
      const raw = thread.messages ?? [];

      const messages: EmailMessage[] = raw.map((m): EmailMessage => ({
        from: header(m, 'From') ?? 'unknown',
        // `internalDate` is epoch millis as a string and is always present; the Date header is
        // sender-supplied and can be absent or wrong.
        at: new Date(Number(m.internalDate ?? 0)).toISOString(),
        body: firstTextPart(m.payload),
      }));

      return {
        threadId: thread.id,
        ...(query.deliveryId ? { deliveryId: query.deliveryId } : {}),
        subject: (raw[0] && header(raw[0], 'Subject')) || '(no subject)',
        messages,
      };
    },
  };
}
