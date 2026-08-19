/**
 * Slack read client — a window of one channel's history, over the Slack Web API.
 *
 * This is the read half `README.md` says was missing: a `channel` source already exists
 * ([`ingest/channel.ts`](../ingest/channel.ts)) and normalizes a `RawChannelLog` exactly the same way
 * whether it came from Slack, a Discord export or a pasted transcript. What was absent was a client
 * that could go fetch one from Slack itself. There is still no sixth `SourceKind` — a Slack channel
 * log *is* the `channel` source, the same argument the README already makes.
 *
 * Two calls: `conversations.history` for the messages, `users.list` once to turn `U…` ids into names
 * a human reads (`ChannelMessage.author`, per `channel.ts`, is a display name, not an id).
 *
 * Two vendor quirks that are silent failures rather than errors, same standard as the other clients
 * in this directory:
 *  • **Slack answers `ok: false` inside a 200.** A `res.ok` check alone passes on every API failure —
 *    an expired token reads as an empty, successful channel.
 *  • **`ts` is float-seconds-as-a-string** (`"1533107618.000134"`), not ISO. Treat it as a number and
 *    every message sorts and stamps at the Unix epoch.
 *
 * A reply is any message whose `thread_ts` differs from its own `ts` — the thread's *parent* message
 * carries a `thread_ts` equal to its own `ts`, and is not itself a reply.
 */
import { SLACK_BOT_TOKEN, TRACKER_TIMEOUT_MS } from '../config';
import type { ChannelMessage, RawChannelLog } from '../ingest/channel';
import { ModelError, withRetryBudget } from '../providers';
import { DEFAULT_MAX_PAGES, requireToken, type SourceClient, type SourceClientOptions, type WindowQuery } from './index';

const BASE_URL = 'https://slack.com/api';

export type SlackQuery = WindowQuery & {
  channelId: string;
  channelName?: string;
  deliveryId?: string;
};

type SlackMessageJson = {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
};

type SlackUserJson = {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
};

/** Slack's own format: seconds, with microseconds after the decimal point — not milliseconds. */
function tsToIso(ts: string): string {
  return new Date(Number(ts) * 1_000).toISOString();
}

function isoToSlackTs(iso: string): string {
  return (Date.parse(iso) / 1_000).toFixed(6);
}

function displayName(u: SlackUserJson): string {
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;
}

export function makeSlackClient(opts: SourceClientOptions = {}): SourceClient<RawChannelLog, SlackQuery> {
  const token = requireToken(opts.token ?? SLACK_BOT_TOKEN, 'SLACK_BOT_TOKEN', 'the Slack source');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TRACKER_TIMEOUT_MS;

  async function call<T>(method: string, params: Record<string, string>): Promise<T> {
    return withRetryBudget(`slack:${method}`, timeoutMs, async (signal) => {
      const qs = new URLSearchParams(params).toString();
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}/${method}?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
      } catch (err) {
        throw new ModelError(`network: ${(err as Error)?.message ?? String(err)}`);
      }

      // Slack's own rate-limit response: 429 with `Retry-After` in SECONDS, not milliseconds.
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        throw new ModelError('rate limited', Math.min((Number.isFinite(after) && after > 0 ? after : 5) * 1_000, 60_000));
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new ModelError(`HTTP ${res.status}: ${detail}`, res.status >= 500 ? 2_000 : null);
      }

      const json = (await res.json()) as { ok: boolean; error?: string };
      // The quirk this whole client is built around: a 200 with `ok: false` is Slack's error shape,
      // not `res.ok`'s. Skipping this check turns an expired token into a silently empty channel.
      if (!json.ok) throw new ModelError(`slack:${method} — ${json.error ?? 'unknown error'}`, null);
      return json as T;
    });
  }

  async function fetchAllUsers(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    let cursor = '';
    for (let page = 0; page < DEFAULT_MAX_PAGES; page++) {
      const res = await call<{ members: SlackUserJson[]; response_metadata?: { next_cursor?: string } }>(
        'users.list',
        cursor ? { cursor, limit: '200' } : { limit: '200' }
      );
      for (const u of res.members) names.set(u.id, displayName(u));
      cursor = res.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    return names;
  }

  return {
    kind: 'channel',

    async fetch(query: SlackQuery): Promise<RawChannelLog> {
      const maxPages = query.maxPages ?? DEFAULT_MAX_PAGES;
      const names = await fetchAllUsers();

      const raw: SlackMessageJson[] = [];
      let cursor = '';
      for (let page = 0; page < maxPages; page++) {
        const params: Record<string, string> = { channel: query.channelId, limit: '200' };
        if (cursor) params.cursor = cursor;
        if (query.since) params.oldest = isoToSlackTs(query.since);
        const res = await call<{ messages: SlackMessageJson[]; has_more: boolean; response_metadata?: { next_cursor?: string } }>(
          'conversations.history',
          params
        );
        raw.push(...res.messages);
        cursor = res.has_more ? (res.response_metadata?.next_cursor ?? '') : '';
        if (!cursor) break;
      }

      // System events (channel_join, channel_topic, …) carry no author's words worth a card.
      const messages: ChannelMessage[] = raw
        .filter((m) => m.type === 'message' && !m.subtype && (m.text ?? '').length > 0)
        .map((m) => ({
          author: (m.user && names.get(m.user)) || m.bot_id || m.user || 'unknown',
          at: tsToIso(m.ts),
          text: m.text ?? '',
          ...(m.thread_ts && m.thread_ts !== m.ts ? { replyToId: m.thread_ts } : {}),
        }))
        .sort((a, b) => a.at.localeCompare(b.at));

      return {
        channelId: query.channelId,
        ...(query.channelName ? { channelName: query.channelName } : {}),
        ...(query.deliveryId ? { deliveryId: query.deliveryId } : {}),
        ...(query.since ? { dateIso: query.since.slice(0, 10) } : {}),
        messages,
      };
    },
  };
}
