import { describe, it, expect, vi } from 'vitest';
import { channelSource } from '../../ingest/channel';
import { confidenceForWindow, parseTimestampRange, provenanceByItem, transcriptSource } from '../../ingest/transcript';
import {
  INVENTORY_END,
  INVENTORY_START,
  CONSOLIDATED_END,
  CONSOLIDATED_START,
  combineConsolidatedInventory,
  combineInventories,
  parseEnrichedInventoryItems,
  parseInventory,
} from '../parsing/inventory';
import { type PassDeps, runCleanup, runInventory, runInventoryConsolidator, runInventoryCritic } from './inventory';

const INVENTORY = [
  INVENTORY_START,
  '1. Add rate limiting to the public API | quote: "the API fell over again"',
  '   DESC: Bursts take the service down; add throttling.',
  '   TIMESTAMP: 00:04:00-00:05:00',
  '   POSSIBLE_MATCH_HINT: (none)',
  '2. Refresh the pricing page copy',
  '   DESC: Copy is stale after the tier change.',
  '   TIMESTAMP: 00:09:00-00:10:00',
  '   POSSIBLE_MATCH_HINT: Pricing page | id:t300',
  INVENTORY_END,
].join('\n');

const deps = (reply: string | Error | { truncated: true }, warn = vi.fn()): PassDeps => ({
  run: async () => {
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'object') return { text: 'half an answ', truncated: true };
    return { text: reply };
  },
  warn,
  log: vi.fn(),
});

describe('inventory parsing', () => {
  it('parses items with all their fields', () => {
    const items = parseEnrichedInventoryItems(INVENTORY);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      number: 1,
      title: 'Add rate limiting to the public API',
      desc: 'Bursts take the service down; add throttling.',
      timestamp: '00:04:00-00:05:00',
      possibleMatchHint: '(none)',
      quote: 'the API fell over again',
    });
  });

  it('counts lines and separates policy notes', () => {
    const withPolicy = INVENTORY.replace('2. Refresh', '2. [Policy] Refresh');
    expect(parseInventory(withPolicy)).toMatchObject({ lineCount: 2, actionableCount: 1, policyNotes: 1 });
  });

  it('returns null when there is nothing to parse', () => {
    expect(parseInventory('the model wrote prose instead')).toBeNull();
  });

  // A model that forgets a delimiter should not cost the whole run.
  it('recovers when the START marker is missing but the lines are clearly there', () => {
    const noMarkers = ['1. Do a thing', '2. Do another thing', '3. Do a third thing'].join('\n');
    expect(parseEnrichedInventoryItems(noMarkers)).toHaveLength(3);
  });

  it('does not hallucinate an inventory from one stray numbered line', () => {
    expect(parseInventory('1. this is just prose that happens to be numbered')).toBeNull();
  });

  it('accepts the channel markers as the same format', () => {
    const channel = INVENTORY.replace(INVENTORY_START, '--- CHANNEL ACTION INVENTORY ---').replace(
      INVENTORY_END,
      '--- END CHANNEL ACTION INVENTORY ---'
    );
    expect(parseEnrichedInventoryItems(channel)).toHaveLength(2);
  });

  // Nothing can resolve "this" to a card, so the gate must be able to see that it is deictic.
  it('flags a deictic reference so the update gate can hold it', () => {
    const vague = [INVENTORY_START, '1. That one is done now', '   DESC: Marked complete in the call.', INVENTORY_END].join('\n');
    expect(parseEnrichedInventoryItems(vague)[0]!.isVague).toBe(true);
    expect(parseEnrichedInventoryItems(INVENTORY)[0]!.isVague).toBeUndefined();
  });
});

describe('combineInventories — Pass 1.5', () => {
  it('keeps the original when the critic found nothing', () => {
    expect(combineInventories(INVENTORY, 'NONE')).toBe(INVENTORY);
  });

  it('appends recovered items, renumbered to continue the list', () => {
    const out = combineInventories(INVENTORY, '1. Chase the vendor invoice\n   DESC: Finance asked twice.');
    const items = parseEnrichedInventoryItems(out);
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ number: 3, title: 'Chase the vendor invoice' });
  });

  // The exact shape that once hid a numbering bug for weeks while the log said "recovered 0 items".
  it('is LOUD when the critic returns substance that yields no parseable lines', () => {
    const warn = vi.fn();
    const out = combineInventories(INVENTORY, 'I reviewed it carefully and believe two items were missed here.', warn);
    expect(out).toBe(INVENTORY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ZERO parseable inventory lines'));
  });

  it('stays quiet about a short unparseable reply', () => {
    const warn = vi.fn();
    combineInventories(INVENTORY, 'ok', warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('combineConsolidatedInventory — Pass 1.7', () => {
  const merged = [
    CONSOLIDATED_START,
    'MERGED_PAIRS: 1',
    '1. Add rate limiting and fix the pricing copy | merged_from: 1, 2',
    '   DESC: Combined.',
    CONSOLIDATED_END,
  ].join('\n');

  it('applies an anchored merge', () => {
    const items = parseEnrichedInventoryItems(combineConsolidatedInventory(INVENTORY, merged));
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Add rate limiting and fix the pricing copy');
  });

  it('does nothing when no merges were claimed', () => {
    expect(combineConsolidatedInventory(INVENTORY, `${CONSOLIDATED_START}\nMERGED_PAIRS: 0\n${CONSOLIDATED_END}`)).toBe(INVENTORY);
  });

  /**
   * The guarantee that makes this pass safe. Without `merged_from`, applying the reply would mean
   * trusting one model's retyping of another's work — and a silently dropped line would be invisible.
   */
  it('REFUSES an unanchored rebuild and says so', () => {
    const warn = vi.fn();
    const unanchored = [CONSOLIDATED_START, 'MERGED_PAIRS: 2', '1. Some merged thing', '2. Another', CONSOLIDATED_END].join('\n');
    expect(combineConsolidatedInventory(INVENTORY, unanchored, warn)).toBe(INVENTORY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('none named the lines they replace'));
  });

  it('ignores a "merge" that names only one line', () => {
    const warn = vi.fn();
    const single = [CONSOLIDATED_START, 'MERGED_PAIRS: 1', '1. Just item one | merged_from: 1', CONSOLIDATED_END].join('\n');
    expect(combineConsolidatedInventory(INVENTORY, single, warn)).toBe(INVENTORY);
  });

  it('keeps the original on a malformed reply', () => {
    expect(combineConsolidatedInventory(INVENTORY, 'no markers here')).toBe(INVENTORY);
  });
});

describe('fail-open contract', () => {
  it('Pass 0 returns the RAW source when cleanup fails', async () => {
    const raw = 'Avery: the API fell over again.';
    expect(await runCleanup({ rawSource: raw }, deps(new Error('boom')))).toBe(raw);
    expect(await runCleanup({ rawSource: raw }, deps(''))).toBe(raw);
  });

  it('Pass 0 keeps the RAW source when the reply was truncated', async () => {
    expect(await runCleanup({ rawSource: 'raw text' }, deps({ truncated: true }))).toBe('raw text');
  });

  it('Pass 1 has no fallback and reports a null parse', async () => {
    const out = await runInventory({ sourceText: 'x' }, deps(new Error('boom')));
    expect(out.parsed).toBeNull();
  });

  // A truncated Pass 1 silently drops the tail of a long source; it must be visible, not absorbed.
  it('Pass 1 surfaces truncation rather than shipping a partial inventory', async () => {
    const onTruncated = vi.fn();
    const out = await runInventory({ sourceText: 'x' }, { ...deps({ truncated: true }), onTruncated });
    expect(out.outputTruncated).toBe(true);
    expect(out.parsed).toBeNull();
    expect(onTruncated).toHaveBeenCalledWith('1');
  });

  it('Pass 1 parses a good reply', async () => {
    const out = await runInventory({ sourceText: 'x' }, deps(INVENTORY));
    expect(out.parsed?.lineCount).toBe(2);
  });

  it('Pass 1.5 keeps the Pass 1 inventory when the critic fails', async () => {
    expect(await runInventoryCritic({ sourceText: 'x', inventoryRaw: INVENTORY }, deps(new Error('boom')))).toBe(INVENTORY);
  });

  it('Pass 1.7 keeps the inventory when the consolidator fails', async () => {
    expect(await runInventoryConsolidator({ inventoryRaw: INVENTORY }, deps(new Error('boom')))).toBe(INVENTORY);
  });
});

describe('ingest sources', () => {
  const RAW = {
    meetingId: 'm-1',
    deliveryId: 'd-1',
    summary: 'API stability.',
    recordedAtIso: '2026-08-11T10:00:00Z',
    participants: ['Avery Chen', 'Rowan Diaz'],
    lines: [
      { speaker: 'Avery Chen', start: 240, end: 300, text: 'The API fell over again.', confidence: 0.95 },
      { speaker: 'Rowan Diaz', start: 540, end: 600, text: 'Pricing copy is stale.', confidence: 0.4 },
    ],
  };

  it('renders a transcript with timestamps and speakers', () => {
    const out = transcriptSource.normalize(RAW);
    expect(out.text).toContain('[00:04:00-00:05:00] Avery Chen: The API fell over again.');
    expect(out).toMatchObject({ kind: 'transcript', sourceId: 'm-1', eventId: 'd-1', todayIso: '2026-08-11' });
  });

  it('parses a timestamp range', () => {
    expect(parseTimestampRange('00:04:00-00:05:00')).toEqual({ start: 240, end: 300 });
    expect(parseTimestampRange('not a range')).toBeNull();
  });

  it('weights confidence by how much of the window each line covers', () => {
    expect(confidenceForWindow(RAW.lines, { start: 240, end: 300 })).toBeCloseTo(0.95);
    expect(confidenceForWindow(RAW.lines, { start: 540, end: 600 })).toBeCloseTo(0.4);
  });

  // null means "unknown", which downstream treats as trustworthy — never as zero.
  it('returns null confidence when nothing overlaps', () => {
    expect(confidenceForWindow(RAW.lines, { start: 5000, end: 5100 })).toBeNull();
  });

  it('maps confidence onto inventory items by their window', () => {
    const map = provenanceByItem(RAW.lines, parseEnrichedInventoryItems(INVENTORY));
    expect(map.get(1)).toBeCloseTo(0.95);
    expect(map.get(2)).toBeCloseTo(0.4);
  });

  it('renders a channel log through the same shape', () => {
    const out = channelSource.normalize({
      channelId: 'C123',
      channelName: 'eng',
      dateIso: '2026-08-11',
      messages: [{ author: 'Avery Chen', at: '2026-08-11T10:04:00Z', text: 'the API fell over again' }],
    });
    expect(out.kind).toBe('channel');
    expect(out.text).toContain('[10:04] Avery Chen: the API fell over again');
    expect(out.provenanceByItem).toBeUndefined(); // no speech confidence to report
  });

  // The channel id alone would suppress every subsequent day as a duplicate.
  it('scopes a channel source id to the day', () => {
    const day = (dateIso: string) => channelSource.normalize({ channelId: 'C123', dateIso, messages: [] }).sourceId;
    expect(day('2026-08-11')).not.toBe(day('2026-08-12'));
  });
});
