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
import type { ExecuteResult } from '../pipeline/passes/execute';
import type { CategorizationItem } from '../pipeline/parsing/categorizationManifest';
import type { HeldItem } from '../pipeline/gates/contractGates';
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
 * Never wholesale. A role agent may improve prose and may raise a doubt; it may not change what the
 * item is. Merging the whole object would hand an agent the ability to rewrite a category and walk
 * straight past every gate — which is precisely the door this repo keeps shut everywhere else.
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

    if (enrichment.finalDesc) it.finalDesc = enrichment.finalDesc;
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
