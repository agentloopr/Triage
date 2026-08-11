import { describe, it, expect } from 'vitest';
import {
  type CategorizationItem,
  MANIFEST_END,
  MANIFEST_START,
  categoryBreakdown,
  formatCategorizationManifest,
  parseCategorizationItem,
  splitManifestBlocks,
} from './categorizationManifest';

/** One item per category, every optional field populated — the round-trip surface. */
const GOLDEN: CategorizationItem[] = [
  {
    item: 1,
    title: 'Add rate limiting to the public API',
    timestamp: '00:04:12-00:05:30',
    category: 'NEW_TASK',
    list: 'backend',
    assignee: 'Avery Chen',
    priority: 'high',
    dueDate: '2026-09-01',
    status: 'to do',
    finalDesc: 'Add a token-bucket limiter in front of the public endpoints.',
    confidence: 'high',
    rationale: 'Nothing on the board covers this.',
    tier2Cited: false,
    raw: '',
  },
  {
    item: 2,
    title: 'Onboarding revamp',
    category: 'DUPLICATE',
    existingTaskId: 'abc123',
    confidence: 'med',
    rationale: 'Checked task-comments on abc123; same deliverable, nothing new added.',
    tier2Cited: true,
    raw: '',
  },
  {
    item: 3,
    title: 'Wire the welcome email',
    category: 'SUBTASK',
    parentTaskId: 'abc123',
    list: 'backend',
    assignee: 'Rowan Diaz',
    finalDesc: 'Send the welcome email as part of first-run.',
    confidence: 'high',
    rationale: 'task-comments on abc123 shows this is in scope of the parent.',
    tier2Cited: true,
    raw: '',
  },
  {
    item: 4,
    title: 'Billing page copy',
    category: 'UPDATE',
    existingTaskId: 'def456',
    notifyAssignee: 'Jules Kim',
    list: 'design',
    status: 'in progress',
    finalDesc: 'Copy was approved in the meeting; moving to in progress.',
    confidence: 'high',
    rationale: 'task-comments on def456 confirms it is the same card.',
    tier2Cited: true,
    raw: '',
  },
  {
    item: 5,
    title: 'Link the two auth cards',
    category: 'RELATE',
    linkTaskId1: 'ghi789',
    linkTaskId2: 'jkl012',
    confidence: 'low',
    rationale: 'list-tasks shows both exist and overlap.',
    tier2Cited: true,
    raw: '',
  },
  {
    item: 6,
    title: 'Something vague about pricing',
    category: 'NEW_TASK',
    list: 'growth',
    assignee: 'Noor Haddad',
    finalDesc: 'Revisit pricing tiers.',
    uncertainFields: [
      { field: 'assignee', reason: 'two people claimed it', suggested: 'Noor Haddad' },
      { field: 'list', reason: 'could be product or growth' },
    ],
    confidence: 'low',
    rationale: 'Nothing matches, but ownership is unclear.',
    tier2Cited: false,
    raw: '',
  },
];

/** `raw` is the model's original text, which cannot survive a format→parse cycle. */
const withoutRaw = (i: CategorizationItem) => ({ ...i, raw: '' });

describe('grammar freeze', () => {
  it('round-trips every category losslessly', () => {
    const text = formatCategorizationManifest(GOLDEN);
    const blocks = splitManifestBlocks(text);
    expect(blocks).toHaveLength(GOLDEN.length);

    const parsed = blocks.map((b, i) => parseCategorizationItem(b, GOLDEN[i]!.item));
    expect(parsed.map((p) => withoutRaw(p!))).toEqual(GOLDEN.map(withoutRaw));
  });

  it('splits on the same boundary the eval harness uses', () => {
    const text = formatCategorizationManifest(GOLDEN);
    expect(splitManifestBlocks(text).every((b) => /^ITEM:\s*\d+/m.test(b))).toBe(true);
  });

  it('keeps the wire format stable', () => {
    // A deliberate canary. If this changes, every recorded cassette and every stored trace was
    // written against a different grammar — re-record before trusting any of them.
    expect(formatCategorizationManifest([GOLDEN[1]!])).toBe(
      [
        MANIFEST_START,
        '',
        'ITEM: 2',
        'TITLE: Onboarding revamp',
        'CATEGORY: DUPLICATE',
        'EXISTING_TASK_ID: abc123',
        'CONFIDENCE: med',
        'RATIONALE: Checked task-comments on abc123; same deliverable, nothing new added.',
        '',
        MANIFEST_END,
      ].join('\n')
    );
  });
});

describe('parseCategorizationItem', () => {
  it('parses a bare block with no manifest markers', () => {
    const item = parseCategorizationItem(
      ['ITEM: 7', 'TITLE: Ship it', 'CATEGORY: NEW_TASK', 'LIST: backend'].join('\n'),
      99
    );
    expect(item).toMatchObject({ item: 7, title: 'Ship it', category: 'NEW_TASK', list: 'backend' });
  });

  it('falls back to the supplied item number when ITEM: is missing', () => {
    expect(parseCategorizationItem('TITLE: No number\nCATEGORY: NEW_TASK', 42)?.item).toBe(42);
  });

  // When a full manifest is split per-item, the LAST block carries END without START. If the END
  // strip were gated on START, the terminator would be swallowed as a RATIONALE continuation line —
  // polluting the final item of every re-parsed manifest, including every stored trace.
  it('strips a trailing END marker even when START is absent', () => {
    const item = parseCategorizationItem(
      ['ITEM: 1', 'TITLE: T', 'CATEGORY: NEW_TASK', 'RATIONALE: because', '', MANIFEST_END].join('\n'),
      1
    );
    expect(item?.rationale).toBe('because');
  });

  it('accumulates continuation lines onto multi-line fields', () => {
    const item = parseCategorizationItem(
      ['ITEM: 1', 'TITLE: T', 'CATEGORY: NEW_TASK', 'FINAL_DESC: first line', '  second line', '  third line'].join('\n'),
      1
    );
    expect(item?.finalDesc).toBe('first line second line third line');
  });

  it('returns null only when there is neither a category nor a title', () => {
    expect(parseCategorizationItem('total garbage', 1)).toBeNull();
    expect(parseCategorizationItem('TITLE: has a title\nCATEGORY: nonsense', 1)).not.toBeNull();
  });

  it('reads an unrecognized category as UNKNOWN rather than guessing', () => {
    expect(parseCategorizationItem('TITLE: T\nCATEGORY: MAYBE_NEW', 1)?.category).toBe('UNKNOWN');
  });

  // "unknown" as an id must read as ABSENT, so the item is held with a clear missing-id reason
  // rather than carrying a literal string that can never match a board card.
  it.each(['none', 'N/A', 'unknown', 'TBD', '-', '<id>', '?'])(
    'treats %s as an absent id, not a literal one',
    (placeholder) => {
      const item = parseCategorizationItem(
        ['ITEM: 1', 'TITLE: T', 'CATEGORY: DUPLICATE', `EXISTING_TASK_ID: ${placeholder}`].join('\n'),
        1
      );
      expect(item?.existingTaskId).toBeUndefined();
    }
  );

  it('cleans decoration off a real id', () => {
    const item = parseCategorizationItem('TITLE: T\nCATEGORY: DUPLICATE\nEXISTING_TASK_ID: #abc-123 ', 1);
    expect(item?.existingTaskId).toBe('abc-123');
  });

  it('parses UNCERTAIN_FIELDS bullets with and without a suggestion', () => {
    const item = parseCategorizationItem(
      [
        'ITEM: 1', 'TITLE: T', 'CATEGORY: NEW_TASK',
        'UNCERTAIN_FIELDS:',
        '- ASSIGNEE: two people claimed it (suggested: Avery Chen)',
        '- LIST: ambiguous',
      ].join('\n'),
      1
    );
    expect(item?.uncertainFields).toEqual([
      { field: 'assignee', reason: 'two people claimed it', suggested: 'Avery Chen' },
      { field: 'list', reason: 'ambiguous' },
    ]);
  });

  it('treats UNCERTAIN_FIELDS: none as fully confident', () => {
    const item = parseCategorizationItem('TITLE: T\nCATEGORY: NEW_TASK\nUNCERTAIN_FIELDS: none', 1);
    expect(item?.uncertainFields).toBeUndefined();
  });
});

describe('tier2Cited', () => {
  it('is true when the rationale cites a real read', () => {
    expect(
      parseCategorizationItem('TITLE: T\nCATEGORY: DUPLICATE\nRATIONALE: task-comments on abc shows the same work', 1)
        ?.tier2Cited
    ).toBe(true);
  });

  // The one that matters. An agent saying "I could not read the comments" mentions the tool, and a
  // naive regex would score that as evidence — letting an unverified DUPLICATE through the gate.
  it.each([
    'task-comments was unavailable',
    'the task-comments tool is not available in this container',
    "couldn't run task-comments",
    'no tier-2 read was possible',
  ])('is false when the rationale admits the read failed: %s', (rationale) => {
    expect(parseCategorizationItem(`TITLE: T\nCATEGORY: DUPLICATE\nRATIONALE: ${rationale}`, 1)?.tier2Cited).toBe(false);
  });

  it('is false when the rationale cites nothing at all', () => {
    expect(parseCategorizationItem('TITLE: T\nCATEGORY: DUPLICATE\nRATIONALE: looks like a dup', 1)?.tier2Cited).toBe(
      false
    );
  });
});

describe('categoryBreakdown', () => {
  it('counts each category', () => {
    expect(categoryBreakdown(GOLDEN)).toEqual({ NEW_TASK: 2, DUPLICATE: 1, SUBTASK: 1, UPDATE: 1, RELATE: 1 });
  });
});
