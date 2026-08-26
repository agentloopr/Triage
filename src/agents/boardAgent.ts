/**
 * The board agent — PRD §5's orchestrator.
 *
 * **It decides; Pass 2c executes.** The agent chooses which items need a role agent's attention and
 * summarises what a run did. It never touches the tracker. Writes still go through
 * `planOperations` → `executeOperations`, unchanged and deterministic, so the repo's headline
 * property — *no model in the write path* — survives having an agent above it.
 *
 * That split is not a compromise, it is what production does. There, the board agent runs in a
 * separate agent runtime with a turn cap and *proposes*; every write it makes goes through one
 * script that enforces the protected-status guard, the duplicate check and read-only mode. The agent
 * decides, the deterministic layer enforces. Same shape here.
 *
 * ## The anti-fabrication rule
 *
 * Production's board prompt carries this warning verbatim, because it was learned the expensive way:
 *
 *   > You MUST NOT claim a task was created — no fake success lines, no URLs — unless you actually
 *   > ran create-task and stdout is a full task object with a new id.
 *
 * A model summarising its own work will narrate the work it *intended* to do. So the summary here is
 * not written by the model at all: `summariseRun` is deterministic code over `ExecuteResult`, and the
 * agent is handed the outcome rather than asked what happened. The rule is enforced by construction
 * rather than by asking, which is the same reasoning as `readOnlyTracker`.
 */
import { type ExecuteResult, type ExecutedAction, type PlanContext, planOperations } from '../pipeline/passes/execute';
import type { CategorizationItem } from '../pipeline/parsing/categorizationManifest';
import type { HeldItem } from '../pipeline/gates/contractGates';
import { approvedOpSet, governedTracker } from '../pipeline/gates/governedTracker';
import type { DeterministicGateOptions } from '../pipeline/passes/contractCheck';
import { READ_ONLY_TOOLS, WRITE_TOOLS, makeToolLoopRunner } from '../pipeline/toolLoop';
import { screenedPrimary } from '../utils/security';
import type { BoardTask, OpOutcome, TrackerAdapter, TrackerOperation } from '../trackers';
import { type RoleEnrichment, type RoleAgentDeps, roleOf, runRoleAgent } from './roleAgent';

export interface BoardAgentDeps extends RoleAgentDeps {
  /** Cap on how many items get a role agent in one run. Each one is a model call. */
  maxDelegations?: number;
  onDelegate?: (e: { item: number; role: string; owner: string }) => void;
}

/** Default cap: enough to cover a normal meeting, low enough that a bad batch cannot run away. */
export const MAX_DELEGATIONS = 8;

/**
 * Which items are worth a role agent's time.
 *
 * Deterministic on purpose — asking a model "which of these need attention?" spends a call to save
 * calls, and it gets the empty case wrong more often than a rule does. The rule: an item needs a
 * look when it has an owner on the roster AND its description is too thin to act on, or it touches
 * an existing card whose history the agent could actually read.
 */
export function selectForDelegation(items: CategorizationItem[], max = MAX_DELEGATIONS): CategorizationItem[] {
  return items
    .filter((it) => {
      const owner = it.assignee ?? it.notifyAssignee;
      if (!owner || !roleOf(owner)) return false;
      const thin = (it.finalDesc ?? '').trim().length < 120;
      return thin || !!it.existingTaskId;
    })
    .slice(0, max);
}

export interface DelegationResult {
  item: number;
  role: string;
  owner: string;
  enrichment: RoleEnrichment;
}

/**
 * Hand each selected item to its role agent, and merge the result FIELD BY FIELD.
 *
 * Never wholesale. A role agent may **propose** prose, a category, a list, an assignee or a doubt —
 * and nothing it proposes is applied here. `applyProposals` copies the named fields onto a copy and
 * `applyGates` re-runs every gate over the result, so a refused proposal becomes a human hold.
 *
 * Merging the whole object would let an agent set any field the parser never named, including ones
 * no gate inspects — which is precisely the door this repo keeps shut everywhere else.
 *
 * (This said "it may not change what the item is" until an outside audit found it. True before the
 * re-gate shipped. The guarantee was never "an agent cannot propose"; it is "a proposal faces the
 * same gates the pipeline's own answer faced".)
 */
export async function delegateToRoleAgents(
  items: CategorizationItem[],
  deps: BoardAgentDeps
): Promise<DelegationResult[]> {
  const out: DelegationResult[] = [];

  for (const it of selectForDelegation(items, deps.maxDelegations ?? MAX_DELEGATIONS)) {
    const owner = (it.assignee ?? it.notifyAssignee)!;
    const role = roleOf(owner);
    if (!role) continue;

    deps.onDelegate?.({ item: it.item, role, owner });

    const enrichment = await runRoleAgent(
      {
        role,
        owner,
        title: it.title,
        desc: it.finalDesc ?? '',
        ...(it.existingTaskId ?? it.parentTaskId ? { taskId: (it.existingTaskId ?? it.parentTaskId)! } : {}),
      },
      deps
    );
    if (!enrichment) continue; // fails open — keep the pipeline's own answer

    // Deliberately does NOT touch `it`. Every change an agent asks for is applied by `applyProposals`
    // in `pipeline/run.ts` and then re-gated, so there is exactly one place where an agent's words
    // become an item — and it is a place that re-checks them. This function used to write `finalDesc`
    // straight onto the item, which meant one field skipped the check the others now get.
    out.push({ item: it.item, role, owner, enrichment });
  }

  return out;
}

/**
 * What the run did, derived from the executor's own results.
 *
 * **The model is not asked.** Every number here comes from `ExecuteResult`, and an item appears as
 * created only if an operation actually returned `applied`. This is the anti-fabrication rule as
 * code: there is no path by which a summary can claim a write the tracker did not perform.
 */
export function summariseRun(exec: ExecuteResult, held: HeldItem[], delegations: DelegationResult[]): string {
  const lines = [
    `${exec.created} created · ${exec.commented} commented · ${exec.skipped} skipped · ` +
      `${exec.refused} refused · ${exec.unsupported} unsupported · ${exec.failed} failed`,
  ];

  const created = exec.actions
    .filter((a) => a.ok && a.results.some((r) => r.op.kind === 'createTask' && r.outcome.status === 'applied'))
    .map((a) => a.title);
  if (created.length) lines.push(`created: ${created.join('; ')}`);

  // A refusal is a guard doing its job and needs a human; it must never be filed under "failed",
  // and it must never disappear into a total. `unsupported` is the tracker saying it cannot express
  // the operation at all — also not a failure, and also not something a retry fixes.
  const withDetail = (status: 'refused' | 'unsupported'): string[] =>
    exec.actions.flatMap((a) =>
      a.results
        .filter((r) => r.outcome.status === status)
        .map((r) => `${a.title} — ${'detail' in r.outcome ? r.outcome.detail : status}`)
    );

  const refused = withDetail('refused');
  if (refused.length) lines.push(`refused (needs a human): ${refused.join('; ')}`);

  const unsupported = withDetail('unsupported');
  if (unsupported.length) lines.push(`unsupported by this tracker: ${unsupported.join('; ')}`);

  if (held.length) lines.push(`held for a human: ${held.map((h) => `${h.title} (${h.gate})`).join('; ')}`);

  const doubts = delegations.filter((d) => d.enrichment.ownershipDoubt);
  if (doubts.length) {
    lines.push(`ownership doubts raised: ${doubts.map((d) => `${d.owner} — ${d.enrichment.ownershipDoubt}`).join('; ')}`);
  }

  if (delegations.length) lines.push(`${delegations.length} item(s) reviewed by a role agent`);

  return lines.join('\n');
}

// ── The board agent as writer (BOARD_AGENT_WRITES) ───────────────────────────
//
// Everything above this line runs whenever the agent layer is on. Everything below runs only when
// `BOARD_AGENT_WRITES` is also on, and it is the one configuration in which a model reaches the
// tracker at all.
//
// **Why this exists.** PRD §5 gives the board agent "authority to write", and production means that
// literally: its board agent runs a create command and a guard layer decides whether the command
// lands. This is that shape. The default — Pass 2c, no model — is the smaller claim, and it stays
// the default for the reason `AGENTS_ENABLED` is off: it is the claim this repo can make without
// asking anyone to trust a model with a mutation.
//
// **What the agent adds over Pass 2c.** Pass 2c applies a plan exactly. The agent can look at the
// board first and change its mind: comment on the card that already covers this instead of creating
// a second one, or merge two items that turned out to be the same work. That is judgement Pass 2c
// structurally cannot exercise, and it is what production's board agent spends its turns on.
//
// **What it cannot do.** Originate a write the gates refuse. See `gates/governedTracker.ts`.

export interface BoardWriteDeps {
  model: RoleAgentDeps['model'];
  tracker: TrackerAdapter;
  snapshot: Map<string, BoardTask>;
  gateOpts?: DeterministicGateOptions;
  planCtx?: PlanContext;
  maxIterations?: number;
  onHold?: (held: HeldItem, op: TrackerOperation) => void;
  onEvent?: RoleAgentDeps['onEvent'];
}

const OUTCOME_ORDER: Array<OpOutcome['status']> = ['failed', 'refused', 'unsupported', 'applied', 'unchanged'];

/**
 * Have the board agent write the approved plan.
 *
 * Returns the same `ExecuteResult` Pass 2c returns, so Pass 2d, the `executed` event, role-state and
 * the run summary all work unchanged — none of them should need to know which writer ran.
 *
 * **The tally is built from outcomes, never from the model's account of itself.** That is the
 * anti-fabrication rule from `summariseRun` above, and it matters more here than anywhere else in the
 * repo: this is the one place a model could claim a card it never created.
 */
export async function writeBoard(items: CategorizationItem[], deps: BoardWriteDeps): Promise<ExecuteResult> {
  const plan = planOperations(items, deps.planCtx ?? {});

  // Which cards the agent actually opened the history of. Becomes `tier2Cited` at the gate, so the
  // evidence check here is a fact about what it read rather than a claim it made in prose.
  const commentsRead = new Set<string>();

  const performed: Array<{ op: TrackerOperation; outcome: OpOutcome }> = [];
  const governed = governedTracker(deps.tracker, {
    approvedOps: approvedOpSet(plan.flatMap((a) => a.ops)),
    snapshot: deps.snapshot,
    ...(deps.gateOpts ? { gateOpts: deps.gateOpts } : {}),
    readComments: (id) => commentsRead.has(id),
    ...(deps.onHold ? { onHold: deps.onHold } : {}),
  });

  // Record-and-forward, so the tally below counts what the tracker did rather than what the loop
  // believes it asked for.
  const recording: TrackerAdapter = {
    ...governed,
    async apply(op) {
      const outcome = await governed.apply(op);
      performed.push({ op, outcome });
      return outcome;
    },
  };

  const run = makeToolLoopRunner({
    model: deps.model,
    tracker: recording,
    tools: [...READ_ONLY_TOOLS, ...WRITE_TOOLS],
    writable: true, // `recording` is already governed; wrapping it read-only would refuse everything
    ...(deps.maxIterations != null ? { maxIterations: deps.maxIterations } : {}),
    onEvent: (e) => {
      if (e.kind === 'tool' && e.name === 'get_task_comments') commentsRead.add(String(e.args.task_id ?? ''));
      deps.onEvent?.(e);
    },
  });

  try {
    await run(buildBoardWritePrompt(items, deps.tracker.renderSnapshot([...deps.snapshot.values()])), 'board/write');
  } catch (err) {
    // **A loop that wrote nothing rethrows.** It reached the tracker zero times, so there is no
    // partial result to report and every number below would be a zero that looks like a decision.
    // A missing cassette lands here, and it has to be as loud as it is everywhere else in this repo:
    // swallowing it produced a run that printed a tidy "0 created" and left Pass 2d to infer the
    // problem from four mismatches, which is precisely the quiet-wrong-number failure the cassette
    // client refuses to ship.
    if (performed.length === 0) throw err;

    // Some writes did land. Those are real, they are on the board, and the honest move is to report
    // them and let Pass 2d name the gap — a half-written run that counts itself correctly is
    // recoverable in a way one that claims success is not.
    deps.onEvent?.({ kind: 'cap-hit', iterations: performed.length });
  }

  return tally(plan, performed);
}

/**
 * The prompt. Deliberately short on encouragement and specific about the one thing that differs from
 * Pass 2c: it may disagree with the plan, and the interesting case is when it should.
 */
export function buildBoardWritePrompt(items: CategorizationItem[], boardText: string): string {
  return [
    'You are the board agent. The pipeline has already decided what should happen to each item below,',
    'and every one of them has passed every deterministic gate. Your job is to write them to the board.',
    '',
    'THE BOARD RIGHT NOW:',
    screenedPrimary(boardText, 'board-write-snapshot'),
    '',
    'WHAT THE PIPELINE DECIDED:',
    ...items.map((it) => {
      const target = it.existingTaskId ?? it.parentTaskId;
      return `  [${it.item}] ${it.category}: ${screenedPrimary(it.title, `board-write-item-${it.item}`)}` +
        `${target ? ` → ${target}` : ''}${it.assignee ? ` · ${it.assignee}` : ''}${it.list ? ` · ${it.list}` : ''}`;
    }),
    '',
    'Write each one. Applying the plan as given is the right answer for almost all of them.',
    '',
    'You may depart from it where looking at the board tells you something the pipeline could not:',
    'if a card already covers an item, comment on that card instead of creating a duplicate; if two',
    'items are the same work, write one. Read a card before you claim it covers something — an',
    'update whose history you have not opened will be refused.',
    '',
    'Anything you write that the pipeline did not plan is re-checked by the same gates it passed.',
    'A refusal comes back with the reason. Respond to it — do not retry the same write.',
    '',
    'Stop when every item is written or accounted for. Do not summarise; the summary is generated',
    'from what the board actually did, not from what you say here.',
  ].join('\n');
}

/** Fold the operations the tracker actually performed back into per-action results. */
function tally(plan: ReturnType<typeof planOperations>, performed: Array<{ op: TrackerOperation; outcome: OpOutcome }>): ExecuteResult {
  const counts = { created: 0, commented: 0, skipped: 0, refused: 0, failed: 0, unsupported: 0 };
  const left = [...performed];

  const actions: ExecutedAction[] = plan.map((action) => {
    // An op belongs to the action that planned it. Agent-originated ops match nothing here and are
    // gathered into their own action below rather than being silently attributed to a planned item.
    const results = action.ops.flatMap((planned) => {
      const i = left.findIndex((p) => p.op === planned || JSON.stringify(p.op) === JSON.stringify(planned));
      return i === -1 ? [] : left.splice(i, 1);
    });
    return { ...action, results, ok: results.length > 0 && results.every((r) => r.outcome.status === 'applied' || r.outcome.status === 'unchanged') };
  });

  if (left.length) {
    actions.push({
      item: -1,
      category: 'UNKNOWN',
      title: 'agent-originated writes',
      ops: left.map((p) => p.op),
      outcome: 'planned',
      results: left,
      ok: left.every((r) => r.outcome.status === 'applied' || r.outcome.status === 'unchanged'),
    });
  }

  for (const { op, outcome } of performed) {
    if (outcome.status === 'applied') {
      if (op.kind === 'createTask') counts.created++;
      else if (op.kind === 'addComment') counts.commented++;
    } else if (outcome.status === 'refused') counts.refused++;
    else if (outcome.status === 'unsupported') counts.unsupported++;
    else if (outcome.status === 'failed') counts.failed++;
  }

  // A planned action whose ops never reached the tracker is not a success. The agent chose not to
  // write it, and that is exactly the kind of quiet omission Pass 2d exists to catch — so it is
  // counted as skipped and left visible rather than folded into a total.
  counts.skipped += plan.filter((a) => a.outcome === 'skipped_duplicate').length;

  return { actions, ...counts };
}

/** Ordering helper for traces: worst outcome first, so a refusal is never buried under successes. */
export const worstOutcomeFirst = (a: OpOutcome['status'], b: OpOutcome['status']): number =>
  OUTCOME_ORDER.indexOf(a) - OUTCOME_ORDER.indexOf(b);
