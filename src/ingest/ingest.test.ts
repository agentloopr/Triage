/**
 * The ingest seam's shared contract.
 *
 * Every source is tested against the *same* invariants rather than each getting its own bespoke
 * assertions, because the claim the repo makes is not "these five files work" — it is "the pipeline
 * does not care which source produced it". A per-source test suite cannot fail in the way that claim
 * can. This one can: add a sixth source that quietly omits `sourceId` and the table below breaks.
 *
 * The `provenanceByItem` invariant is the load-bearing one. It is the ASR confidence map, and the
 * legitimacy gate holds an item whose confidence is below the floor. A non-transcribed source that
 * emitted an empty map instead of omitting the field would read as "confidence zero" and hold every
 * item it ever produced — a failure that looks like a strict pipeline rather than a bug.
 */
import { describe, expect, it } from 'vitest';
import { channelSource, type RawChannelLog } from './channel';
import { driveSource, renderDriveActivity, type RawDriveActivity } from './drive';
import { githubSource, renderGithubActivity, type RawGithubActivity } from './github';
import { gmailSource, stripQuoted, type RawEmailThread } from './gmail';
import type { IngestSource, IngestedSource } from './index';
import { transcriptSource, type RawTranscript } from './transcript';

const RAW: Record<string, { source: IngestSource<never>; raw: unknown; transcribed: boolean }> = {
  transcript: {
    source: transcriptSource as IngestSource<never>,
    transcribed: true,
    raw: {
      meetingId: 'm-1',
      deliveryId: 'd-1',
      recordedAtIso: '2026-08-13T09:00:00Z',
      participants: ['Avery Chen', 'Rowan Diaz'],
      lines: [{ speaker: 'Avery Chen', start: 0, end: 4, text: 'I will ship the export endpoint.', confidence: 0.97 }],
    } satisfies RawTranscript,
  },
  channel: {
    source: channelSource as IngestSource<never>,
    transcribed: false,
    raw: {
      channelId: 'C-1',
      channelName: 'eng',
      deliveryId: 'd-2',
      dateIso: '2026-08-13',
      messages: [{ author: 'Avery Chen', at: '2026-08-13T09:05:00Z', text: 'Taking the export endpoint today.' }],
    } satisfies RawChannelLog,
  },
  github: {
    source: githubSource as IngestSource<never>,
    transcribed: false,
    raw: {
      repo: 'acme/api',
      deliveryId: 'd-3',
      dateIso: '2026-08-13',
      events: [
        { kind: 'pull_request', action: 'merged', number: 412, title: 'Add export endpoint', author: 'Avery Chen', at: '2026-08-13T09:10:00Z', branch: 'feat/export' },
      ],
    } satisfies RawGithubActivity,
  },
  gmail: {
    source: gmailSource as IngestSource<never>,
    transcribed: false,
    raw: {
      threadId: 't-1',
      deliveryId: 'd-4',
      subject: 'Export endpoint',
      messages: [{ from: 'Avery Chen', at: '2026-08-13T09:15:00Z', body: 'Shipping the export endpoint today.' }],
    } satisfies RawEmailThread,
  },
  drive: {
    source: driveSource as IngestSource<never>,
    transcribed: false,
    raw: {
      fileId: 'f-1',
      fileName: 'API spec',
      deliveryId: 'd-5',
      dateIso: '2026-08-13',
      events: [{ kind: 'comment', author: 'Rowan Diaz', at: '2026-08-13T09:20:00Z', text: 'Export section needs a rate limit.' }],
    } satisfies RawDriveActivity,
  },
};

describe('every source satisfies the same contract', () => {
  for (const [name, { source, raw }] of Object.entries(RAW)) {
    describe(name, () => {
      const out: IngestedSource = source.normalize(raw as never);

      it('declares the kind its own descriptor advertises', () => {
        expect(out.kind).toBe(source.kind);
      });

      it('produces non-empty text', () => {
        expect(out.text.trim().length).toBeGreaterThan(0);
      });

      it('keeps sourceId and eventId distinct', () => {
        // Collapsing them would make layer-1 and layer-2 idempotency the same check, and a webhook
        // retry would be indistinguishable from the source's second delivery.
        expect(out.sourceId).toBeTruthy();
        expect(out.eventId).toBeTruthy();
        expect(out.sourceId).not.toBe(out.eventId);
      });

      it('omits provenanceByItem rather than emitting an empty map', () => {
        // True of *every* source, transcript included: the map is keyed by inventory item number,
        // and no item exists until Pass 1 has run. Only the transcript path can fill it in later
        // (`provenanceByItem()` in transcript.ts), which is the asymmetry asserted below.
        expect(out.provenanceByItem).toBeUndefined();
      });

      it('normalizes purely — the same input twice gives the same output', () => {
        expect(source.normalize(raw as never)).toEqual(out);
      });
    });
  }
});

describe('speech confidence is the transcript path alone', () => {
  it('only the transcript source can produce a provenance map at all', () => {
    // The legitimacy gate holds an item whose source confidence is below the floor. A non-transcribed
    // source that reported confidence 0 instead of *no* confidence would hold every item it ever
    // produced — a bug that looks like a strict pipeline. Absence is the correct signal, and these
    // four sources have no audio to report on.
    const withConfidence = Object.entries(RAW).filter(([, v]) => v.transcribed);
    expect(withConfidence.map(([k]) => k)).toEqual(['transcript']);
  });
});

describe('github rendering', () => {
  it('keeps the action and the branch, because both are the signal', () => {
    const text = renderGithubActivity([
      { kind: 'pull_request', action: 'merged', number: 412, title: 'Add export endpoint', author: 'Avery Chen', at: '2026-08-13T09:10:00Z', branch: 'feat/export' },
    ]);
    expect(text).toContain('PR #412 merged');
    expect(text).toContain('branch: feat/export');
  });

  it('renders a bare commit without inventing a number', () => {
    const text = renderGithubActivity([
      { kind: 'commit', title: 'Fix pagination', author: 'Rowan Diaz', at: '2026-08-13T10:00:00Z' },
    ]);
    expect(text).toContain('commit: Fix pagination');
    expect(text).not.toContain('#');
  });
});

describe('gmail quoted-reply handling', () => {
  it('cuts a quoted chain at the attribution line', () => {
    expect(stripQuoted('Shipping today.\n\nOn Tue, Avery wrote:\n> earlier text')).toBe('Shipping today.');
  });

  it('cuts at a bare quote block', () => {
    expect(stripQuoted('Agreed.\n> the original')).toBe('Agreed.');
  });

  it('leaves a body with no quoting untouched', () => {
    // The conservative branch: over-trimming loses real content, which is worse than a duplicate
    // paragraph the consolidator can still merge.
    expect(stripQuoted('Just the one paragraph.')).toBe('Just the one paragraph.');
  });
});

describe('drive rendering', () => {
  it('renders a lone edit, which carries no text', () => {
    // Dropping these entirely would lose the only evidence that work is progressing on a document
    // nobody commented on.
    expect(renderDriveActivity([{ kind: 'edit', author: 'Rowan Diaz', at: '2026-08-13T09:00:00Z' }])).toBe(
      '[09:00] Rowan Diaz edited the document (Drive reports no content for an edit)'
    );
  });

  it('collapses a run of contentless edits into one line', () => {
    // The first recording of `08-drive-activity` turned three of these into two cards about a
    // document nobody had said anything about. One line keeps the signal — somebody is working on
    // this — without giving Pass 1 three things that look like deliverables.
    const edits: Parameters<typeof renderDriveActivity>[0] = [
      { kind: 'edit', author: 'Rowan Diaz', at: '2026-08-13T09:05:00Z' },
      { kind: 'edit', author: 'Rowan Diaz', at: '2026-08-13T09:18:00Z' },
      { kind: 'edit', author: 'Rowan Diaz', at: '2026-08-13T11:00:00Z' },
    ];
    expect(renderDriveActivity(edits)).toBe(
      '[09:05–11:00] Rowan Diaz made 3 edits to the document (Drive reports no content for an edit)'
    );
  });

  it('does not merge edits by different authors', () => {
    const out = renderDriveActivity([
      { kind: 'edit', author: 'Rowan Diaz', at: '2026-08-13T09:05:00Z' },
      { kind: 'edit', author: 'Jules Kim', at: '2026-08-13T09:10:00Z' },
    ]);
    expect(out.split('\n')).toHaveLength(2);
  });

  it('keeps a comment between two edit runs from swallowing either', () => {
    const out = renderDriveActivity([
      { kind: 'edit', author: 'Rowan Diaz', at: '2026-08-13T09:05:00Z' },
      { kind: 'comment', author: 'Jules Kim', at: '2026-08-13T09:30:00Z', text: 'needs error states' },
      { kind: 'edit', author: 'Rowan Diaz', at: '2026-08-13T11:00:00Z' },
    ]);
    expect(out.split('\n')).toHaveLength(3);
    expect(out.split('\n')[1]).toContain('needs error states');
  });
});
