/**
 * Document-activity source — comments, edits and suggestions on one file.
 *
 * The thin one of the three, and honest about it. An `edit` event carries no text — Drive tells you
 * *that* someone edited, not what they wrote — so most of what Pass 1 can act on comes from comments
 * and suggestions. An edit still renders, because "Rowan edited the spec three times this morning"
 * is legitimate evidence for an `UPDATE` even though it names no deliverable on its own.
 *
 * That is the interesting property of this source and the reason it is worth shipping: it is the one
 * where **most events are not actionable**, so it exercises the same restraint `03-meeting-noise`
 * tests — an extractor that turns every signal into a card would produce a card per keystroke here.
 */
import type { IngestSource, IngestedSource } from './index';

export type DriveEventKind = 'comment' | 'edit' | 'suggestion';

export type DriveEvent = {
  kind: DriveEventKind;
  author: string;
  /** ISO timestamp. */
  at: string;
  /** Absent on an `edit` — Drive reports that a revision happened, not its content. */
  text?: string;
};

export type RawDriveActivity = {
  fileId: string;
  fileName: string;
  deliveryId?: string;
  dateIso?: string;
  events: DriveEvent[];
};

const clockTime = (iso: string): string => iso.match(/T(\d{2}:\d{2})/)?.[1] ?? iso;

const VERB: Record<DriveEventKind, string> = {
  comment: 'commented',
  edit: 'edited the document',
  suggestion: 'suggested',
};

/**
 * Contentless edits are collapsed into one line per author, deliberately.
 *
 * Drive reports *that* a revision happened, never what changed, so an edit carries no text. Rendered
 * one-per-line they look exactly like the events that do carry content, and an extractor reading
 * three of them in a row will write three cards about a document nobody said anything about — which
 * is what the first recording of `08-drive-activity` did, producing two cards out of pure noise.
 *
 * One summary line preserves the only signal an edit actually has — somebody is working on this,
 * this often, in this window — while giving Pass 1 nothing to mistake for a deliverable.
 */
export function renderDriveActivity(events: DriveEvent[]): string {
  const lines: string[] = [];
  let run: DriveEvent[] = [];

  const flushEdits = (): void => {
    if (!run.length) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const when = run.length === 1 ? clockTime(first.at) : `${clockTime(first.at)}–${clockTime(last.at)}`;
    const what = run.length === 1 ? 'edited the document' : `made ${run.length} edits to the document`;
    lines.push(`[${when}] ${first.author} ${what} (Drive reports no content for an edit)`);
    run = [];
  };

  for (const e of events) {
    if (e.kind === 'edit' && !e.text?.trim()) {
      // Only consecutive edits by the same author collapse; a different author is a different fact.
      if (run.length && run[0]!.author !== e.author) flushEdits();
      run.push(e);
      continue;
    }
    flushEdits();
    const body = e.text?.trim() ? `: ${e.text.trim()}` : '';
    lines.push(`[${clockTime(e.at)}] ${e.author} ${VERB[e.kind]}${body}`);
  }
  flushEdits();

  return lines.join('\n');
}

export const driveSource: IngestSource<RawDriveActivity> = {
  kind: 'drive',

  normalize(raw: RawDriveActivity): IngestedSource {
    const authors = [...new Set(raw.events.map((e) => e.author))];

    return {
      kind: 'drive',
      // Day-scoped, like a channel and a repo: a document goes on being edited, and the file id
      // alone would suppress every day after the first.
      sourceId: `${raw.fileId}:${raw.dateIso ?? raw.events[0]?.at.slice(0, 10) ?? 'undated'}`,
      ...(raw.deliveryId ? { eventId: raw.deliveryId } : {}),
      text: renderDriveActivity(raw.events),
      summary: `Activity on "${raw.fileName}".`,
      ...(authors.length ? { participantNames: authors.join(', ') } : {}),
      ...(raw.dateIso ? { todayIso: raw.dateIso.slice(0, 10) } : {}),
    };
  },
};
