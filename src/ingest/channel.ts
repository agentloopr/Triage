/**
 * Channel-log source — a thread or a day's messages from a team chat.
 *
 * The point of this file is how *little* it does. It renders messages into the same text shape a
 * transcript produces and hands back the same `IngestedSource`; every pass downstream is unchanged.
 * If porting a second source needed more than this, the pipeline would not actually be
 * source-agnostic — it would just be a meeting pipeline with a second entry point.
 *
 * Two real differences, both handled here rather than leaking downstream:
 *   • no speech confidence — `provenanceByItem` is absent, which reads as "trustworthy";
 *   • no timestamps in the transcript sense — messages carry wall-clock times, which are rendered
 *     but are not a media offset, so items from this source carry no usable TIMESTAMP window.
 */
import type { IngestSource, IngestedSource } from './index';

export type ChannelMessage = {
  author: string;
  /** ISO timestamp. */
  at: string;
  text: string;
  /** Present on a threaded reply. */
  replyToId?: string;
};

export type RawChannelLog = {
  channelId: string;
  channelName?: string;
  deliveryId?: string;
  dateIso?: string;
  messages: ChannelMessage[];
};

const clockTime = (iso: string): string => {
  const t = iso.match(/T(\d{2}:\d{2})/)?.[1];
  return t ?? iso;
};

export function renderChannelLog(messages: ChannelMessage[]): string {
  return messages.map((m) => `[${clockTime(m.at)}] ${m.author}${m.replyToId ? ' (reply)' : ''}: ${m.text}`).join('\n');
}

export const channelSource: IngestSource<RawChannelLog> = {
  kind: 'channel',

  normalize(raw: RawChannelLog): IngestedSource {
    const participants = [...new Set(raw.messages.map((m) => m.author))];

    return {
      kind: 'channel',
      // Scoped to the day, so re-delivering the same channel on a later date is genuinely new work
      // rather than a duplicate — the channel id alone would suppress every subsequent day.
      sourceId: `${raw.channelId}:${raw.dateIso ?? raw.messages[0]?.at.slice(0, 10) ?? 'undated'}`,
      ...(raw.deliveryId ? { eventId: raw.deliveryId } : {}),
      text: renderChannelLog(raw.messages),
      ...(raw.channelName ? { summary: `Messages from #${raw.channelName}.` } : {}),
      ...(participants.length ? { participantNames: participants.join(', ') } : {}),
      ...(raw.dateIso ? { todayIso: raw.dateIso.slice(0, 10) } : {}),
    };
  },
};
