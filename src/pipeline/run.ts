/**
 * `runPipeline` — the one public entry point.
 *
 * Ingestion is your problem; this repo starts here, with a normalized source and a tracker. What it
 * does is fixed and deterministic in its ordering:
 *
 *   idempotency (event) → idempotency (source) → Pass 0 → idempotency (content)
 *     → Pass 1 → 1.5 → 1.7 → evidence prefetch → Pass 2a → 2b → 2c → 2d
 *
 * **The idempotency ordering is the part worth copying.** The source check happens BEFORE the source
 * text is read and before any model call, so a redelivery costs zero tokens rather than costing a
 * full run that gets thrown away at the end. The content check sits after cleanup, where it can
 * catch the same meeting arriving under a different id — which no id-based check can see.
 *
 * Everything is injected. No provider, tracker, clock or notification channel is imported here.
 */
import { type DelegationResult, summariseRun } from '../agents/boardAgent';
import { indexTasks } from './gates/clarify';
import { type IdempotencyStore, contentKey } from '../idempotency';
import type { IngestedSource } from '../ingest';
import { errText } from '../providers';
import { type RoleArchetype, getMembers } from '../registry/opsRegistry';
import type { PendingHumanStore } from '../state/pendingHuman';
import type { RoleOpenItem, RoleStateStore } from '../state/roleState';
import type { BoardTask, TrackerAdapter } from '../trackers';
import { renderBoardSnapshot, renderCompactSnapshot } from '../trackers/renderSnapshot';
import { PipelineEvents } from './events';
import { prefetchTier2Evidence } from './evidence/tier2Prefetch';
import { type Retriever, retrieveForItems } from './retrieval';
import type { ContractFlag, HeldItem } from './gates/contractGates';
import { type CategorizationItem } from './parsing/categorizationManifest';
import { parseEnrichedInventoryItems } from './parsing/inventory';
import { type CategorizationAgentRunner, runCategorizationPass } from './passes/categorization';
import { type AuditResult, auditPostWrite } from './passes/audit';
import { type ContractCheckerRunner, type SkippedNotTask, applyGates, runContractCheck } from './passes/contractCheck';
import { type ExecuteResult, executeOperations, planOperations } from './passes/execute';
import { type PassRunner, runCleanup, runInventory, runInventoryConsolidator, runInventoryCritic } from './passes/inventory';
import type { EnrichedInventoryItem } from './types';

export type PipelineDeps = {
  tracker: TrackerAdapter;
  idempotency: IdempotencyStore;
  events?: PipelineEvents;
  /**
   * Where held items go so a human can answer them later, via `resumeHold`.
   *
   * Optional, and leaving it out is a real decision rather than a default. Without a store, a hold
   * exists only in the returned result and in whatever the caller does with the `items:held` event —
   * fine for a dry run, and in a long-lived service it means every open question dies with the
   * process that asked it.
   */
  pendingHuman?: PendingHumanStore;
  /**
   * Where per-role memory goes — what each role now has open, read back into the next run's prompt.
   *
   * Optional, and omitting it means the run keeps no per-role state rather than writing to a default
   * path you did not choose. A pipeline that touches disk without being asked is a surprise, and the
   * write path is the wrong place for surprises.
   */
  roleState?: RoleStateStore;
  /**
   * The optional agent layer (PRD §5). Omit and the pipeline runs exactly as it always has.
   *
   * It runs **after every gate and before the writer**, and it sees only the items that survived —
   * so it cannot reach, or un-hold, anything a gate already stopped. What it proposes is merged by
   * named field and then re-gated by the same `applyGates` Pass 2b uses, so a proposal the gates
   * refuse becomes a human hold rather than a write.
   */
  agents?: { delegate(items: CategorizationItem[]): Promise<DelegationResult[]> };
  /**
   * The retrieval seam (PRD §8) — an external knowledge layer feeding extra context to passes 2a/2b.
   *
   * Omit it and no retrieval happens at all: not a null call, no block, and a prompt byte-identical
   * to one built before this seam existed. That is what keeps every recorded cassette replaying, and
   * it is why the default is absence rather than `nullRetriever`.
   */
  retrieval?: Retriever;
  /** Passes 0 → 1.7. */
  runPass: PassRunner;
  /** Pass 2a. */
  runCategorization: CategorizationAgentRunner;
  /** Pass 2b. Kept separate so the verification pass can use a different (never weaker) model. */
  runContractCheck: ContractCheckerRunner;
  /** Set false to plan everything and write nothing — the dry run. */
  execute?: boolean;
  poolSize?: number;
  warmDelayMs?: number;
};

export type PipelineResult = {
  status: 'completed' | 'skipped';
  /** Present when status is 'skipped'. */
  skipReason?: string;
  inventory: EnrichedInventoryItem[];
  manifest: CategorizationItem[];
  clean: CategorizationItem[];
  held: HeldItem[];
  skippedNotTask: SkippedNotTask[];
  flags: ContractFlag[];
  uncategorized: Array<{ number: number; title: string }>;
  exec?: ExecuteResult;
  audit?: AuditResult;
};

const EMPTY = {
  inventory: [] as EnrichedInventoryItem[],
  manifest: [] as CategorizationItem[],
  clean: [] as CategorizationItem[],
  held: [] as HeldItem[],
  skippedNotTask: [] as SkippedNotTask[],
  flags: [] as ContractFlag[],
  uncategorized: [] as Array<{ number: number; title: string }>,
};

export async function runPipeline(source: IngestedSource, deps: PipelineDeps): Promise<PipelineResult> {
  const events = deps.events ?? new PipelineEvents();
  const emit = events.emit.bind(events);
  const timed = async <T>(pass: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    emit({ type: 'pass:start', pass });
    const out = await fn();
    emit({ type: 'pass:done', pass, ms: Date.now() - started });
    return out;
  };

  const skipped = (layer: 'event' | 'source' | 'content', reason: string): PipelineResult => {
    emit({ type: 'skipped', layer, reason });
    return { status: 'skipped', skipReason: reason, ...EMPTY };
  };

  // ── Idempotency, layers 1 and 2 — BEFORE any work ────────────────────────
  if (source.eventId && (await deps.idempotency.checkAndMark('event', source.eventId))) {
    return skipped('event', 'duplicate delivery');
  }
  if (await deps.idempotency.checkAndMark('source', source.sourceId)) {
    return skipped('source', 'already processed');
  }

  const passDeps = { run: deps.runPass, warn: (m: string) => emit({ type: 'alert', detail: m }) };

  // ── Pass 0 ────────────────────────────────────────────────────────────────
  const cleaned = await timed('0-cleanup', () =>
    runCleanup({ rawSource: source.text, ...(source.participantNames ? { participantNames: source.participantNames } : {}) }, passDeps)
  );

  // ── Idempotency, layer 3 — the same content under a different id ─────────
  if (await deps.idempotency.checkAndMark('content', contentKey(cleaned), { sourceId: source.sourceId })) {
    return skipped('content', 'identical content already processed');
  }

  // The board is read once and reused: the snapshot every pass reasons over must be the same one,
  // or two passes can disagree about what exists for reasons that have nothing to do with judgement.
  const tasks: BoardTask[] = await deps.tracker.listTasks();
  const boardSnapshot = renderBoardSnapshot(tasks);
  const boardCompact = renderCompactSnapshot(tasks);

  // ── Passes 1 → 1.7 ────────────────────────────────────────────────────────
  const inventoryResult = await timed('1-inventory', () =>
    runInventory(
      { sourceText: cleaned, sourceKind: source.kind, boardCompact, ...(source.participantNames ? { participantNames: source.participantNames } : {}) },
      { ...passDeps, onTruncated: () => emit({ type: 'alert', detail: 'Pass 1 output was truncated — the tail of this source was not read. Items may be missing.' }) }
    )
  );
  if (!inventoryResult.parsed) {
    emit({ type: 'alert', detail: 'Pass 1 produced no usable inventory — nothing downstream can run.' });
    return { status: 'completed', ...EMPTY };
  }

  const afterCritic = await timed('1.5-critic', () =>
    runInventoryCritic({ sourceText: cleaned, inventoryRaw: inventoryResult.raw }, passDeps)
  );
  const afterConsolidator = await timed('1.7-consolidator', () =>
    runInventoryConsolidator({ inventoryRaw: afterCritic }, passDeps)
  );

  const inventory = parseEnrichedInventoryItems(afterConsolidator);
  if (inventory.length === 0) return { status: 'completed', ...EMPTY };

  // ── Evidence prefetch, host-side ─────────────────────────────────────────
  const tier2 = await timed('evidence', () => prefetchTier2Evidence(inventory, tasks, deps.tracker));
  if (!tier2.probeOk) {
    emit({
      type: 'alert',
      detail: 'Every evidence fetch failed — the tracker read path looks down. Update-type items will all hold.',
    });
  }

  // Supplementary context, if a knowledge layer is configured. Skipped entirely when it is not —
  // an unconfigured seam must not cost a pass, an event, or a byte of prompt.
  const retrievalByItem = deps.retrieval
    ? await timed('retrieval', () => retrieveForItems(inventory, deps.retrieval!))
    : new Map<number, string>();

  // ── Pass 2a ───────────────────────────────────────────────────────────────
  const categorization = await timed('2a-categorization', () =>
    runCategorizationPass(
      {
        items: inventory,
        boardSnapshot,
        sourceSummary: source.summary ?? '',
        sourceText: cleaned,
        ...(source.participantNames ? { participantLine: source.participantNames } : {}),
        ...(source.todayIso ? { todayIso: source.todayIso } : {}),
        tier2ByItem: tier2.evidenceByItem,
        retrievalByItem,
      },
      {
        runAgent: deps.runCategorization,
        ...(deps.poolSize !== undefined ? { poolSize: deps.poolSize } : {}),
        ...(deps.warmDelayMs !== undefined ? { warmDelayMs: deps.warmDelayMs } : {}),
      }
    )
  );

  // Items 2a could not categorize used to be logged once and dropped — never created, never held,
  // never reviewed. They are surfaced with their titles so a human can see what went missing.
  const uncategorized = categorization.failedItems.map((n) => ({
    number: n,
    title: inventory.find((i) => i.number === n)?.title ?? '(unknown)',
  }));
  if (uncategorized.length) emit({ type: 'items:uncategorized', items: uncategorized });

  // ── Pass 2b ───────────────────────────────────────────────────────────────
  const checked = await timed('2b-contract-check', () =>
    runContractCheck(
      {
        manifestItems: categorization.items,
        inventoryItems: inventory,
        tasks,
        boardSnapshot,
        sourceSummary: source.summary ?? '',
        sourceText: cleaned,
        ...(source.participantNames ? { participantLine: source.participantNames } : {}),
        ...(source.todayIso ? { todayIso: source.todayIso } : {}),
        tier2ByItem: tier2.evidenceByItem,
        retrievalByItem,
        ...(source.provenanceByItem ? { provenanceByItem: source.provenanceByItem } : {}),
      },
      {
        runAgent: deps.runContractCheck,
        ...(deps.poolSize !== undefined ? { poolSize: deps.poolSize } : {}),
        ...(deps.warmDelayMs !== undefined ? { warmDelayMs: deps.warmDelayMs } : {}),
      }
    )
  );

  if (checked.held.length) {
    // Persist BEFORE announcing. If the process dies between the two, a lost notification is
    // recoverable — the hold is still on disk and can be re-announced. The other order loses the
    // question itself while having already told someone it was coming.
    try {
      deps.pendingHuman?.register(source.sourceId, checked.held);
    } catch (err) {
      emit({ type: 'alert', detail: `could not persist ${checked.held.length} hold(s): ${err instanceof Error ? err.message : String(err)}` });
    }

    emit({
      type: 'items:held',
      items: checked.held.map((h) => ({
        item: h.item, title: h.title, gate: h.gate, question: h.question,
        ...(h.notifyAssignee ? { notifyAssignee: h.notifyAssignee } : {}),
      })),
    });
  }
  if (checked.skippedNotTask.length) emit({ type: 'items:skipped-not-task', items: checked.skippedNotTask });
  if (checked.flags.length) emit({ type: 'flags', flags: checked.flags });

  const base = {
    status: 'completed' as const,
    inventory,
    manifest: categorization.items,
    clean: checked.clean,
    held: checked.held,
    skippedNotTask: checked.skippedNotTask,
    flags: checked.flags,
    uncategorized,
  };

  if (deps.execute === false) return base;

  // ── Agent layer (optional) — proposes, does not write ────────────────────
  // Sits between the gates and the writer on purpose. It sees ONLY `checked.clean`, so it cannot
  // reach an item a gate already held — an agent that could un-hold by talking is the whole failure
  // this ordering prevents. What it proposes is re-gated below.
  // Fails open as a whole — the pipeline's own answer stands if the agent layer errors.
  const delegations = deps.agents
    ? await timed('agents', async () => {
        try {
          return await deps.agents!.delegate(checked.clean);
        } catch (err) {
          emit({ type: 'alert', detail: `agent layer failed, keeping the pipeline's answer: ${errText(err)}` });
          return [];
        }
      })
    : [];

  // Re-gate. A proposal is a claim, and it is checked by exactly the rules the pipeline's own answer
  // passed — the same `applyGates` Pass 2b runs, not a second copy of the ordering. Anything the
  // gates now refuse leaves `clean` and joins `held`, so a bad proposal costs a human a question
  // rather than putting a wrong card on the board.
  let writable = checked.clean;
  let held = checked.held;

  if (deps.agents && delegations.some((d) => hasProposal(d.enrichment))) {
    const snap = indexTasks(tasks);
    const invByNum = new Map(inventory.map((i) => [i.number, i]));
    const proposed = applyProposals(checked.clean, delegations);
    const regated = applyGates(proposed, snap, {
      inventoryByNum: invByNum,
      ...(source.todayIso ? { todayIso: source.todayIso } : {}),
    });

    const newlyHeld = regated.held.filter((h) => !checked.held.some((p) => p.item === h.item));

    writable = regated.clean;
    held = [...checked.held, ...newlyHeld].sort((a, b) => a.item - b.item);

    if (newlyHeld.length) {
      // Same order as the first batch above, and for the same reason: a lost notification is
      // recoverable, a lost question is not. These holds are announced separately rather than
      // folded into the earlier event because they did not exist when it fired.
      try {
        deps.pendingHuman?.register(source.sourceId, newlyHeld);
      } catch (err) {
        emit({ type: 'alert', detail: `could not persist ${newlyHeld.length} agent-proposal hold(s): ${errText(err)}` });
      }

      for (const h of newlyHeld) {
        emit({ type: 'alert', detail: `item ${h.item}: an agent proposal did not survive the gates (${h.gate}) — held` });
      }

      emit({
        type: 'items:held',
        items: newlyHeld.map((h) => ({
          item: h.item, title: h.title, gate: h.gate, question: h.question,
          ...(h.notifyAssignee ? { notifyAssignee: h.notifyAssignee } : {}),
        })),
      });
    }

    if (regated.flags.length) emit({ type: 'flags', flags: regated.flags });
  }

  // ── Pass 2c — the only writer ────────────────────────────────────────────
  const exec = await timed('2c-execute', () =>
    executeOperations(planOperations(writable, { ...(source.todayIso ? { todayIso: source.todayIso } : {}) }), deps.tracker)
  );
  emit({ type: 'executed', ...exec });

  // Derived from the executor's results, never from the model. See `summariseRun`.
  if (deps.agents) emit({ type: 'agent:summary', summary: summariseRun(exec, held, delegations) });

  // Per-role memory, written from what actually landed rather than from what was planned — a plan
  // that failed at the tracker must not leave the next run believing the work is underway. Opt-in:
  // no store, no writes.
  if (deps.roleState) {
    recordExecutedWorkByRole(deps.roleState, checked.clean, exec, (detail) => emit({ type: 'alert', detail }));
  }

  // ── Pass 2d — audit against a FRESH read ─────────────────────────────────
  // Re-read rather than reusing `tasks`: auditing against the pre-write snapshot would just re-read
  // our own assumptions and pass every time.
  //
  // `writable`/`held`, NOT `checked.*`. This pass asks "did what we said we would do actually
  // happen", so it must be given what Pass 2c was actually handed. Auditing the pre-proposal list
  // reports every item the re-gate moved to held as a card that should exist and does not — a false
  // alarm, from the one pass whose whole job is to not raise them. Pass 2d caught this itself the
  // first time the re-gate ran, which is the best argument in the repo for why it exists.
  const audit = await timed('2d-audit', async () =>
    auditPostWrite(writable, exec, await deps.tracker.listTasks({ includeClosed: true }), held)
  );
  emit({ type: 'audit', passed: audit.passed, mismatched: audit.mismatched, report: audit.report });

  // `clean` and `held` are re-stated rather than taken from `base`: the agent layer may have moved
  // an item between them, and a caller reading `base`'s copies would be told a card was written that
  // the re-gate actually held.
  return { ...base, clean: writable, held, exec, audit };
}

/**
 * Fold what a run actually wrote into each role's state file.
 *
 * Keyed off the **executed** actions, not the plan: an item whose write failed or was refused is not
 * "already open for" anyone, and recording it would teach the next run to treat undone work as done.
 *
 * Entirely fail-open. This is a memo written after the writes have already succeeded; losing it costs
 * the next run some context and must never turn a successful run into a failed one.
 */
function recordExecutedWorkByRole(
  store: RoleStateStore,
  clean: CategorizationItem[],
  exec: ExecuteResult,
  alert: (detail: string) => void
): void {
  try {
    const roleOf = new Map(getMembers().map((m) => [m.name.toLowerCase(), m.role]));
    const at = new Date().toISOString();
    const byRole = new Map<RoleArchetype, RoleOpenItem[]>();

    for (const action of exec.actions) {
      if (!action.ok || action.outcome !== 'planned') continue;

      const item = clean.find((c) => c.item === action.item);
      const owner = item?.assignee ?? item?.notifyAssignee;
      const role = owner ? roleOf.get(owner.toLowerCase()) : undefined;
      if (!role) continue;

      const created = action.results.find((r) => r.op.kind === 'createTask' && r.outcome.status === 'applied');
      const taskId =
        (created?.outcome.status === 'applied' ? created.outcome.resultId : undefined) ??
        item?.existingTaskId ??
        item?.parentTaskId;

      const bucket = byRole.get(role) ?? [];
      bucket.push({ ...(taskId ? { taskId } : {}), title: action.title, at });
      byRole.set(role, bucket);
    }

    for (const [role, items] of byRole) store.record(role, items);
  } catch (err) {
    alert(`could not update role state: ${(err as Error)?.message ?? err}`);
  }
}

// ── Agent proposals ──────────────────────────────────────────────────────────

/** True when an enrichment asks to change anything a gate would need to re-check. */
function hasProposal(e: DelegationResult['enrichment']): boolean {
  // `finalDesc` counts. A rewritten description is not cosmetic to the gates: the whole-board
  // duplicate backstop scans the item's text, so changing it can change whether the item is a
  // near-duplicate of something already on the board.
  return Boolean(e.finalDesc || e.proposedCategory || e.proposedList || e.proposedAssignee || e.ownershipDoubt);
}

/**
 * Copy an agent's proposals onto a **copy** of each item, by name.
 *
 * Three rules, each load-bearing:
 *
 *  1. **Named fields only.** Never `{...item, ...enrichment}`. A wholesale merge would let a reply
 *     set `tier2Cited`, `uncertainFields` or `raw` — fields the gates read to decide — and an agent
 *     that can set the evidence flag is an agent that can walk past the evidence gate by talking.
 *  2. **Copies, not mutation.** The originals stay intact so a refused proposal leaves the
 *     pipeline's own answer available, and so `base.manifest` still reports what Pass 2a said.
 *  3. **`ownershipDoubt` becomes an uncertain field, not a summary line.** That routes it through
 *     `uncertainFieldsGate`, which holds the item and asks the human the agent's own reason. This is
 *     the same shape Pass 2b already uses when its blind read doubts the routing.
 */
export function applyProposals(items: CategorizationItem[], delegations: DelegationResult[]): CategorizationItem[] {
  const byItem = new Map(delegations.map((d) => [d.item, d.enrichment]));

  return items.map((item) => {
    const e = byItem.get(item.item);
    if (!e || !hasProposal(e)) return item;

    return {
      ...item,
      ...(e.finalDesc ? { finalDesc: e.finalDesc } : {}),
      ...(e.proposedCategory ? { category: e.proposedCategory } : {}),
      ...(e.proposedList ? { list: e.proposedList } : {}),
      ...(e.proposedAssignee ? { assignee: e.proposedAssignee } : {}),
      ...(e.ownershipDoubt
        ? {
            uncertainFields: [
              ...(item.uncertainFields ?? []),
              {
                field: 'assignee' as const,
                reason: e.ownershipDoubt,
                ...(item.assignee ? { suggested: item.assignee } : {}),
              },
            ],
          }
        : {}),
    };
  });
}
