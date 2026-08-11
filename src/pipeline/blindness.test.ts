import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCorrectionsPath } from '../state/corrections';
import type { CategorizationItem } from './parsing/categorizationManifest';
import { buildContractCheckerPrompt } from './prompts/contractCheck';
import type { EnrichedInventoryItem } from './types';

const DIR = join(tmpdir(), `blindness-test-${process.pid}`);

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  setCorrectionsPath(join(DIR, 'corrections.json'));
});
afterEach(() => {
  setCorrectionsPath(null);
  rmSync(DIR, { recursive: true, force: true });
});

/** What Pass 1 produced — the ONLY item input Pass 2b is allowed to see. */
const INVENTORY: EnrichedInventoryItem = {
  number: 3,
  title: 'Add rate limiting to the public API',
  desc: 'Avery raised that the public endpoints have no throttling and a burst took the service down.',
  timestamp: '00:12:04-00:13:10',
  possibleMatchHint: '(none)',
};

/**
 * What Pass 2a concluded about the SAME item. Every value here is a distinctive sentinel — if any of
 * them can be found in the 2b prompt, the second read is no longer independent.
 */
const MANIFEST_2A: CategorizationItem = {
  item: 3,
  title: 'Add rate limiting to the public API',
  category: 'DUPLICATE',
  list: 'zzz-sentinel-list',
  assignee: 'Zzz Sentinel Person',
  priority: 'urgent',
  dueDate: '2099-12-31',
  status: 'zzz-sentinel-status',
  finalDesc: 'zzz-sentinel-final-desc',
  existingTaskId: 'zzz-sentinel-existing-id',
  parentTaskId: 'zzz-sentinel-parent-id',
  confidence: 'high',
  rationale: 'zzz-sentinel-rationale',
  notifyAssignee: 'Zzz Sentinel Notify',
  tier2Cited: true,
  raw: 'zzz-sentinel-raw',
};

const BOARD = ['t100 | Ship the onboarding revamp | design | Rowan Diaz | in progress | Rework first-run.'].join('\n');

const render = () =>
  buildContractCheckerPrompt(INVENTORY, BOARD, 'The team discussed API stability.', 'Avery: the API fell over again.');

describe('Pass 2b blindness', () => {
  /**
   * THE headline claim of this pipeline: the second read re-derives the categorization without
   * seeing the first read's answer, so agreement between them is evidence rather than an echo.
   *
   * This test is the guard. It fails loudly if anyone ever threads the manifest item through the 2b
   * prompt builder — which is an easy, well-intentioned "optimization" that would silently reduce
   * the whole verification pass to a rubber stamp while every other test stayed green.
   */
  // `category` is deliberately NOT in this list: the five category NAMES must appear in the prompt,
  // since it has to ask for one. What must not leak is which one 2a chose — covered by the
  // manifest-shaped-line assertion below.
  it.each([
    ['list', MANIFEST_2A.list],
    ['assignee', MANIFEST_2A.assignee],
    ['priority', MANIFEST_2A.priority],
    ['dueDate', MANIFEST_2A.dueDate],
    ['status', MANIFEST_2A.status],
    ['finalDesc', MANIFEST_2A.finalDesc],
    ['existingTaskId', MANIFEST_2A.existingTaskId],
    ['parentTaskId', MANIFEST_2A.parentTaskId],
    ['rationale', MANIFEST_2A.rationale],
    ['notifyAssignee', MANIFEST_2A.notifyAssignee],
    ['raw', MANIFEST_2A.raw],
  ])('the 2b prompt contains no 2a-derived %s', (_field, value) => {
    expect(render()).not.toContain(String(value));
  });

  /**
   * The precise guard. Category names appear all over the prompt — it has to ask for one, and the
   * worked examples demonstrate them. What matters is the block describing THIS item: it must carry
   * inventory fields only, and assert no judgement of its own.
   */
  it('hands the item over with inventory fields only, asserting no judgement', () => {
    const itemBlock = render().split('THE SINGLE ITEM TO RE-VERIFY (output one VERDICT block)')[1]!;

    const keys = [...itemBlock.matchAll(/^([A-Z_]+):/gm)].map((m) => m[1]!);
    expect(new Set(keys)).toEqual(new Set(['ITEM', 'TITLE', 'DESC', 'TIMESTAMP', 'POSSIBLE_MATCH_HINT']));

    for (const judgement of ['CATEGORY', 'LIST', 'ASSIGNEE', 'PRIORITY', 'STATUS', 'FINAL_DESC', 'CONFIDENCE', 'RATIONALE']) {
      expect(keys).not.toContain(judgement);
    }
  });

  it('is built from the Pass-1 inventory item', () => {
    const prompt = render();
    expect(prompt).toContain('ITEM: 3');
    expect(prompt).toContain(INVENTORY.title);
    expect(prompt).toContain(INVENTORY.desc);
    expect(prompt).toContain(INVENTORY.timestamp);
  });

  // The signature of the pass. A second read told to "check the work" agrees; one told to refute finds things.
  it('instructs a disconfirming read, not a confirming one', () => {
    const prompt = render();
    expect(prompt).toContain('DISCONFIRMING');
    expect(prompt).toMatch(/ASSUME this item is NOT new/);
    expect(prompt).toContain('You do NOT see its decision');
  });

  it('asks for all four independent judgements', () => {
    const prompt = render();
    for (const field of ['VERDICT_CATEGORY:', 'WORTH_A_CARD:', 'GROUNDED:', 'ROUTING_OK:']) {
      expect(prompt).toContain(field);
    }
  });

  it('carries the board snapshot, because hunting for a match is the whole job', () => {
    expect(render()).toContain('Ship the onboarding revamp');
  });

  // The instructions mention SOURCE_CONFIDENCE by name, so the guard is on the emitted VALUE line.
  const hasProvenanceValue = (p: string) => /SOURCE_CONFIDENCE:\s*[\d.]+/.test(p);

  it('surfaces a low-confidence source but stays quiet about a good one', () => {
    const low = buildContractCheckerPrompt(INVENTORY, BOARD, '', '', { provenance: 0.4 });
    expect(low).toContain('SOURCE_CONFIDENCE: 0.40');
    expect(low).toContain('LOW');

    expect(hasProvenanceValue(buildContractCheckerPrompt(INVENTORY, BOARD, '', '', { provenance: 0.95 }))).toBe(false);
  });

  it('treats unknown provenance as nothing to report', () => {
    expect(hasProvenanceValue(buildContractCheckerPrompt(INVENTORY, BOARD, '', '', { provenance: null }))).toBe(false);
    expect(hasProvenanceValue(render())).toBe(false);
  });

  it('includes supplied evidence, screened, rather than asking the model to fetch it', () => {
    const prompt = buildContractCheckerPrompt(INVENTORY, BOARD, '', '', {
      tier2Evidence: '• Card t100 — history:\nstill blocked on review',
    });
    expect(prompt).toContain('still blocked on review');
    expect(prompt).toContain('[SECURITY:'); // the evidence is framed as data, not instructions
  });
});

/**
 * The examples are sentinel-delimited so a careless find-and-replace that deletes the whole block is
 * caught. Without this the prompt still works — it just works worse, invisibly: every parser still
 * parses, every gate still fires, the demo still goes green.
 */
describe('prompt scaffolding lint', () => {
  it('emits exactly one WORKED EXAMPLES block with content in it', () => {
    const prompt = render();
    const marker = prompt.match(/WORKED EXAMPLES/g) ?? [];
    expect(marker).toHaveLength(1);

    const body = prompt.split('WORKED EXAMPLES')[1]!.split('OUTPUT — emit EXACTLY')[0]!;
    expect(body.trim().length).toBeGreaterThan(500);
    expect(body).toContain('VERDICT_CATEGORY:');
  });

  // `FULL BOARD SNAPSHOT` is also named in the protocol text, so compare against its LAST occurrence
  // — the section header that actually precedes the data.
  it('keeps the output contract as the last instruction before the data', () => {
    const prompt = render();
    expect(prompt.indexOf('OUTPUT — emit EXACTLY')).toBeLessThan(prompt.lastIndexOf('FULL BOARD SNAPSHOT'));
  });
});
