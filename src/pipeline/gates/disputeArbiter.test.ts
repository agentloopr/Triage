/**
 * The arbiter's whole job is to resolve a write-level dispute ONLY when it is genuinely safe to —
 * fail-closed throughout, the opposite default from `parseContractVerdict`. Every test here either
 * proves a resolution or proves a hold; there is no third outcome.
 */
import { describe, expect, it } from 'vitest';
import type { CategorizationItem } from '../parsing/categorizationManifest';
import type { ContractVerdict } from '../parsing/contractVerdict';
import type { EnrichedInventoryItem } from '../types';
import { memoryTracker } from '../../trackers/memory';
import type { BoardTask } from '../../trackers';
import { effectiveWrite, writeDispute } from './contractGates';
import {
  acceptArbiterResolution,
  applyBlindRead,
  parseArbiterVerdict,
  resolveDispute,
} from './disputeArbiter';

const inv = (over: Partial<EnrichedInventoryItem> = {}): EnrichedInventoryItem => ({
  number: 1, title: 'Check whether the auth test flake is causing nightly alerts', desc: 'Investigate the flaky test.', timestamp: '', possibleMatchHint: '(none)', ...over,
});

const item = (over: Partial<CategorizationItem> = {}): CategorizationItem => ({
  item: 1, title: 'Check whether the auth test flake is causing nightly alerts', category: 'SUBTASK', parentTaskId: 't100', tier2Cited: true, raw: '', ...over,
});

const verdict = (over: Partial<ContractVerdict> = {}): ContractVerdict => ({
  usable: true, category: 'UPDATE', matchIds: ['t100'], rationale: 'the blind read', tier2Cited: true,
  legitimacy: 'real_task', grounded: true, cardStillMatches: true, routingOk: true, raw: '', ...over,
});

const dispute = () => writeDispute('SUBTASK', 't100', 'UPDATE', 't100')!;

const BOARD: BoardTask[] = [{ id: 't100', title: 'Nightly build alerting is noisy', listKey: 'backend', assignees: ['Avery Chen'], status: 'in progress' }];

describe('parseArbiterVerdict', () => {
  it('reads a complete verdict', () => {
    const v = parseArbiterVerdict(['RESOLUTION: 2B', 'CONFIDENCE: high', 'EVIDENCE_SOURCE: card-status', 'EVIDENCE: card is closed', 'RATIONALE: settled by status'].join('\n'));
    expect(v).toMatchObject({ resolution: '2B', confidence: 'high', evidenceSource: 'card-status', evidence: 'card is closed' });
  });

  it('defaults to HOLD, unknown confidence, no evidence — fail-closed, the opposite of parseContractVerdict', () => {
    expect(parseArbiterVerdict('')).toMatchObject({ resolution: 'HOLD', confidence: 'unknown', evidenceSource: 'none', evidence: '' });
  });

  it.each([
    ['plain prose', 'Sure, 2B looks right to me.'],
    ['a resolution outside the taxonomy', 'RESOLUTION: MAYBE'],
  ])('never lets %s parse to anything but HOLD', (_what, raw) => {
    expect(parseArbiterVerdict(raw).resolution).toBe('HOLD');
  });

  it('parses a real resolution alongside garbage confidence, but leaves confidence unknown — acceptArbiterResolution is what then rejects it', () => {
    const v = parseArbiterVerdict('RESOLUTION: 2B\nCONFIDENCE: pretty sure');
    expect(v.resolution).toBe('2B');
    expect(v.confidence).toBe('unknown');
  });
});

describe('acceptArbiterResolution', () => {
  const d = dispute();

  it('accepts a high-confidence resolution with a cited fact', () => {
    const v = parseArbiterVerdict('RESOLUTION: 2A\nCONFIDENCE: high\nEVIDENCE_SOURCE: card-status\nEVIDENCE: card is in progress, matches 2a');
    expect(acceptArbiterResolution(v, d)).toBe('2a');
  });

  it('rejects HOLD outright', () => {
    const v = parseArbiterVerdict('RESOLUTION: HOLD\nCONFIDENCE: high\nEVIDENCE_SOURCE: card-status\nEVIDENCE: x');
    expect(acceptArbiterResolution(v, d)).toBeNull();
  });

  it.each(['medium', 'low'] as const)('rejects anything less than high confidence (%s)', (confidence) => {
    const v = parseArbiterVerdict(`RESOLUTION: 2B\nCONFIDENCE: ${confidence}\nEVIDENCE_SOURCE: comment\nEVIDENCE: x`);
    expect(acceptArbiterResolution(v, d)).toBeNull();
  });

  it('rejects EVIDENCE_SOURCE: none, even at high confidence', () => {
    const v = parseArbiterVerdict('RESOLUTION: 2B\nCONFIDENCE: high\nEVIDENCE_SOURCE: none\nEVIDENCE: x');
    expect(acceptArbiterResolution(v, d)).toBeNull();
  });

  it('rejects an empty EVIDENCE string even with a named source', () => {
    const v = parseArbiterVerdict('RESOLUTION: 2B\nCONFIDENCE: high\nEVIDENCE_SOURCE: comment\nEVIDENCE:');
    expect(acceptArbiterResolution(v, d)).toBeNull();
  });

  it('holds a resolution toward a write-NOTHING outcome unless the evidence is comment/card-body', () => {
    // DUPLICATE(A) vs UPDATE(A) — resolving toward 2a (DUPLICATE, writes nothing) needs the strongest
    // evidence class; a card-status fact is not enough, since it does not show the work is covered.
    const d2 = writeDispute('DUPLICATE', 't100', 'UPDATE', 't100')!;
    const cardStatus = parseArbiterVerdict('RESOLUTION: 2A\nCONFIDENCE: high\nEVIDENCE_SOURCE: card-status\nEVIDENCE: card is open');
    expect(acceptArbiterResolution(cardStatus, d2)).toBeNull();

    const comment = parseArbiterVerdict('RESOLUTION: 2A\nCONFIDENCE: high\nEVIDENCE_SOURCE: comment\nEVIDENCE: a comment already covers this exact work');
    expect(acceptArbiterResolution(comment, d2)).toBe('2a');
  });

  it('does not apply the write-NOTHING bar to the side that is NOT resolving to NOTHING', () => {
    // Resolving toward 2b (UPDATE, writes a comment) in the same dispute needs no special evidence class.
    const d2 = writeDispute('DUPLICATE', 't100', 'UPDATE', 't100')!;
    const v = parseArbiterVerdict('RESOLUTION: 2B\nCONFIDENCE: high\nEVIDENCE_SOURCE: card-status\nEVIDENCE: card is open and in progress');
    expect(acceptArbiterResolution(v, d2)).toBe('2b');
  });
});

describe('applyBlindRead', () => {
  it('rewrites toward UPDATE, defaulting status when 2a left none', () => {
    const out = applyBlindRead(item({ category: 'SUBTASK', parentTaskId: 't100', status: undefined }), verdict({ category: 'UPDATE', matchIds: ['t100'] }));
    expect(out).toMatchObject({ category: 'UPDATE', existingTaskId: 't100', parentTaskId: undefined, status: 'in progress' });
  });

  it('preserves an existing status rather than overwriting it', () => {
    const out = applyBlindRead(item({ status: 'blocked' }), verdict({ category: 'UPDATE', matchIds: ['t100'] }));
    expect(out.status).toBe('blocked');
  });

  it('rewrites toward SUBTASK', () => {
    const out = applyBlindRead(item({ category: 'UPDATE', existingTaskId: 't100' }), verdict({ category: 'SUBTASK', matchIds: ['t200'] }));
    expect(out).toMatchObject({ category: 'SUBTASK', parentTaskId: 't200', existingTaskId: undefined });
  });

  it('rewrites toward DUPLICATE', () => {
    const out = applyBlindRead(item(), verdict({ category: 'DUPLICATE', matchIds: ['t300'] }));
    expect(out).toMatchObject({ category: 'DUPLICATE', existingTaskId: 't300', parentTaskId: undefined });
  });

  it('rewrites toward NEW_TASK, clearing any target', () => {
    const out = applyBlindRead(item(), verdict({ category: 'NEW_TASK', matchIds: [] }));
    expect(out).toMatchObject({ category: 'NEW_TASK', existingTaskId: undefined, parentTaskId: undefined });
  });
});

describe('resolveDispute — orchestration', () => {
  it('resolves for free, no model call, when exactly one cited card is missing', async () => {
    const tracker = memoryTracker({ tasks: BOARD }); // only t100 exists
    let modelCalled = false;
    const d = writeDispute('UPDATE', 't100', 'UPDATE', 't999')!; // t999 does not exist
    const out = await resolveDispute(inv(), item({ category: 'UPDATE', existingTaskId: 't100' }), verdict({ category: 'UPDATE', matchIds: ['t999'] }), d, {
      runAgent: async () => { modelCalled = true; return 'RESOLUTION: HOLD'; },
      tracker,
    }, 'test');

    expect(out).toEqual({ kind: 'resolved', winner: '2a', evidence: 'card t999 no longer exists on the board' });
    expect(modelCalled).toBe(false);
  });

  it('holds when both cited cards are missing — neither read checks out', async () => {
    const tracker = memoryTracker({ tasks: [] });
    const d = writeDispute('UPDATE', 't100', 'UPDATE', 't200')!;
    const out = await resolveDispute(inv(), item(), verdict({ matchIds: ['t200'] }), d, { runAgent: async () => 'RESOLUTION: 2A\nCONFIDENCE: high', tracker }, 'test');
    expect(out).toEqual({ kind: 'hold', reason: 'both cited cards are missing — neither read checks out' });
  });

  it('falls through to the model when both cards exist', async () => {
    const tracker = memoryTracker({ tasks: [...BOARD, { id: 't200', title: 'Other card', listKey: 'backend', assignees: [], status: 'to do' }] });
    const d = writeDispute('UPDATE', 't100', 'UPDATE', 't200')!;
    const out = await resolveDispute(inv(), item({ category: 'UPDATE', existingTaskId: 't100' }), verdict({ category: 'UPDATE', matchIds: ['t200'] }), d, {
      runAgent: async () => 'RESOLUTION: 2B\nCONFIDENCE: high\nEVIDENCE_SOURCE: card-status\nEVIDENCE: t200 is the real match',
      tracker,
    }, 'test');
    expect(out).toEqual({ kind: 'resolved', winner: '2b', evidence: 't200 is the real match' });
  });

  it('holds when the model call throws', async () => {
    const tracker = memoryTracker({ tasks: [...BOARD, { id: 't200', title: 'Other card', listKey: 'backend', assignees: [], status: 'to do' }] });
    const d = writeDispute('UPDATE', 't100', 'UPDATE', 't200')!;
    const out = await resolveDispute(inv(), item(), verdict({ matchIds: ['t200'] }), d, { runAgent: async () => { throw new Error('provider down'); }, tracker }, 'test');
    expect(out.kind).toBe('hold');
    if (out.kind === 'hold') expect(out.reason).toMatch(/arbiter call failed.*provider down/);
  });

  it('holds when the model resolves at less than high confidence', async () => {
    const tracker = memoryTracker({ tasks: [...BOARD, { id: 't200', title: 'Other card', listKey: 'backend', assignees: [], status: 'to do' }] });
    const d = writeDispute('UPDATE', 't100', 'UPDATE', 't200')!;
    const out = await resolveDispute(inv(), item(), verdict({ matchIds: ['t200'] }), d, {
      runAgent: async () => 'RESOLUTION: 2B\nCONFIDENCE: medium\nEVIDENCE_SOURCE: comment\nEVIDENCE: probably this one',
      tracker,
    }, 'test');
    expect(out.kind).toBe('hold');
  });

  it('never fetches comments for a card already known to be gone — step 1 alone decided it', async () => {
    let getCommentsCalled = false;
    const tracker = memoryTracker({ tasks: BOARD });
    const wrapped = { getTask: tracker.getTask.bind(tracker), getComments: async (id: string, limit?: number) => { getCommentsCalled = true; return tracker.getComments(id, limit); } };
    const d = writeDispute('UPDATE', 't100', 'UPDATE', 't999')!;
    await resolveDispute(inv(), item({ category: 'UPDATE', existingTaskId: 't100' }), verdict({ category: 'UPDATE', matchIds: ['t999'] }), d, { runAgent: async () => 'RESOLUTION: HOLD', tracker: wrapped }, 'test');
    expect(getCommentsCalled).toBe(false);
  });

  it('fetches comments only for cards that exist, and passes them to the model', async () => {
    const tracker = memoryTracker({
      tasks: [...BOARD, { id: 't200', title: 'Other card', listKey: 'backend', assignees: [], status: 'to do' }],
      comments: { t100: [{ id: 'c1', author: 'Avery Chen', body: 'already fixed this in the last deploy', createdAt: '2026-08-01' }] },
    });
    const d = writeDispute('UPDATE', 't100', 'UPDATE', 't200')!;
    let seenPrompt = '';
    await resolveDispute(inv(), item({ category: 'UPDATE', existingTaskId: 't100' }), verdict({ category: 'UPDATE', matchIds: ['t200'] }), d, {
      runAgent: async (prompt) => { seenPrompt = prompt; return 'RESOLUTION: HOLD'; },
      tracker,
    }, 'test');
    expect(seenPrompt).toContain('already fixed this in the last deploy');
  });
});

describe('effectiveWrite / writeDispute — the arbiter operates on this comparison, not the label', () => {
  it('DUPLICATE always resolves to a target-less write, whatever id is passed', () => {
    expect(effectiveWrite('DUPLICATE', 't1').target).toBeUndefined();
  });
});
