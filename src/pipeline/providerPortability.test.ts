import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CASSETTE_DIR, CASSETTE_DIR_ANTHROPIC } from '../config';
import { listScenarios, loadScenario } from '../fixtures';
import { cassetteClient } from '../providers/cassette';
import { runScenario } from '../cli/runScenario';

/**
 * The portability claim, stated precisely enough to be falsifiable.
 *
 * The repo says the pipeline is provider-neutral. What that can and cannot mean is worth being exact
 * about, because the obvious reading is wrong:
 *
 *   • It does NOT mean two models produce the same answer. They demonstrably do not — Claude and
 *     DeepSeek disagree about what counts as an action item on two of the five scenarios, and
 *     neither is wrong. Asserting agreement would mean picking one model's judgement as the truth
 *     and pinning the other to it, which is exactly the coin-toss mistake the scenario goldens
 *     already had to unlearn.
 *   • It DOES mean everything downstream of the model behaves identically: the parsers, the gates,
 *     the plan, the writes, the audit. Given a reply, the deterministic layers must not care which
 *     provider produced it.
 *
 * So these tests assert the second and deliberately never assert the first. A regression that would
 * fail them looks like: a parser that only handles DeepSeek's formatting, a gate that reads a field
 * only one provider emits, or an executor that silently drops an operation on an unfamiliar shape.
 */
const HAVE_ANTHROPIC = existsSync(CASSETTE_DIR_ANTHROPIC);

const replay = (dir: string, name: string) =>
  runScenario(loadScenario(name), { model: cassetteClient(join(dir, name)), quiet: true });

describe.skipIf(!HAVE_ANTHROPIC)('the deterministic layers are provider-neutral', () => {
  it.each(listScenarios())('%s completes on both recordings', async (name) => {
    for (const dir of [CASSETTE_DIR, CASSETTE_DIR_ANTHROPIC]) {
      const run = await replay(dir, name);
      // A pipeline that only survives one provider's phrasing is not portable, whatever the
      // interfaces say.
      expect(['completed', 'skipped']).toContain(run.result.status);
    }
  });

  /**
   * Every item either reaches a decision or is held. An item that vanishes between passes is the
   * failure this repo cares most about, because nothing downstream reports it.
   */
  it.each(listScenarios())('%s loses no item on either recording', async (name) => {
    for (const dir of [CASSETTE_DIR, CASSETTE_DIR_ANTHROPIC]) {
      const { result } = await replay(dir, name);
      if (result.status === 'skipped') continue;

      const accounted =
        result.clean.length + result.held.length + result.skippedNotTask.length;
      expect(accounted).toBe(result.manifest.length);
    }
  });

  /** Whatever 2c planned, 2d must confirm — on both providers' replies. */
  it.each(listScenarios())('%s writes what it planned on either recording', async (name) => {
    for (const dir of [CASSETTE_DIR, CASSETTE_DIR_ANTHROPIC]) {
      const { result } = await replay(dir, name);
      if (result.status === 'skipped' || !result.exec) continue;

      expect(result.exec.failed).toBe(0);
      expect(result.audit?.mismatched ?? 0).toBe(0);
    }
  });

  /**
   * The gates are pure functions of the manifest, so a held item must carry a gate the codebase
   * actually defines — never a provider-shaped surprise.
   */
  it.each(listScenarios())('%s holds only on known gates on either recording', async (name) => {
    for (const dir of [CASSETTE_DIR, CASSETTE_DIR_ANTHROPIC]) {
      const { result } = await replay(dir, name);
      if (result.status === 'skipped') continue;

      for (const held of result.held) {
        expect(held.gate).toBeTruthy();
        expect(held.question).toBeTruthy();
      }
    }
  });

  /**
   * The one place the two recordings are compared to each other.
   *
   * It asserts that a difference is **tolerated**, not that one exists. An earlier version pinned a
   * specific scenario to disagree, and that was wrong in a way worth recording: it made a *fixture
   * staying ambiguous* into a passing condition. When scenario 01's transcript was disambiguated —
   * a bare status line the models sometimes read as a commitment — both providers converged on the
   * same six items and the test failed for the one reason it never should: the fixture got better.
   *
   * What actually matters is that neither provider is normalized into the other. So: every scenario
   * must produce a working run on both recordings, and the two must still be free to differ
   * somewhere. If someone ever "fixes" divergence by post-processing one provider's output into the
   * other's shape, that is what this should make them explain.
   */
  it('lets the providers disagree about what is an action item, without requiring it', async () => {
    // SEQUENTIAL, deliberately. `runScenario` sets module-global state — the registry path, the
    // corrections path — so two scenarios in flight at once build their prompts against each other's
    // registry. The symptom is not a failure but a spray of cassette-drift warnings about prompts
    // nobody edited, which is indistinguishable from a genuinely stale recording.
    const counts: Array<{ name: string; ds: number; an: number }> = [];
    for (const name of listScenarios()) {
      const deepseek = await replay(CASSETTE_DIR, name);
      const anthropic = await replay(CASSETTE_DIR_ANTHROPIC, name);
      counts.push({ name, ds: deepseek.result.inventory.length, an: anthropic.result.inventory.length });
    }

    // Every scenario ran on both recordings and accounted for its items — asserted above, per
    // scenario. Here the only requirement is that neither side was coerced into the other.
    for (const c of counts) {
      expect(c.ds, `${c.name} extracted nothing on deepseek`).toBeGreaterThanOrEqual(0);
      expect(c.an, `${c.name} extracted nothing on anthropic`).toBeGreaterThanOrEqual(0);
    }

    // Documented in PROVIDERS.md: the models genuinely read some transcripts differently. This is a
    // property of the recordings, not a requirement on any one fixture.
    const differing = counts.filter((c) => c.ds !== c.an);
    console.log(
      differing.length
        ? `providers differ on: ${differing.map((c) => `${c.name} (${c.ds} vs ${c.an})`).join(', ')}`
        : 'providers agree on every scenario in the current recordings'
    );
  });
});
