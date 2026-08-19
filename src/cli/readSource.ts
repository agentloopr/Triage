/**
 * The read half of the source seam, as a plain function — factored out of `pull.ts` so `poll.ts` can
 * fetch the same four sources without either duplicating the vendor-specific client calls or
 * depending on `pull.ts`'s argv-parsing shape.
 *
 * Kept intentionally thin: fetch the raw payload, log a one-line count, normalize it. Both halves of
 * the seam (`SourceClient` fetch, `IngestSource` normalize), in order, nothing else.
 */
import type { IngestedSource } from '../ingest';
import { channelSource } from '../ingest/channel';
import { driveSource } from '../ingest/drive';
import { githubSource } from '../ingest/github';
import { gmailSource } from '../ingest/gmail';
import { makeDriveClient } from '../sources/drive';
import { makeGithubClient } from '../sources/github';
import { makeGmailClient } from '../sources/gmail';
import { makeSlackClient } from '../sources/slack';

export type SourceTarget =
  | { source: 'github'; repo: string; since?: string }
  | { source: 'gmail'; thread: string }
  | { source: 'drive'; file: string; since?: string }
  | { source: 'slack'; channel: string; since?: string };

export async function readSource(target: SourceTarget): Promise<IngestedSource> {
  switch (target.source) {
    case 'github': {
      const raw = await makeGithubClient().fetch({
        repo: target.repo,
        ...(target.since ? { since: target.since } : {}),
      });
      console.log(`  ${raw.events.length} event(s) from ${raw.repo}`);
      return githubSource.normalize(raw);
    }
    case 'gmail': {
      const raw = await makeGmailClient().fetch({ threadId: target.thread });
      console.log(`  ${raw.messages.length} message(s) in "${raw.subject}"`);
      return gmailSource.normalize(raw);
    }
    case 'drive': {
      const raw = await makeDriveClient().fetch({
        fileId: target.file,
        ...(target.since ? { since: target.since } : {}),
      });
      console.log(`  ${raw.events.length} event(s) on "${raw.fileName}"`);
      return driveSource.normalize(raw);
    }
    case 'slack': {
      const raw = await makeSlackClient().fetch({
        channelId: target.channel,
        ...(target.since ? { since: target.since } : {}),
      });
      console.log(`  ${raw.messages.length} message(s) from #${raw.channelId}`);
      return channelSource.normalize(raw);
    }
  }
}
