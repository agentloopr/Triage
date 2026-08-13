/**
 * Drive read client — comments and revisions on one file, over the Drive API v3.
 *
 * Three calls, because "activity on a document" is not one resource in Drive:
 *  • `GET /files/{id}` for the name — the only human-readable handle the pipeline can use;
 *  • `GET /files/{id}/comments` for comments and replies;
 *  • `GET /files/{id}/revisions` for edits.
 *
 * **`fields` is mandatory, literally.** Omit it on the comments endpoint and Drive answers
 * `400 — The 'fields' parameter is required for this method.` Verified live, 2026-08-13.
 *
 * An earlier version of this comment claimed it returned a *stripped* projection instead — comments
 * with no author, no content and no timestamp behind a 200. That would have been the silent failure
 * this repo keeps naming, and it is not what happens: Drive fails loudly, which is the better design
 * and the opposite of what was written here. The projections below are explicit because the API
 * requires them, not to dodge a trap that does not exist.
 *
 * Resolved comments are dropped. A resolved comment is a conversation someone already closed, and
 * turning it into a card re-opens by robot what a human decided was finished.
 */
import { GOOGLE_ACCESS_TOKEN, TRACKER_TIMEOUT_MS } from '../config';
import type { DriveEvent, RawDriveActivity } from '../ingest/drive';
import { ModelError, withRetryBudget } from '../providers';
import {
  DEFAULT_MAX_PAGES,
  requireToken,
  type SourceClient,
  type SourceClientOptions,
  type WindowQuery,
} from './index';

const BASE_URL = 'https://www.googleapis.com/drive/v3';
const PAGE_SIZE = 100;

export type DriveQuery = WindowQuery & {
  fileId: string;
  deliveryId?: string;
};

type CommentJson = {
  author?: { displayName?: string };
  createdTime?: string;
  content?: string;
  resolved?: boolean;
  replies?: Array<{ author?: { displayName?: string }; createdTime?: string; content?: string }>;
};

type RevisionJson = {
  modifiedTime?: string;
  lastModifyingUser?: { displayName?: string };
};

export function makeDriveClient(opts: SourceClientOptions = {}): SourceClient<RawDriveActivity, DriveQuery> {
  const token = requireToken(opts.token ?? GOOGLE_ACCESS_TOKEN, 'GOOGLE_ACCESS_TOKEN', 'the Drive source');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TRACKER_TIMEOUT_MS;

  async function call<T>(path: string): Promise<T> {
    return withRetryBudget(`drive:GET ${path}`, timeoutMs, async (signal) => {
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

  async function pagedComments(fileId: string, maxPages: number): Promise<CommentJson[]> {
    const fields =
      'nextPageToken,comments(author/displayName,createdTime,content,resolved,replies(author/displayName,createdTime,content))';
    const out: CommentJson[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const qs = `?pageSize=${PAGE_SIZE}&fields=${encodeURIComponent(fields)}${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const res = await call<{ comments?: CommentJson[]; nextPageToken?: string }>(
        `/files/${encodeURIComponent(fileId)}/comments${qs}`
      );
      out.push(...(res.comments ?? []));
      if (!res.nextPageToken) return out;
      pageToken = res.nextPageToken;
    }
    return out;
  }

  return {
    kind: 'drive',

    async fetch(query: DriveQuery): Promise<RawDriveActivity> {
      const maxPages = query.maxPages ?? DEFAULT_MAX_PAGES;
      const id = encodeURIComponent(query.fileId);

      const [file, comments, revisions] = await Promise.all([
        call<{ name?: string }>(`/files/${id}?fields=name`),
        pagedComments(query.fileId, maxPages),
        call<{ revisions?: RevisionJson[] }>(
          `/files/${id}/revisions?fields=${encodeURIComponent('revisions(modifiedTime,lastModifyingUser/displayName)')}`
        ),
      ]);

      const since = query.since;
      const inWindow = (at: string | undefined): boolean => !since || (at ?? '') >= since;

      const events: DriveEvent[] = [
        ...comments
          .filter((c) => !c.resolved)
          .flatMap((c): DriveEvent[] => [
            {
              kind: 'comment' as const,
              author: c.author?.displayName ?? 'unknown',
              at: c.createdTime ?? '',
              ...(c.content ? { text: c.content } : {}),
            },
            ...(c.replies ?? []).map((r) => ({
              kind: 'comment' as const,
              author: r.author?.displayName ?? 'unknown',
              at: r.createdTime ?? '',
              ...(r.content ? { text: r.content } : {}),
            })),
          ]),
        ...(revisions.revisions ?? []).map((r): DriveEvent => ({
          kind: 'edit',
          author: r.lastModifyingUser?.displayName ?? 'unknown',
          at: r.modifiedTime ?? '',
        })),
      ]
        // Drive filters neither comments nor revisions by time server-side, so the window is applied
        // here. Doing it after the map keeps one definition of "when did this happen".
        .filter((e) => inWindow(e.at))
        .sort((a, b) => a.at.localeCompare(b.at));

      return {
        fileId: query.fileId,
        fileName: file.name ?? query.fileId,
        ...(query.deliveryId ? { deliveryId: query.deliveryId } : {}),
        ...(since ? { dateIso: since.slice(0, 10) } : {}),
        events,
      };
    },
  };
}
