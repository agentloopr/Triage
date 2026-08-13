/**
 * GitHub activity source — a window of repository events.
 *
 * This is the source that proves the pipeline is not a meeting pipeline. A transcript and a channel
 * log are both *conversation*; a GitHub feed is not. Nobody commits to anything in a PR title, so
 * what Pass 1 has to find here is the other half of its definition — **reported change in the state
 * of existing work** — and the categoriser's `UPDATE` branch is what should fire, not `NEW_TASK`.
 *
 * Three real differences from a chat log, all handled here rather than leaking downstream:
 *   • no speech confidence — `provenanceByItem` is absent, which reads as "trustworthy";
 *   • an event has an *action* as well as an author, and "opened" versus "merged" is the whole
 *     signal, so it is rendered rather than dropped;
 *   • a branch name is the one place a tracker id habitually appears in the wild, so it is kept
 *     verbatim on the line. Pass 2a's match hints do the rest — this file makes no attempt to parse
 *     an id out, because guessing one wrong is worse than not offering it.
 */
import type { IngestSource, IngestedSource } from './index';

export type GithubEventKind = 'pull_request' | 'issue' | 'commit' | 'review_comment';

export type GithubEvent = {
  kind: GithubEventKind;
  /** "opened" | "merged" | "closed" | "created" — the state change, when the event carries one. */
  action?: string;
  /** PR or issue number. Absent on a bare commit. */
  number?: number;
  title: string;
  author: string;
  /** ISO timestamp. */
  at: string;
  body?: string;
  /** Head branch, when the event has one. Often carries a tracker id. */
  branch?: string;
};

export type RawGithubActivity = {
  repo: string;
  deliveryId?: string;
  dateIso?: string;
  events: GithubEvent[];
};

const clockTime = (iso: string): string => iso.match(/T(\d{2}:\d{2})/)?.[1] ?? iso;

const LABEL: Record<GithubEventKind, string> = {
  pull_request: 'PR',
  issue: 'issue',
  commit: 'commit',
  review_comment: 'review',
};

/** One line per event, in the same `[time] who: what` shape every other source renders to. */
export function renderGithubActivity(events: GithubEvent[]): string {
  return events
    .map((e) => {
      const ref = e.number != null ? `${LABEL[e.kind]} #${e.number}` : LABEL[e.kind];
      const act = e.action ? ` ${e.action}` : '';
      const branch = e.branch ? ` (branch: ${e.branch})` : '';
      const body = e.body?.trim() ? `\n    ${e.body.trim().replace(/\n/g, '\n    ')}` : '';
      return `[${clockTime(e.at)}] ${e.author} — ${ref}${act}: ${e.title}${branch}${body}`;
    })
    .join('\n');
}

export const githubSource: IngestSource<RawGithubActivity> = {
  kind: 'github',

  normalize(raw: RawGithubActivity): IngestedSource {
    const authors = [...new Set(raw.events.map((e) => e.author))];

    return {
      kind: 'github',
      // Scoped to the day for the same reason a channel log is: the repo id alone would make every
      // subsequent day of activity look like a redelivery of the first.
      sourceId: `${raw.repo}:${raw.dateIso ?? raw.events[0]?.at.slice(0, 10) ?? 'undated'}`,
      ...(raw.deliveryId ? { eventId: raw.deliveryId } : {}),
      text: renderGithubActivity(raw.events),
      summary: `Repository activity in ${raw.repo}.`,
      ...(authors.length ? { participantNames: authors.join(', ') } : {}),
      ...(raw.dateIso ? { todayIso: raw.dateIso.slice(0, 10) } : {}),
    };
  },
};
