/**
 * Email-thread source — one thread, oldest message first.
 *
 * The subject line is the only piece of structure email has that chat does not, and it is worth
 * keeping: it is usually the closest thing to a title anybody wrote down. It goes in `summary`
 * rather than being prepended to the text, because `text` is what the grounding rule binds Pass 1
 * to — a title nobody actually wrote in a message body is exactly the kind of invented wording the
 * grounding rule exists to stop.
 *
 * Two differences from a chat log, both handled here:
 *   • no speech confidence — `provenanceByItem` is absent, which reads as "trustworthy";
 *   • quoted reply chains. Email bodies carry the entire thread history under every reply, and
 *     feeding that verbatim means Pass 1 reads the same sentence five times and extracts it five
 *     times. `stripQuoted` cuts at the usual markers.
 */
import type { IngestSource, IngestedSource } from './index';

export type EmailMessage = {
  from: string;
  /** ISO timestamp. */
  at: string;
  body: string;
};

export type RawEmailThread = {
  threadId: string;
  deliveryId?: string;
  subject: string;
  messages: EmailMessage[];
};

const clockTime = (iso: string): string => iso.match(/T(\d{2}:\d{2})/)?.[1] ?? iso;

/**
 * Drop a quoted reply chain.
 *
 * Conservative on purpose: it cuts at the first line that looks like an attribution header or a
 * `>` quote block, and does nothing if it finds neither. Over-trimming loses real content, which is
 * a worse failure than leaving a duplicate paragraph the consolidator can still merge.
 */
export function stripQuoted(body: string): string {
  const lines = body.split('\n');
  const cut = lines.findIndex(
    (l) => /^\s*>/.test(l) || /^\s*On .+ wrote:\s*$/.test(l) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(l)
  );
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim();
}

export function renderEmailThread(messages: EmailMessage[]): string {
  return messages
    .map((m) => `[${clockTime(m.at)}] ${m.from}:\n    ${stripQuoted(m.body).replace(/\n/g, '\n    ')}`)
    .join('\n');
}

export const gmailSource: IngestSource<RawEmailThread> = {
  kind: 'gmail',

  normalize(raw: RawEmailThread): IngestedSource {
    const senders = [...new Set(raw.messages.map((m) => m.from))];

    return {
      kind: 'gmail',
      // A thread id is already the underlying thing — unlike a channel or a repo, a thread does not
      // continue into a new day under the same identity, so there is nothing to scope it by.
      sourceId: raw.threadId,
      ...(raw.deliveryId ? { eventId: raw.deliveryId } : {}),
      text: renderEmailThread(raw.messages),
      summary: `Email thread: ${raw.subject}`,
      ...(senders.length ? { participantNames: senders.join(', ') } : {}),
      ...(raw.messages[0]?.at ? { todayIso: raw.messages[raw.messages.length - 1]!.at.slice(0, 10) } : {}),
    };
  },
};
