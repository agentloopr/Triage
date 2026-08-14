/**
 * The agent path, replayed offline from its own recordings.
 *
 * `agents.test.ts` proves the pieces with scripted replies. This proves the whole thing runs — real
 * prompts, a real multi-turn tool loop, real gates, real writes — with **no network**, which is the
 * property the cassette format had to be changed to make possible at all.
 *
 * It also stops the recordings rotting behind a document that cites them, which is exactly what
 * nearly happened to the Anthropic set: 46 committed cassettes that no job replayed.
 *
 * These assertions are deliberately about **invariants, not dispositions.** The goldens describe one
 * recording of a model reading a meeting; another recording may extract a different number of items,
 * and both agent recordings do. What must hold on every recording is that the agent layer changed
 * nothing it is not allowed to change.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASSETTE_DIR_AGENTS, CASSETTE_DIR_AGENTS_ANTHROPIC } from '../config';
import { listScenarios, loadScenario } from '../fixtures';
import { cassetteClient } from '../providers/cassette';
import { runScenario } from '../cli/runScenario';

const SETS = [
  { name: 'deepseek', dir: CASSETTE_DIR_AGENTS },
  { name: 'anthropic', dir: CASSETTE_DIR_AGENTS_ANTHROPIC },
].filter((s) => existsSync(s.dir));

const replay = (dir: string, name: string) =>
  runScenario(loadScenario(name), { model: cassetteClient(join(dir, name)), quiet: true, agents: true });

describe.skipIf(SETS.length === 0)('the agent path replays offline', () => {
  for (const set of SETS) {
    describe(set.name, () => {
      it.each(listScenarios())('%s completes with no network', async (name) => {
        const run = await replay(set.dir, name);
        expect(['completed', 'skipped']).toContain(run.result.status);
      });

      /**
       * A PARTIAL recording must fail loudly here, and nothing else in this file would catch it.
       *
       * Pass 2b fails open on a missing cassette by design — a blind read that cannot run must not
       * take down a batch. That is right for production and wrong for a replay test: run against a
       * half-written recording, every invariant above still passes, because failing open is allowed.
       * (Observed exactly that, replaying a recording while it was still being written.)
       *
       * So this checks the files, not the behaviour: every categorized item must have a 2b cassette
       * on disk. The pipeline's tolerance cannot mask a recording that was never finished.
       */
      it.each(listScenarios())('%s has a 2b cassette for every item it categorized', async (name) => {
        const { result } = await replay(set.dir, name);
        if (result.status === 'skipped') return;

        const missing = result.manifest
          .map((m) => `item-${String(m.item).padStart(2, '0')}`)
          .filter((key) => !existsSync(join(set.dir, name, '2b', `${key}.txt`)) && !existsSync(join(set.dir, name, '2b', `${key}.json`)));

        expect(missing, `incomplete recording — re-run: npm run record -- --all --agents --provider ${set.name}`).toEqual([]);
      });

      /**
       * The containment invariant, checked end to end rather than at the merge function.
       *
       * **This test used to assert a tautology.** Its body checked that each final category was one
       * of the five enum members — which the type already guarantees — under the name "agents changed
       * no category". It would have passed with every category rewritten. A test whose name states an
       * invariant and whose body cannot fail is worse than no test: it reads as coverage in a summary,
       * and it is why nobody looked here again.
       *
       * What it does now is compare each item's **final** category against **Pass 2a's**, by item
       * number. Measured across both recordings and all eight scenarios: zero differences.
       *
       * A failure here is not automatically a bug — since Part B a role agent *may* propose a
       * category and `applyGates` may accept it. It is a **canary**: a category that changed on the
       * agent path is the one place a model's opinion reaches a disposition, so it is surfaced for a
       * human read rather than absorbed silently.
       */
      it.each(listScenarios())('%s — no category changed between Pass 2a and the writer', async (name) => {
        const { result } = await replay(set.dir, name);
        if (result.status === 'skipped') return;

        const byPass2a = new Map(result.manifest.map((m) => [m.item, m.category]));
        const changed = result.clean
          .filter((c) => byPass2a.get(c.item) !== c.category)
          .map((c) => `  item ${c.item} "${c.title}": 2a said ${byPass2a.get(c.item)}, the writer got ${c.category}`);

        expect(
          changed,
          'An agent proposal changed a category and the gates accepted it. That is permitted — see\n' +
            "AGENTS.md — but it is the one place a model's opinion reaches a disposition, so it is\n" +
            'surfaced rather than absorbed. Confirm the change is right, then update this expectation.\n\n' +
            `${changed.join('\n')}\n`
        ).toEqual([]);
      });

      /** Nothing may vanish between the manifest and a decision, agents or not. */
      it.each(listScenarios())('%s loses no item', async (name) => {
        const { result } = await replay(set.dir, name);
        if (result.status === 'skipped') return;
        expect(result.clean.length + result.held.length + result.skippedNotTask.length).toBe(result.manifest.length);
      });

      /** Whatever 2c planned, 2d confirms — the agent layer must not have desynchronised them. */
      it.each(listScenarios())('%s writes what it planned', async (name) => {
        const { result } = await replay(set.dir, name);
        if (result.status === 'skipped' || !result.exec) return;
        expect(result.exec.failed).toBe(0);
        expect(result.audit?.mismatched ?? 0).toBe(0);
      });
    });
  }

  /**
   * The read-only guarantee, observed over a whole run rather than at the wrapper.
   *
   * Every tool an agent actually called across every scenario must be a read. If a write tool ever
   * appears here, the wrapper has been bypassed somewhere between the loop and the adapter.
   */
  it('never calls anything but a read tool, across every scenario', async () => {
    const READ_ONLY = new Set(['get_task', 'get_task_comments', 'search_tasks']);
    const called = new Set<string>();

    for (const set of SETS) {
      for (const name of listScenarios()) {
        const { events } = await replay(set.dir, name);
        for (const e of events) if (e.type === 'agent:tool') called.add(e.name);
      }
    }

    expect([...called].filter((n) => !READ_ONLY.has(n))).toEqual([]);
    // And the agents did in fact use tools — otherwise this passes by doing nothing.
    expect(called.size).toBeGreaterThan(0);
  });

  /**
   * The anti-fabrication rule, observed over a whole run.
   *
   * The summary is derived from `ExecuteResult`, so the count it reports must equal what the
   * executor actually did. A model narrating its own work is the failure this guards.
   */
  it('reports exactly the creates the executor performed', async () => {
    for (const set of SETS) {
      for (const name of listScenarios()) {
        const { result, events } = await replay(set.dir, name);
        if (result.status === 'skipped' || !result.exec) continue;

        const summary = events.find((e) => e.type === 'agent:summary');
        expect(summary, `${set.name}/${name} emitted no agent summary`).toBeDefined();
        if (summary?.type !== 'agent:summary') throw new Error('unreachable');

        expect(summary.summary).toContain(`${result.exec.created} created`);
      }
    }
  });
});
