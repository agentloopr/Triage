/**
 * GitHub read client — a window of repository activity, over the REST API.
 *
 * Two endpoints, because GitHub splits the thing a human thinks of as "what happened in this repo"
 * across two of them:
 *
 *  • `GET /repos/{owner}/{repo}/issues` — **issues and pull requests both.** The REST API treats
 *    every PR as an issue, and a PR is distinguishable only by the presence of a `pull_request` key
 *    on the payload. That is a documented quirk and the single easiest thing to get wrong here: read
 *    this endpoint naively and every PR in the window is mislabelled an issue.
 *  • `GET /repos/{owner}/{repo}/commits` — commits, which the issues endpoint never returns.
 *
 * `since` is honoured server-side by both. The issues endpoint filters on *update* time rather than
 * creation, which is what we want — a PR opened last week and merged this morning belongs in this
 * morning's window.
 *
 * Not fetched: review comments. `GithubEventKind` has a slot for them because production reads them,
 * but they need a third endpoint per PR, and an N+1 crawl over a busy repo is a poor trade for a
 * reference implementation. The slot is honest about the gap rather than pretending the kind is
 * unused.
 */
import { GITHUB_TOKEN, TRACKER_TIMEOUT_MS } from '../config';
import type { GithubEvent, RawGithubActivity } from '../ingest/github';
import { ModelError, withRetryBudget } from '../providers';
import {
  DEFAULT_MAX_PAGES,
  requireToken,
  type SourceClient,
  type SourceClientOptions,
  type WindowQuery,
} from './index';

const BASE_URL = 'https://api.github.com';
const PAGE_SIZE = 100;

export type GithubQuery = WindowQuery & {
  /** "owner/repo". */
  repo: string;
  /** Stamped onto the payload as the delivery id when the caller has one. */
  deliveryId?: string;
};

type IssueJson = {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  created_at: string;
  updated_at: string;
  body?: string | null;
  /** Present ONLY on pull requests. The sole way to tell them apart on this endpoint. */
  pull_request?: { merged_at?: string | null };
};

type CommitJson = {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } };
  author?: { login?: string };
};

/** "opened" / "merged" / "closed" from an issue-or-PR payload. */
function actionOf(i: IssueJson): string {
  if (i.pull_request) return i.pull_request.merged_at ? 'merged' : i.state === 'closed' ? 'closed' : 'opened';
  return i.state === 'closed' ? 'closed' : 'opened';
}

export function makeGithubClient(opts: SourceClientOptions = {}): SourceClient<RawGithubActivity, GithubQuery> {
  const token = requireToken(opts.token ?? GITHUB_TOKEN, 'GITHUB_TOKEN', 'the GitHub source');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? TRACKER_TIMEOUT_MS;

  async function call<T>(path: string): Promise<T> {
    return withRetryBudget(`github:GET ${path}`, timeoutMs, async (signal) => {
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal,
        });
      } catch (err) {
        throw new ModelError(`network: ${(err as Error)?.message ?? String(err)}`);
      }

      // GitHub reports both primary and secondary rate limits as 403 with a remaining count of 0,
      // which is NOT the same as a permissions 403 — resending the latter never succeeds.
      if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
        // `Retry-After` first, then the reset window. GitHub's own guidance is in that order, and
        // the two describe different limits: `Retry-After` comes with a *secondary* limit and is the
        // only accurate number for it, while `x-ratelimit-reset` describes the hourly primary quota.
        //
        // An earlier version read only the reset header, so a 429 carrying `Retry-After: 1` fell
        // through `Number(null) === 0` to the 5s default and waited five times too long. Nothing
        // failed — the retry still happened and the test still passed. Only the elapsed time in the
        // test report gave it away, which is why the assertion below is on the delay and not just on
        // the fact that a retry occurred.
        const after = Number(res.headers.get('retry-after'));
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const waitMs =
          Number.isFinite(after) && after > 0
            ? after * 1_000
            : Number.isFinite(reset) && reset > 0
              ? Math.max(0, reset * 1_000 - Date.now())
              : 5_000;
        throw new ModelError('rate limited', Math.min(waitMs, 60_000) || 5_000);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new ModelError(`HTTP ${res.status}: ${detail}`, res.status >= 500 ? 2_000 : null);
      }
      return (await res.json()) as T;
    });
  }

  /** Walks pages until short-read or the cap. A cap, not a promise of completeness — see the log. */
  async function paged<T>(build: (page: number) => string, maxPages: number): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await call<T[]>(build(page));
      out.push(...batch);
      if (batch.length < PAGE_SIZE) return out;
    }
    return out;
  }

  return {
    kind: 'github',

    async fetch(query: GithubQuery): Promise<RawGithubActivity> {
      const maxPages = query.maxPages ?? DEFAULT_MAX_PAGES;
      const since = query.since ? `&since=${encodeURIComponent(query.since)}` : '';
      const repo = query.repo;

      const [issues, commits] = await Promise.all([
        paged<IssueJson>(
          (p) => `/repos/${repo}/issues?state=all&per_page=${PAGE_SIZE}&page=${p}${since}`,
          maxPages
        ),
        paged<CommitJson>((p) => `/repos/${repo}/commits?per_page=${PAGE_SIZE}&page=${p}${since}`, maxPages),
      ]);

      const events: GithubEvent[] = [
        ...issues.map((i): GithubEvent => ({
          kind: i.pull_request ? 'pull_request' : 'issue',
          action: actionOf(i),
          number: i.number,
          title: i.title,
          author: i.user?.login ?? 'unknown',
          at: i.updated_at,
          ...(i.body ? { body: i.body } : {}),
        })),
        ...commits.map((c): GithubEvent => ({
          kind: 'commit',
          // A commit message's first line is its title; the rest is the body, and conflating them
          // puts a paragraph where the pipeline expects a one-liner.
          title: c.commit.message.split('\n')[0] ?? c.sha.slice(0, 7),
          author: c.author?.login ?? c.commit.author?.name ?? 'unknown',
          at: c.commit.author?.date ?? new Date(0).toISOString(),
        })),
      ].sort((a, b) => a.at.localeCompare(b.at));

      return {
        repo,
        ...(query.deliveryId ? { deliveryId: query.deliveryId } : {}),
        ...(query.since ? { dateIso: query.since.slice(0, 10) } : {}),
        events,
      };
    },
  };
}
