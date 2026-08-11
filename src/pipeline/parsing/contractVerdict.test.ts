import { describe, it, expect } from 'vitest';
import { autoSkippable, legitimacyHolds, parseContractVerdict } from './contractVerdict';

const verdict = (lines: string[]) => parseContractVerdict(lines.join('\n'));

describe('parseContractVerdict', () => {
  it('reads a complete verdict', () => {
    const v = verdict([
      'VERDICT_CATEGORY: DUPLICATE',
      'MATCH_TASK_ID: t100',
      'WORTH_A_CARD: real_task',
      'GROUNDED: yes',
      'CARD_STILL_MATCHES: yes',
      'ROUTING_OK: yes',
      'RATIONALE: task-comments on t100 shows the same deliverable.',
    ]);
    expect(v).toMatchObject({
      category: 'DUPLICATE',
      matchIds: ['t100'],
      legitimacy: 'real_task',
      grounded: true,
      tier2Cited: true,
    });
  });

  it('reads several match ids', () => {
    expect(verdict(['VERDICT_CATEGORY: RELATE', 'MATCH_TASK_ID: t100, t200']).matchIds).toEqual(['t100', 't200']);
  });

  it('drops placeholder ids rather than carrying them forward', () => {
    expect(verdict(['MATCH_TASK_ID: none']).matchIds).toEqual([]);
    expect(verdict(['MATCH_TASK_ID: unknown']).matchIds).toEqual([]);
  });

  it('treats an unrecognized category as UNKNOWN', () => {
    expect(verdict(['VERDICT_CATEGORY: PROBABLY_NEW']).category).toBe('UNKNOWN');
  });

  it('captures a multi-line rationale but stops at the next field', () => {
    const v = verdict(['RATIONALE: first line', '  second line', 'WORTH_A_CARD: unsure']);
    expect(v.rationale).toContain('first line');
    expect(v.rationale).not.toContain('WORTH_A_CARD');
  });

  // A flaky verdict must never be able to suppress genuine work or invent a dispute.
  describe('fails open on anything missing or garbled', () => {
    it('defaults an empty reply to entirely permissive', () => {
      expect(parseContractVerdict('')).toMatchObject({
        legitimacy: 'real_task', grounded: true, cardStillMatches: true, routingOk: true, category: 'UNKNOWN',
      });
    });

    it('defaults garbage in the judgement fields to permissive', () => {
      const v = verdict(['GROUNDED: probably?', 'ROUTING_OK: dunno', 'CARD_STILL_MATCHES: ¯\\_(ツ)_/¯', 'WORTH_A_CARD: ???']);
      expect(v).toMatchObject({ grounded: true, routingOk: true, cardStillMatches: true, legitimacy: 'real_task' });
    });

    it('honours an explicit no', () => {
      const v = verdict(['GROUNDED: no', 'ROUTING_OK: no', 'CARD_STILL_MATCHES: no']);
      expect(v).toMatchObject({ grounded: false, routingOk: false, cardStillMatches: false });
    });

    it('treats n/a as permissive, not as a no', () => {
      expect(verdict(['CARD_STILL_MATCHES: n/a', 'ROUTING_OK: n/a'])).toMatchObject({ cardStillMatches: true, routingOk: true });
    });
  });

  it('accepts the not_a_task spelling variants a model actually emits', () => {
    for (const spelling of ['not_a_task', 'not_task', 'notatask', 'NOT_A_TASK']) {
      expect(verdict([`WORTH_A_CARD: ${spelling}`]).legitimacy).toBe('not_a_task');
    }
  });

  it('only counts evidence when the rationale actually cites a read', () => {
    expect(verdict(['RATIONALE: looks similar to me']).tier2Cited).toBe(false);
    expect(verdict(['RATIONALE: the comment history on t100 confirms it']).tier2Cited).toBe(true);
  });
});

describe('legitimacyHolds', () => {
  // The recall guarantee: a status change on an existing card can never be suppressed here.
  it.each(['UPDATE', 'DUPLICATE', 'SUBTASK', 'RELATE'])('never holds a %s, whatever the verdict says', (category) => {
    expect(legitimacyHolds(category, 'not_a_task', { pass2aConfidence: 'low', provenance: 0.1 })).toBe(false);
  });

  it('holds a NEW_TASK the blind read judged not a task', () => {
    expect(legitimacyHolds('NEW_TASK', 'not_a_task')).toBe(true);
  });

  it('lets a confident real task through', () => {
    expect(legitimacyHolds('NEW_TASK', 'real_task', { pass2aConfidence: 'high', provenance: 0.95 })).toBe(false);
  });

  it('does not hold on unsure alone — unsure needs corroboration', () => {
    expect(legitimacyHolds('NEW_TASK', 'unsure', { pass2aConfidence: 'high', provenance: 0.95 })).toBe(false);
  });

  it('holds unsure when categorization was also unconfident', () => {
    expect(legitimacyHolds('NEW_TASK', 'unsure', { pass2aConfidence: 'low' })).toBe(true);
  });

  it('holds unsure when the source is weak', () => {
    expect(legitimacyHolds('NEW_TASK', 'unsure', { provenance: 0.5 }, { low: 0.75, floor: 0.5 })).toBe(true);
  });

  it('holds anything from a source below the floor, even a confident real task', () => {
    expect(legitimacyHolds('NEW_TASK', 'real_task', { provenance: 0.3 }, { low: 0.75, floor: 0.5 })).toBe(true);
  });

  // Unknown provenance is the norm for text sources that were never transcribed.
  it('treats unknown provenance as trustworthy', () => {
    expect(legitimacyHolds('NEW_TASK', 'real_task', { provenance: null })).toBe(false);
    expect(legitimacyHolds('NEW_TASK', 'real_task', {})).toBe(false);
  });
});

describe('autoSkippable', () => {
  const v = (legitimacy: 'real_task' | 'not_a_task' | 'unsure') =>
    parseContractVerdict(`WORTH_A_CARD: ${legitimacy}`);

  it('skips a confident not-a-task from a trustworthy source', () => {
    expect(autoSkippable(v('not_a_task'), { provenance: 0.9 }, 0.5)).toBe(true);
  });

  // Narrower than the hold gate on purpose: only confidence earns a skip.
  it('never skips an unsure verdict — that reaches a human', () => {
    expect(autoSkippable(v('unsure'), { provenance: 0.9 })).toBe(false);
  });

  it('never skips a real task', () => {
    expect(autoSkippable(v('real_task'), { provenance: 0.9 })).toBe(false);
  });

  it('does not skip when the source is too poor to trust the judgement', () => {
    expect(autoSkippable(v('not_a_task'), { provenance: 0.2 }, 0.5)).toBe(false);
  });

  it('skips when provenance is unknown', () => {
    expect(autoSkippable(v('not_a_task'), {})).toBe(true);
  });
});
