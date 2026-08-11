/**
 * Meeting-transcript source.
 *
 * Speech-to-text output carries a per-line confidence, and the pipeline uses it: a low-confidence
 * line plus an unsure legitimacy verdict is held rather than guessed at. Confidence is mapped onto
 * inventory items by TIMESTAMP OVERLAP, weighted by duration — so an item extracted from a clearly
 * spoken passage is trusted even when the rest of the meeting was noisy.
 */
import type { IngestSource, IngestedSource } from './index';

export type TranscriptLine = {
  speaker?: string;
  /** Seconds from the start. */
  start: number;
  end: number;
  text: string;
  /** 0–1, when the transcriber reports it. */
  confidence?: number;
};

export type RawTranscript = {
  meetingId: string;
  deliveryId?: string;
  title?: string;
  summary?: string;
  recordedAtIso?: string;
  participants?: string[];
  lines: TranscriptLine[];
};

const hhmmss = (s: number): string =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60)]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

export function renderTranscript(lines: TranscriptLine[]): string {
  return lines
    .map((l) => `[${hhmmss(l.start)}-${hhmmss(l.end)}] ${l.speaker ? `${l.speaker}: ` : ''}${l.text}`)
    .join('\n');
}

/** `HH:MM:SS-HH:MM:SS` → seconds, or null when it is not a parseable range. */
export function parseTimestampRange(range: string): { start: number; end: number } | null {
  const m = range.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const toSec = (h: string, mm: string, ss?: string): number =>
    ss === undefined ? Number(h) * 60 + Number(mm) : Number(h) * 3600 + Number(mm) * 60 + Number(ss);
  return { start: toSec(m[1]!, m[2]!, m[3]), end: toSec(m[4]!, m[5]!, m[6]) };
}

/**
 * Duration-weighted mean confidence of the lines overlapping a window. Returns null when nothing
 * overlaps or nothing carries a confidence — null means "unknown", which downstream treats as
 * trustworthy rather than as zero.
 */
export function confidenceForWindow(lines: TranscriptLine[], window: { start: number; end: number }): number | null {
  let weighted = 0;
  let total = 0;

  for (const l of lines) {
    if (l.confidence === undefined) continue;
    const overlap = Math.min(l.end, window.end) - Math.max(l.start, window.start);
    if (overlap <= 0) continue;
    weighted += l.confidence * overlap;
    total += overlap;
  }

  return total > 0 ? weighted / total : null;
}

/** Build the per-item provenance map once the inventory exists. */
export function provenanceByItem(
  lines: TranscriptLine[],
  items: Array<{ number: number; timestamp: string }>
): Map<number, number> {
  const out = new Map<number, number>();
  for (const it of items) {
    const window = parseTimestampRange(it.timestamp);
    if (!window) continue;
    const conf = confidenceForWindow(lines, window);
    if (conf !== null) out.set(it.number, conf);
  }
  return out;
}

export const transcriptSource: IngestSource<RawTranscript> = {
  kind: 'transcript',

  normalize(raw: RawTranscript): IngestedSource {
    return {
      kind: 'transcript',
      sourceId: raw.meetingId,
      ...(raw.deliveryId ? { eventId: raw.deliveryId } : {}),
      text: renderTranscript(raw.lines),
      ...(raw.summary ? { summary: raw.summary } : {}),
      ...(raw.participants?.length ? { participantNames: raw.participants.join(', ') } : {}),
      ...(raw.recordedAtIso ? { todayIso: raw.recordedAtIso.slice(0, 10) } : {}),
    };
  },
};
