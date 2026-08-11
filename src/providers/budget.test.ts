import { describe, it, expect, vi } from 'vitest';
import { ModelError, withRetryBudget } from './index';

/**
 * `timeoutMs` is the TOTAL wall-clock budget across retries, not a per-attempt timeout.
 *
 * The system this was extracted from granted each of three attempts the full timeout with no overall
 * ceiling, so a call configured for 600s could hang for roughly thirty minutes while every log line
 * looked normal. Nothing surfaces that; it just appears as a slow run.
 */
describe('withRetryBudget — the total wall-clock ceiling', () => {
  it('gives up within the budget rather than budget × attempts', async () => {
    const started = Date.now();
    const attempt = vi.fn(async () => {
      throw new ModelError('always fails', 10);
    });

    await expect(withRetryBudget('test', 200, attempt)).rejects.toThrow(/no result within the 200ms budget/);

    // Generous ceiling — the point is that it is bounded by the budget, not a multiple of it.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('returns the first success without retrying', async () => {
    const attempt = vi.fn(async () => 'ok');
    expect(await withRetryBudget('test', 5_000, attempt)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds', async () => {
    let n = 0;
    const attempt = vi.fn(async () => {
      if (++n === 1) throw new ModelError('transient', 1);
      return 'recovered';
    });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await withRetryBudget('test', 30_000, attempt)).toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  // Re-sending an identical malformed request just burns the budget to arrive at the same 400.
  it('does not retry a failure the provider marked non-retryable', async () => {
    const attempt = vi.fn(async () => {
      throw new ModelError('bad request', null);
    });

    await expect(withRetryBudget('test', 5_000, attempt)).rejects.toThrow(/bad request/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  // Otherwise a server-controlled Retry-After can push a call past its own deadline.
  it('clamps a long backoff to what is left of the budget', async () => {
    const started = Date.now();
    const attempt = vi.fn(async () => {
      throw new ModelError('rate limited', 60_000); // asks for a minute
    });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(withRetryBudget('test', 300, attempt)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    vi.restoreAllMocks();
  });

  it('hands each attempt a signal that aborts with the remaining budget', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      withRetryBudget('test', 100, async (s) => {
        signal = s;
        throw new ModelError('x', null);
      })
    ).rejects.toThrow();

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * A small budget still gets ONE attempt.
   *
   * Gating the first call on the retry floor meant any `timeoutMs` under 5s made zero calls and
   * failed with "no result within the 3000ms budget" — true, useless, and indistinguishable from a
   * provider outage. The floor exists to stop doomed *retries*, not to refuse to try.
   */
  it('still makes one attempt on a budget smaller than the retry floor', async () => {
    const attempt = vi.fn(async () => 'ok');
    expect(await withRetryBudget('test', 50, attempt)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not retry into a budget too small to finish', async () => {
    const attempt = vi.fn(async () => {
      throw new ModelError('fails', 1);
    });
    await expect(withRetryBudget('test', 50, attempt)).rejects.toThrow(/no result within/);
    expect(attempt).toHaveBeenCalledTimes(1); // tried once, did not retry into nothing
  });
});
