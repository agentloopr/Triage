import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore } from '../idempotency/memory';
import type { IngestedSource } from '../ingest';
import { type OpsRegistry, setOpsRegistryPath } from '../registry/opsRegistry';
import { setCorrectionsPath } from '../state/corrections';
import { pendingHumanStore } from '../state/pendingHuman';
import { resumeHold } from './resume';
import type { BoardTask } from '../trackers';
import { memoryTracker } from '../trackers/memory';
import type { DelegationResult } from '../agents/boardAgent';
import type { CategorizationItem } from './parsing/categorizationManifest';
import type { RoleEnrichment } from '../agents/roleAgent';
import { PipelineEvents, type PipelineEvent } from './events';
import { INVENTORY_END, INVENTORY_START } from './parsing/inventory';
import { type PipelineDeps, runPipeline } from './run';

const DIR = join(tmpdir(), `run-test-${process.pid}`);
const REGISTRY_PATH = join(DIR, 'ops-registry.json');

const REGISTRY: OpsRegistry = {
  version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
  members: [{ name: 'Avery Chen', externalIds: { clickup: '1' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] }],
  routes: [{ key: 'backend', externalIds: {}, pattern: 'backend|api|rate limit', defaultAssignee: 'Avery Chen', validAssignees: ['Avery Chen'], status: 'active' }],
  log: [],
};

const BOARD: BoardTask[] = [
  { id: 't900', title: 'Unrelated existing work', listKey: 'backend', assignees: ['Avery Chen'], status: 'to do' },
];

const INVENTORY = [
  INVENTORY_START,
  '1. Add rate limiting to the public API | quote: "the API fell over"',
  '   DESC: Bursts take the service down; add throttling.',
  '   TIMESTAMP: 00:04:00-00:05:00',
  '   POSSIBLE_MATCH_HINT: (none)',
  INVENTORY_END,
].join('\n');

const MANIFEST_2A = [
  'ITEM: 1',
  'TITLE: Add rate limiting to the public API',
  'CATEGORY: NEW_TASK',
  'LIST: backend',
  'ASSIGNEE: Avery Chen',
  'FINAL_DESC: Add a token-bucket limiter to the public endpoints.',
  'CONFIDENCE: high',
  'RATIONALE: Nothing on the board covers this.',
].join('\n');

const VERDICT_2B = ['VERDICT_CATEGORY: NEW_TASK', 'MATCH_TASK_ID: (none)', 'WORTH_A_CARD: real_task', 'GROUNDED: yes', 'ROUTING_OK: yes', 'RATIONALE: No match found after scanning.'].join('\n');

const SOURCE: IngestedSource = {
  kind: 'transcript',
  sourceId: 'meeting-1',
  eventId: 'delivery-1',
  text: '[00:04:00-00:05:00] Avery Chen: the API fell over again, we need rate limiting.',
  summary: 'API stability.',
  participantNames: 'Avery Chen',
  todayIso: '2026-08-11',
};

/** Counts every model call so "a redelivery costs zero tokens" can be asserted, not assumed. */
function makeDeps(over: Partial<PipelineDeps> = {}) {
  const calls: string[] = [];
  const events: PipelineEvent[] = [];
  const emitter = new PipelineEvents();
  emitter.on((e) => events.push(e));

  const deps: PipelineDeps = {
    tracker: memoryTracker({ tasks: BOARD }),
    idempotency: memoryStore(),
    events: emitter,
    runPass: async ({ prompt, label }) => {
      calls.push(label);
      if (label.startsWith('pass0')) return { text: 'cleaned transcript' };
      if (label.startsWith('pass1:')) return { text: INVENTORY };
      if (label.startsWith('pass1.5')) return { text: 'NONE' };
      return { text: `--- CONSOLIDATED INVENTORY ---\nMERGED_PAIRS: 0\n--- END CONSOLIDATED INVENTORY ---${prompt ? '' : ''}` };
    },
    runCategorization: async (_p, label) => {
      calls.push(label);
      return MANIFEST_2A;
    },
    runContractCheck: async (_p, label) => {
      calls.push(label);
      return VERDICT_2B;
    },
    ...over,
  };
  return { deps, calls, events };
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(REGISTRY_PATH);
  setCorrectionsPath(join(DIR, 'corrections.json'));
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

describe('runPipeline — end to end', () => {
  it('runs the full chain and writes the surviving item', async () => {
    const { deps, events } = makeDeps();
    const out = await runPipeline(SOURCE, deps);

    expect(out.status).toBe('completed');
    expect(out.inventory).toHaveLength(1);
    expect(out.manifest[0]).toMatchObject({ category: 'NEW_TASK', list: 'backend' });
    expect(out.clean).toHaveLength(1);
    expect(out.held).toHaveLength(0);
    expect(out.exec?.created).toBe(1);
    expect(out.audit?.mismatched).toBe(0);

    expect(events.filter((e) => e.type === 'pass:done').map((e) => (e as { pass: string }).pass)).toEqual([
      '0-cleanup', '1-inventory', '1.5-critic', '1.7-consolidator', 'evidence', '2a-categorization', '2b-contract-check', '2c-execute', '2d-audit',
    ]);
  });

  it('actually creates the task on the tracker', async () => {
    const { deps } = makeDeps();
    await runPipeline(SOURCE, deps);
    const onBoard = await deps.tracker.listTasks();
    expect(onBoard.map((t) => t.title)).toContain('Add rate limiting to the public API');
  });

  it('plans without writing in a dry run', async () => {
    const { deps } = makeDeps({ execute: false });
    const out = await runPipeline(SOURCE, deps);
    expect(out.clean).toHaveLength(1);
    expect(out.exec).toBeUndefined();
    expect(await deps.tracker.listTasks()).toHaveLength(1); // only the pre-existing card
  });
});

describe('idempotency', () => {
  /**
   * The claim the README makes, asserted rather than assumed: the source check happens BEFORE any
   * model call, so a redelivery costs nothing. A check placed after Pass 0 would still "work" while
   * quietly burning a call on every retry.
   */
  it('a re-run costs ZERO model calls', async () => {
    const store = memoryStore();
    const first = makeDeps({ idempotency: store });
    await runPipeline(SOURCE, first.deps);
    expect(first.calls.length).toBeGreaterThan(0);

    // A NEW delivery of the same meeting, so this exercises the source layer rather than being
    // caught one layer earlier by the repeated event id.
    const second = makeDeps({ idempotency: store });
    const out = await runPipeline({ ...SOURCE, eventId: 'delivery-2' }, second.deps);

    expect(out.status).toBe('skipped');
    expect(out.skipReason).toBe('already processed');
    expect(second.calls).toEqual([]);
  });

  it('catches a duplicate delivery at the event layer first', async () => {
    const store = memoryStore();
    await store.checkAndMark('event', 'delivery-1');
    const { deps, events } = makeDeps({ idempotency: store });

    const out = await runPipeline(SOURCE, deps);
    expect(out.skipReason).toBe('duplicate delivery');
    expect(events.find((e) => e.type === 'skipped')).toMatchObject({ layer: 'event' });
  });

  // The layer no id-based check can replace: the same meeting delivered under a new id.
  it('catches identical content arriving under a different source id', async () => {
    const store = memoryStore();
    await runPipeline(SOURCE, makeDeps({ idempotency: store }).deps);

    const renamed = { ...SOURCE, sourceId: 'meeting-1-reingested', eventId: 'delivery-2' };
    const { deps, events } = makeDeps({ idempotency: store });
    const out = await runPipeline(renamed, deps);

    expect(out.skipReason).toBe('identical content already processed');
    expect(events.find((e) => e.type === 'skipped')).toMatchObject({ layer: 'content' });
  });

  it('lets genuinely different content through', async () => {
    const store = memoryStore();
    await runPipeline(SOURCE, makeDeps({ idempotency: store }).deps);

    const different = { ...SOURCE, sourceId: 'meeting-2', eventId: 'delivery-2' };
    const { deps } = makeDeps({
      idempotency: store,
      runPass: async ({ label }) => {
        if (label.startsWith('pass0')) return { text: 'a completely different meeting' };
        if (label.startsWith('pass1:')) return { text: INVENTORY };
        if (label.startsWith('pass1.5')) return { text: 'NONE' };
        return { text: '--- CONSOLIDATED INVENTORY ---\nMERGED_PAIRS: 0\n--- END CONSOLIDATED INVENTORY ---' };
      },
    });
    expect((await runPipeline(different, deps)).status).toBe('completed');
  });
});

describe('degraded paths', () => {
  it('stops cleanly when Pass 1 produces nothing usable', async () => {
    const { deps, events } = makeDeps({
      runPass: async ({ label }) => (label.startsWith('pass1:') ? { text: 'prose, no inventory' } : { text: 'x' }),
    });
    const out = await runPipeline(SOURCE, deps);
    expect(out.status).toBe('completed');
    expect(out.inventory).toEqual([]);
    expect(events.find((e) => e.type === 'alert')).toBeDefined();
  });

  // These used to be logged once and dropped — never created, never held, never reviewed.
  it('surfaces items Pass 2a could not categorize', async () => {
    const { deps, events } = makeDeps({ runCategorization: async () => 'unparseable garbage' });
    const out = await runPipeline(SOURCE, deps);

    expect(out.uncategorized).toEqual([{ number: 1, title: 'Add rate limiting to the public API' }]);
    expect(events.find((e) => e.type === 'items:uncategorized')).toBeDefined();
  });

  // A flaky verification call must not silently block well-formed work.
  it('fails open to the deterministic gates when the blind read errors', async () => {
    const { deps } = makeDeps({ runContractCheck: async () => { throw new Error('provider down'); } });
    const out = await runPipeline(SOURCE, deps);
    expect(out.clean).toHaveLength(1);
    expect(out.exec?.created).toBe(1);
  });

  it('holds rather than writes when the blind read disputes the category', async () => {
    const { deps, events } = makeDeps({
      runContractCheck: async () => ['VERDICT_CATEGORY: DUPLICATE', 'MATCH_TASK_ID: t900', 'WORTH_A_CARD: real_task', 'RATIONALE: task-comments on t900 shows the same work.'].join('\n'),
    });
    const out = await runPipeline(SOURCE, deps);

    expect(out.clean).toHaveLength(0);
    expect(out.held[0]!.gate).toBe('category dispute');
    expect(out.exec?.created).toBe(0);
    expect(events.find((e) => e.type === 'items:held')).toBeDefined();
  });

  /**
   * PRD §9 gate 5, end to end and across a restart.
   *
   * A gate that holds is only half a feature. Testing the store in isolation proves nothing about
   * whether `runPipeline` ever calls it — and a hold that never reaches disk is lost by the next
   * deploy, silently, after the run has already told someone a question was coming.
   */
  it('persists a hold, and a human can answer it after a restart with no model call', async () => {
    const path = join(DIR, 'pending.json');
    const { deps, calls } = makeDeps({
      pendingHuman: pendingHumanStore(path),
      runContractCheck: async () => ['VERDICT_CATEGORY: DUPLICATE', 'MATCH_TASK_ID: t900', 'WORTH_A_CARD: real_task', 'RATIONALE: task-comments on t900 shows the same work.'].join('\n'),
    });

    const out = await runPipeline(SOURCE, deps);
    expect(out.held).toHaveLength(1);
    expect(out.exec?.created).toBe(0);

    const reloaded = pendingHumanStore(path); // fresh instance, no shared memory
    const [hold] = reloaded.list('meeting-1');
    expect(hold?.gate).toBe('category dispute');

    const callsBefore = calls.length;
    const resumed = await resumeHold(reloaded, hold!.id, 'approve', { tracker: deps.tracker });

    expect(resumed.status).toBe('executed');
    if (resumed.status !== 'executed') throw new Error('unreachable');
    expect(resumed.exec.created).toBe(1);
    expect(calls.length).toBe(callsBefore); // the answer replays the stored decision; no model runs
    expect(reloaded.list()).toEqual([]);
  });

  it('reports rather than throws when the hold store cannot be written', async () => {
    const { deps, events } = makeDeps({
      pendingHuman: {
        register: () => {
          throw new Error('disk full');
        },
        list: () => [],
        get: () => null,
        resolve: () => ({ status: 'unknown' }),
      },
      runContractCheck: async () => ['VERDICT_CATEGORY: DUPLICATE', 'MATCH_TASK_ID: t900', 'WORTH_A_CARD: real_task', 'RATIONALE: task-comments on t900 shows the same work.'].join('\n'),
    });

    const out = await runPipeline(SOURCE, deps);

    // Losing the durable copy is bad; taking the whole run down with it is worse. The hold is still
    // announced, and the failure is surfaced rather than swallowed.
    expect(out.status).toBe('completed');
    expect(events.find((e) => e.type === 'items:held')).toBeDefined();
    expect(events.find((e) => e.type === 'alert' && e.detail.includes('disk full'))).toBeDefined();
  });

  it('auto-skips a confident not-a-task and reports it rather than dropping it', async () => {
    const { deps, events } = makeDeps({
      runContractCheck: async () => ['VERDICT_CATEGORY: NEW_TASK', 'WORTH_A_CARD: not_a_task', 'GROUNDED: yes', 'RATIONALE: a passing aside with no deliverable.'].join('\n'),
    });
    const out = await runPipeline(SOURCE, deps);

    expect(out.clean).toHaveLength(0);
    expect(out.held).toHaveLength(0);
    expect(out.skippedNotTask[0]).toMatchObject({ item: 1 });
    expect(events.find((e) => e.type === 'items:skipped-not-task')).toBeDefined();
  });

  // probeOk is only meaningful when a fetch was ATTEMPTED, so the item must actually name a
  // candidate card — otherwise "nothing fetched" correctly reads as healthy, not as an outage.
  it('alerts when every attempted evidence fetch fails', async () => {
    const tracker = memoryTracker({ tasks: BOARD });
    const withHint = INVENTORY.replace('POSSIBLE_MATCH_HINT: (none)', 'POSSIBLE_MATCH_HINT: Unrelated existing work | id:t900');

    const { deps, events } = makeDeps({
      tracker: { ...tracker, getComments: async () => { throw new Error('down'); } },
      runPass: async ({ label }) => {
        if (label.startsWith('pass1:')) return { text: withHint };
        if (label.startsWith('pass1.5')) return { text: 'NONE' };
        if (label.startsWith('pass0')) return { text: 'cleaned' };
        return { text: '--- CONSOLIDATED INVENTORY ---\nMERGED_PAIRS: 0\n--- END CONSOLIDATED INVENTORY ---' };
      },
    });

    await runPipeline(SOURCE, deps);
    expect(events.some((e) => e.type === 'alert' && e.detail.includes('read path looks down'))).toBe(true);
  });

  it('stays quiet when there was simply nothing to fetch', async () => {
    const { deps, events } = makeDeps();
    await runPipeline(SOURCE, deps);
    expect(events.some((e) => e.type === 'alert' && e.detail.includes('read path looks down'))).toBe(false);
  });
});

/**
 * PRD §5's "authority to write", as it is actually implemented: the agent proposes and the gates
 * decide. These four are the invariants that make that safe, and each one fails loudly if the
 * re-gate is removed or bypassed.
 */
describe('an agent proposal is re-gated, never applied on trust', () => {
  const agentProposing = (enrichment: Partial<RoleEnrichment>, seen?: CategorizationItem[][]) => ({
    delegate: async (items: CategorizationItem[]): Promise<DelegationResult[]> => {
      seen?.push(items);
      return items.map((it) => ({
        item: it.item,
        role: 'engineer' as const,
        owner: 'Avery Chen',
        enrichment: { note: 'n', ...enrichment },
      }));
    },
  });

  it('applies a proposal that survives the gates', async () => {
    // The positive control. Without it, the refusal tests below would also pass if proposals were
    // simply never applied at all.
    const { deps } = makeDeps({ agents: agentProposing({ finalDesc: 'A fuller description from the agent.' }) });
    const out = await runPipeline(SOURCE, deps);

    expect(out.exec?.created).toBe(1);
    expect(out.clean[0]!.finalDesc).toBe('A fuller description from the agent.');
  });

  it('holds instead of writing when a proposal fails a gate', async () => {
    const { deps } = makeDeps({ agents: agentProposing({ proposedList: 'no-such-list' }) });
    const out = await runPipeline(SOURCE, deps);

    expect(out.exec?.created).toBe(0);
    expect(out.held.map((h) => h.gate)).toContain('unknown list key');
    expect(out.clean).toHaveLength(0);
  });

  it('holds when a proposed assignee is not on the roster', async () => {
    const { deps } = makeDeps({ agents: agentProposing({ proposedAssignee: 'Nobody Here' }) });
    const out = await runPipeline(SOURCE, deps);

    expect(out.exec?.created).toBe(0);
    expect(out.held.map((h) => h.gate)).toContain('assignee not in team roster');
  });

  it('turns an ownership doubt into a hold rather than a log line', async () => {
    const { deps } = makeDeps({ agents: agentProposing({ ownershipDoubt: 'this looks like design work' }) });
    const out = await runPipeline(SOURCE, deps);

    expect(out.exec?.created).toBe(0);
    expect(out.held).toHaveLength(1);
    expect(out.held[0]!.question).toContain('this looks like design work');
  });

  it('persists and announces a hold the re-gate created', async () => {
    // The first batch of holds is persisted before it is announced; these are created after that has
    // already happened, so they need the same treatment rather than silently skipping both.
    const { deps, events } = makeDeps({ agents: agentProposing({ proposedList: 'no-such-list' }) });
    const out = await runPipeline(SOURCE, deps);

    const held = events.filter((e) => e.type === 'items:held');
    expect(held).toHaveLength(1);
    expect(out.held).toHaveLength(1);
  });

  /**
   * The containment invariant. An agent that could reach a held item could un-hold it by talking,
   * which would defeat every gate in the repo at once. It is enforced structurally — the agent is
   * handed `checked.clean` and nothing else — so this asserts the agent never even sees it.
   */
  it('never shows the agent an item the gates already held', async () => {
    const seen: CategorizationItem[][] = [];
    const { deps } = makeDeps({
      // Route to a list nobody can own, so Pass 2b holds it before the agent layer runs.
      runCategorization: async () => MANIFEST_2A.replace('LIST: backend', 'LIST: no-such-list'),
      agents: agentProposing({ finalDesc: 'let me fix that for you' }, seen),
    });
    const out = await runPipeline(SOURCE, deps);

    expect(out.held).toHaveLength(1);
    expect(seen).toEqual([[]]); // delegated nothing: there was nothing clean to delegate
    expect(out.exec?.created).toBe(0);
  });
});
