/**
 * Four locked failures, as pure logic with the model call injected.
 *
 *   F1  a two-step request        → ONE task     (the consolidator merges create + send)
 *   F2  "log hours going forward" → NOT a task   (an ongoing norm, not a deliverable)
 *   F3  "talk to X about showing up" → NOT a task (people management, not board work)
 *   F4  a feature vs a broader card → NEW_TASK   (keyword overlap is not containment)
 *
 * Each of these was a real production mistake. Locking them here means a fix cannot silently come
 * undone — which is the entire point, and is why they must run in CI rather than needing a live
 * model. Splitting the model call out lets the SAME cases run twice: live to record, offline to
 * assert, with identical assertions either way.
 *
 * **What this does not test: model judgement.** Cassettes freeze the replies, so these cover the
 * deterministic layers — prompt construction, parsing, the merge, containment. A prompt edit that
 * makes the model itself reason worse still needs a re-record to detect. Do not read a green run as
 * "de-tuning was safe".
 */
import { runCategorizationPass } from '../passes/categorization';
import { runInventory, runInventoryConsolidator, runInventoryCritic, type PassRunner } from '../passes/inventory';
import { parseEnrichedInventoryItems } from '../parsing/inventory';
import { renderBoardSnapshot } from '../../trackers/renderSnapshot';
import type { BoardTask } from '../../trackers';
import type { EnrichedInventoryItem } from '../types';

/** The one seam — matches the categorization runner so it drops in unchanged. */
/**
 * `system` is optional but must be THREADED, not dropped.
 *
 * Passes 2a/2b split their prompt into a cacheable `system` half — the taxonomy, the output contract,
 * the board — and a small per-item `user` half. A runner that accepts only `(prompt, label)` silently
 * sends the item with no instructions attached, and the model answers in whatever shape it invents.
 * F4 caught exactly that: a reply in JSON instead of the ITEM/CATEGORY grammar, scored `(unparsed)`.
 */
export type RegressionRunner = (prompt: string, label: string, system?: string) => Promise<string>;

export type RegressionCase = {
  id: string;
  name: string;
  /** Why this was locked — the production mistake it prevents. */
  why: string;
  run(runner: RegressionRunner): Promise<{ pass: boolean; detail: string }>;
};

const asPassRunner = (runner: RegressionRunner): PassRunner => async ({ prompt, label }) => ({
  text: await runner(prompt, label),
});

const silent = { warn: () => {}, log: () => {} };

// ── Fixtures ─────────────────────────────────────────────────────────────────

export const F1_SOURCE = `## Discussion between Alex and Sam
[00:01:00 - 00:01:40] Alex: Sam, today put together a structured questionnaire for the client covering the CRM changes and the pricing-formula work. First build the questionnaire today, then send it over, and once they answer we jump on a call.
[00:02:10 - 00:02:40] Sam: Got it — I'll draft the questionnaire, review it, and send it across today with a note offering a Monday call.`;

export const F2_SOURCE = `## Discussion between Alex and Sam
[00:03:00 - 00:03:35] Alex: One more thing — going forward, log your hours accurately for all client work. From now on do it properly, not rough estimates at the end of the week.`;

export const F3_SOURCE = `## Discussion between Alex and Sam
[00:04:00 - 00:04:45] Alex: Also, have a direct conversation with Morgan about their availability. Explain that if they seriously want to work, they need to show up consistently and check in. I can't start paying them until they're reliably available.`;

export const F4_ITEM: EnrichedInventoryItem = {
  number: 1,
  title: 'Wire theme colours and fonts into image generation',
  desc: 'Add custom theme support to the image-generation pipeline — users can specify brand colours and fonts, injected into the image-gen prompt. The front end already has the font data; wire it through so generation picks up custom themes instead of defaults.',
  timestamp: '00:31:10-00:33:45',
  possibleMatchHint: '"Editor — test and refine" | id:t-abc2 | list:design',
};

export const F4_BOARD: BoardTask[] = [
  {
    id: 't-abc2',
    title: 'Editor — test and refine: voice agent, image generation prompting, scheduling, auto-post',
    listKey: 'design',
    assignees: ['Rowan Diaz'],
    status: 'in progress',
    description:
      'Backend almost done. Remaining: voice agent testing, image generation prompting (infographic style), scheduling and auto-post testing, API integration. Only refinement and testing left.',
  },
];

/** Passes 1 → 1.7 over a source, returning the final item list. */
async function inventoryChain(source: string, runner: RegressionRunner): Promise<EnrichedInventoryItem[]> {
  const deps = { run: asPassRunner(runner), ...silent };

  const inventory = await runInventory({ sourceText: source }, deps);
  if (!inventory.parsed) return [];

  const afterCritic = await runInventoryCritic({ sourceText: source, inventoryRaw: inventory.raw }, deps);
  const afterConsolidator = await runInventoryConsolidator({ inventoryRaw: afterCritic }, deps);
  return parseEnrichedInventoryItems(afterConsolidator);
}

const NOT_A_TASK_RE = {
  F2: /\blog\b.*\bhours\b|\bhours\b.*\blog\b/i,
  F3: /\bavailability\b|\bshow up\b|\bconversation with\b/i,
};

export const REGRESSION_CASES: RegressionCase[] = [
  {
    id: 'F1',
    name: 'a two-step request becomes ONE task, not two',
    why: 'Build-it-then-send-it was captured as two separate cards, so the board showed twice the work that existed.',
    async run(runner) {
      const items = await inventoryChain(F1_SOURCE, runner);
      return {
        pass: items.length === 1,
        detail: `expected 1 item after consolidation, got ${items.length}: ${items.map((i) => i.title).join(' | ')}`,
      };
    },
  },
  {
    id: 'F2',
    name: 'an ongoing norm is not turned into a task',
    why: '"Going forward, log your hours" became a card with no finish line, which then sat open forever.',
    async run(runner) {
      const items = await inventoryChain(F2_SOURCE, runner);
      const offending = items.filter((i) => NOT_A_TASK_RE.F2.test(`${i.title} ${i.desc}`));
      return {
        pass: offending.length === 0,
        detail: `expected the norm to be excluded, but got: ${offending.map((i) => i.title).join(' | ') || '(none)'}`,
      };
    },
  },
  {
    id: 'F3',
    name: 'a people-management conversation is not turned into a task',
    why: 'A private conversation about someone\'s attendance was written onto a shared board, visible to the whole team.',
    async run(runner) {
      const items = await inventoryChain(F3_SOURCE, runner);
      const offending = items.filter((i) => NOT_A_TASK_RE.F3.test(`${i.title} ${i.desc}`));
      return {
        pass: offending.length === 0,
        detail: `expected the conversation to be excluded, but got: ${offending.map((i) => i.title).join(' | ') || '(none)'}`,
      };
    },
  },
  {
    id: 'F4',
    name: 'keyword overlap is not containment — a distinct feature stays NEW_TASK',
    why: 'A new feature was buried as a subtask of a broad "test and refine" card that mentioned the same words, where nobody saw it.',
    async run(runner) {
      const out = await runCategorizationPass(
        {
          items: [F4_ITEM],
          boardSnapshot: renderBoardSnapshot(F4_BOARD),
          sourceSummary: '',
          sourceText: '',
        },
        { runAgent: runner, warmFirst: false }
      );

      const item = out.items[0];
      return {
        pass: item?.category === 'NEW_TASK',
        detail: `expected NEW_TASK, got ${item?.category ?? '(unparsed)'}${item?.parentTaskId ? ` under ${item.parentTaskId}` : ''}`,
      };
    },
  },
];
