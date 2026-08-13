/**
 * The system/user split for passes 2a and 2b.
 *
 * This boundary is a correctness constraint, not formatting. `system` is the prompt-cache prefix, so
 * anything item-specific that leaks into it changes the prefix on every call and silently poisons
 * the cache for the whole run. The symptom is a bill, not a failing test — which is exactly why the
 * test has to exist.
 *
 * The inverse matters too: if the stable half drifts back into `user`, the breakpoint has nothing to
 * sit on and the cache goes back to never firing, which is the state this split was written to fix.
 */
import { describe, expect, it } from 'vitest';
import { buildCategorizationPrompt } from './categorization';
import { buildContractCheckerPrompt } from './contractCheck';
import { joinPrompt } from './parts';
import type { EnrichedInventoryItem } from '../types';

const BOARD = 't100 | Public API rate limiting | backend | Avery Chen | in progress | Throttle the public endpoints.';

const item = (over: Partial<EnrichedInventoryItem> = {}): EnrichedInventoryItem => ({
  number: 1,
  title: 'Add a request-size cap',
  desc: 'No cap on the upload endpoint.',
  timestamp: '00:01:10-00:01:36',
  possibleMatchHint: '(none)',
  ...over,
});

const BUILDERS = [
  ['2a categorization', buildCategorizationPrompt],
  ['2b contract check', buildContractCheckerPrompt],
] as const;

describe.each(BUILDERS)('%s', (_name, build) => {
  const parts = (it_: EnrichedInventoryItem = item()) =>
    build(it_, BOARD, 'A standup.', 'Avery: the uploads fell over.');

  it('puts the board snapshot in system, where the cache breakpoint can reach it', () => {
    const p = parts();
    expect(p.system).toContain(BOARD);
    expect(p.user).not.toContain(BOARD);
  });

  it('puts the source text in system — it is identical for every item in the run', () => {
    const p = parts();
    expect(p.system).toContain('Avery: the uploads fell over.');
    expect(p.user).not.toContain('Avery: the uploads fell over.');
  });

  it('keeps the item itself out of system, so one prefix serves every item', () => {
    const p = parts();
    expect(p.user).toContain('Add a request-size cap');
    expect(p.system).not.toContain('Add a request-size cap');
  });

  /**
   * The load-bearing one. Two different items must produce a BYTE-IDENTICAL system prefix — that is
   * the entire mechanism. If this fails, every call is a cache miss and the only visible signal is
   * the invoice.
   */
  it('produces an identical system prefix across different items', () => {
    const a = parts(item({ number: 1, title: 'Add a request-size cap' }));
    const b = parts(item({ number: 2, title: 'Refresh the pricing page', desc: 'Copy is stale.' }));

    expect(a.system).toBe(b.system);
    expect(a.user).not.toBe(b.user);
  });

  it('varies the user half with per-item evidence, and leaves system alone', () => {
    const withEvidence = build(item(), BOARD, 'A standup.', 'Avery: the uploads fell over.', {
      tier2Evidence: 't100: [2026-08-01] Avery — still blocked on review',
    });
    const without = parts();

    expect(withEvidence.system).toBe(without.system);
    expect(withEvidence.user).not.toBe(without.user);
    expect(withEvidence.user).toContain('t100');
  });

  it('loses nothing in the split — the joined prompt still carries both halves', () => {
    const p = parts();
    const joined = joinPrompt(p);
    expect(joined).toContain(BOARD);
    expect(joined).toContain('Add a request-size cap');
    expect(joined.length).toBe(p.system.length + p.user.length + 1);
  });

  /** The prefix has to be worth caching. A few hundred characters would not be. */
  it('leaves the bulk of the prompt in the cacheable half', () => {
    const p = parts();
    expect(p.system.length).toBeGreaterThan(p.user.length * 5);
  });
});
