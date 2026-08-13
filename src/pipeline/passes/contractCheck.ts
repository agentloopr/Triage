/**
 * Pass 2b — the verification pass, orchestrated.
 *
 * Five checks per item, in order, each short-circuiting the rest:
 *   1. the blind disconfirming re-read (a model call)
 *   2. field completeness + gap fill
 *   3. binary hold gates
 *   4. routing correctness
 *   5. cross-item consistency, once over the survivors
 *
 * **Check 1 fails OPEN.** If the model call errors, the item falls through to the deterministic
 * gates rather than being held. A flaky network call must never silently block well-formed work —
 * that failure mode is invisible and looks exactly like the system being cautious.
 *
 * **Registry degradation fails CLOSED, for the whole batch.** Deliberately a global short-circuit
 * rather than a per-item gate: the human-resume path does not re-check the registry, so a per-item
 * hold would leave a route where approving a held card writes an unassignable task.
 */
import { REGISTRY_FAIL_CLOSED } from '../../config';
import { opsRegistryDegradedReason } from '../../registry/opsRegistry';
import type { BoardTask } from '../../trackers';
import { runWarmedPool } from '../../utils/pool';
import { actionPhrase, describeMatchOrLink, formatClarifyAsk, humanizeMissingField, indexTasks } from '../gates/clarify';
import {
  type ContractFlag,
  type HeldItem,
  binaryHoldGate,
  categoryDisputeHolds,
  crossItemGate,
  fillFieldGaps,
  routingGate,
  uncertainFieldsGate,
} from '../gates/contractGates';
import type { CategorizationItem, MeetingCategory } from '../parsing/categorizationManifest';
import { autoSkippable, legitimacyHolds, parseContractVerdict } from '../parsing/contractVerdict';
import { buildContractCheckerPrompt } from '../prompts/contractCheck';
import type { EnrichedInventoryItem } from '../types';

/**
 * An item the blind read confidently judged not a trackable task. Auto-skipped rather than held,
 * because asking about these is nearly pure friction — but **never silently**: every skip is
 * reported with its title and reason so the rare miss can be created by hand.
 *
 * `assignee` is who the work would have landed on, so the "was this really not a task?" question can
 * be routed to the one person who would know.
 */
export type SkippedNotTask = { item: number; title: string; reason: string; assignee?: string };

export type ContractCheckResult = {
  /** Passed every gate — gap-filled and merged. This is what Pass 2c writes. */
  clean: CategorizationItem[];
  /** Held before any write, each with the gate that fired and a question for a human. */
  held: HeldItem[];
  skippedNotTask: SkippedNotTask[];
  /** Non-fatal review notes: merges performed, over-subtasking, near-duplicate pairs. */
  flags: ContractFlag[];
};

export type ContractCheckerRunner = (prompt: string, label: string, system?: string) => Promise<string>;

export type ContractCheckInput = {
  manifestItems: CategorizationItem[];
  /** The ORIGINAL Pass-1 inventory — the blind read's only item input. Keyed by item number. */
  inventoryItems: EnrichedInventoryItem[];
  tasks: BoardTask[];
  boardSnapshot: string;
  sourceSummary: string;
  sourceText: string;
  participantLine?: string;
  todayIso?: string;
  /** item number → pre-fetched evidence block. */
  tier2ByItem?: Map<number, string>;
  /** item number → retrieved-context block from the retrieval seam. Empty by default. */
  retrievalByItem?: Map<number, string>;
  /** item number → source confidence in [0,1]. A missing entry means unknown, which is trusted. */
  provenanceByItem?: Map<number, number>;
};

export type ContractCheckOptions = {
  runAgent: ContractCheckerRunner;
  poolSize?: number;
  warmFirst?: boolean;
  warmDelayMs?: number;
  routingGateEnabled?: boolean;
  onItem?: (held: HeldItem | null, itemNumber: number) => void;
};

/** Matched by the delivery layer to post one summary instead of fanning out unanswerable questions. */
export const REGISTRY_DEGRADED_GATE = 'ops registry unavailable (running on an empty fallback roster)';

const REGISTRY_DEGRADED_QUESTION = [
  "I've paused every task from this run instead of creating any.",
  '',
  'The team roster and project→list routing file is unreadable right now, so I am running on an ' +
    'empty placeholder with nobody in it. Anything created now could not be assigned correctly.',
  '',
  'Nothing is lost — re-run once the file is restored.',
  'No answer is needed here; this needs an ops fix, not a decision.',
].join('\n');

export async function runContractCheck(
  input: ContractCheckInput,
  opts: ContractCheckOptions
): Promise<ContractCheckResult> {
  if (REGISTRY_FAIL_CLOSED) {
    const degraded = opsRegistryDegradedReason();
    if (degraded) {
      console.error(`[pass2b] HOLDING ALL ${input.manifestItems.length} item(s) — ${degraded}`);
      return {
        clean: [],
        skippedNotTask: [],
        flags: [],
        held: input.manifestItems.map((m) => ({
          item: m.item,
          title: m.title,
          category: m.category,
          gate: REGISTRY_DEGRADED_GATE,
          question: REGISTRY_DEGRADED_QUESTION,
          originalItem: m,
        })),
      };
    }
  }

  const snap = indexTasks(input.tasks);
  const invByNum = new Map(input.inventoryItems.map((i) => [i.number, i]));
  const routingOn = opts.routingGateEnabled ?? true;

  const perItemClean: Array<CategorizationItem | null> = new Array(input.manifestItems.length).fill(null);
  const held: HeldItem[] = [];
  const skippedNotTask: SkippedNotTask[] = [];

  const processOne = async (idx: number): Promise<void> => {
    const m = input.manifestItems[idx]!;
    const inv = invByNum.get(m.item);
    const provenance = input.provenanceByItem?.get(m.item) ?? null;

    let heldThis: HeldItem | null = null;
    let skippedThis = false;

    // ── Check 1 — blind disconfirming re-verification ────────────────────────
    if (inv) {
      try {
        const parts = buildContractCheckerPrompt(inv, input.boardSnapshot, input.sourceSummary, input.sourceText, {
          ...(input.participantLine ? { participantLine: input.participantLine } : {}),
          ...(input.tier2ByItem?.get(inv.number) ? { tier2Evidence: input.tier2ByItem.get(inv.number)! } : {}),
          ...(input.retrievalByItem?.get(inv.number) ? { retrievedContext: input.retrievalByItem.get(inv.number)! } : {}),
          provenance,
        });
        const reply = await opts.runAgent(parts.user, `pass2b:item${m.item}`, parts.system);
        const verdict = parseContractVerdict(reply);

        if (categoryDisputeHolds(m.category, verdict.category)) {
          heldThis = {
            item: m.item,
            title: m.title,
            category: m.category,
            gate: 'category dispute',
            question: formatClarifyAsk({
              facts: [describeMatchOrLink(snap, verdict.matchIds[0])],
              choice: `Create this as a new task, or ${actionPhrase(verdict.category)}?`,
            }),
            originalItem: m,
            disputeVerdict: { category: verdict.category as MeetingCategory, matchIds: verdict.matchIds },
          };
        } else if (autoSkippable(verdict, { provenance }) && legitimacyHolds(m.category, verdict.legitimacy, { pass2aConfidence: m.confidence, provenance })) {
          skippedNotTask.push({
            item: m.item,
            title: m.title,
            reason: verdict.rationale ? verdict.rationale.slice(0, 200) : 'reads more like information than a trackable task',
            ...(m.assignee ? { assignee: m.assignee } : {}),
          });
          skippedThis = true;
        } else if (legitimacyHolds(m.category, verdict.legitimacy, { pass2aConfidence: m.confidence, provenance })) {
          // 'unsure', or resting on a weak source — the read genuinely cannot tell, which is a
          // different risk from confidently judging it non-actionable. Ask; never auto-skip.
          heldThis = {
            item: m.item,
            title: m.title,
            category: m.category,
            gate: 'legitimacy — may not be a trackable task',
            question: formatClarifyAsk({
              facts: provenance !== null && provenance <= 0.75 ? ['The source here was unclear, so I may have misread it.'] : undefined,
              choice: 'Create this as a task, or skip it?',
            }),
            originalItem: m,
          };
        } else {
          if (verdict.category !== 'UNKNOWN' && verdict.category !== m.category) {
            console.log(`[pass2b] item ${m.item}: existing-card dispute (2a=${m.category} vs blind=${verdict.category}) — trusting 2a, not holding`);
          }

          // Grounding is DETECTION only. The single thing it can escalate is a wrong CARD match
          // hiding behind ungrounded wording — folded into the existing category-dispute gate, so a
          // human is asked "is this really that card?", never "is this word right?".
          if (!verdict.grounded && verdict.cardStillMatches === false) {
            heldThis = {
              item: m.item,
              title: m.title,
              category: m.category,
              gate: 'category dispute',
              question: formatClarifyAsk({
                facts: [
                  'A closer look at the source suggests this may not be the same work as the card I matched.',
                  describeMatchOrLink(snap, m.existingTaskId),
                ],
                choice: `Create this as a new task, or ${actionPhrase(m.category)}?`,
              }),
              originalItem: m,
              disputeVerdict: { category: 'NEW_TASK', matchIds: [] },
            };
          } else {
            if (!verdict.grounded) {
              console.log(`[pass2b] item ${m.item}: GROUNDED:no but card identity holds (or n/a) — content left as-is, no rewrite`);
            }
            // Routing, unlike wording, IS a legitimate thing to ask a human about.
            if (!verdict.routingOk && (m.category === 'NEW_TASK' || m.category === 'SUBTASK')) {
              const withUncertainty: CategorizationItem = {
                ...m,
                uncertainFields: [
                  {
                    field: 'list',
                    reason: "I'm not confident this is routed to the right list — the client/entity may be one I don't recognize.",
                    ...(m.list ? { suggested: m.list } : {}),
                  },
                ],
              };
              const uf = uncertainFieldsGate(withUncertainty)!;
              heldThis = { item: m.item, title: m.title, category: m.category, ...uf, originalItem: withUncertainty };
            }
          }
        }
      } catch (err) {
        console.warn(
          `[pass2b] blind read errored for item ${m.item} — failing open to the deterministic gates: ${
            err instanceof Error ? err.message.slice(0, 120) : String(err)
          }`
        );
      }
    }

    // ── Checks 2–4 — deterministic ───────────────────────────────────────────
    if (!heldThis && !skippedThis) {
      const { filled, missing } = fillFieldGaps(m, snap, input.todayIso);

      if (missing.length) {
        heldThis = {
          item: m.item,
          title: m.title,
          category: m.category,
          gate: `unresolvable field(s): ${missing.join(', ')}`,
          question: formatClarifyAsk({
            choice: `I need ${missing.map(humanizeMissingField).join(' and ')} to create this — can you provide ${
              missing.length > 1 ? 'them' : 'it'
            }?`,
          }),
          originalItem: m,
        };
      } else {
        // Checked before the other gates: an uncertain field is a more specific, more answerable
        // reason to ask than anything below it.
        const uf = uncertainFieldsGate(filled);
        if (uf) {
          heldThis = { item: m.item, title: m.title, category: m.category, ...uf, originalItem: filled };
        } else {
          const bin = binaryHoldGate(filled, snap, {
            isVague: inv?.isVague ?? false,
            identityConfirmed: false,
            itemText: inv ? `${inv.title} ${inv.desc}` : m.title,
          });
          if (bin) {
            heldThis = { item: m.item, title: m.title, category: m.category, ...bin, originalItem: filled };
          } else if (routingOn) {
            const route = routingGate(filled);
            if (route) heldThis = { item: m.item, title: m.title, category: m.category, ...route, originalItem: filled };
          }
        }
        if (!heldThis) perItemClean[idx] = filled;
      }
    }

    if (heldThis) held.push(heldThis);
    opts.onItem?.(heldThis, m.item);
  };

  await runWarmedPool(input.manifestItems.length, Math.max(1, opts.poolSize ?? 5), processOne, {
    ...(opts.warmFirst !== undefined ? { warmFirst: opts.warmFirst } : {}),
    ...(opts.warmDelayMs !== undefined ? { warmDelayMs: opts.warmDelayMs } : {}),
  });

  // ── Check 5 — cross-item consistency over the survivors ────────────────────
  const survivors = perItemClean.filter((x): x is CategorizationItem => x !== null);
  const cross = crossItemGate(survivors, snap);
  held.push(...cross.held);

  // Work out who should ANSWER each hold, so questions reach the person who can answer them rather
  // than whoever happened to trigger the run.
  for (const h of held) if (!h.notifyAssignee) h.notifyAssignee = resolveHeldTargetName(h, snap);

  held.sort((a, b) => a.item - b.item);
  skippedNotTask.sort((a, b) => a.item - b.item);

  return { clean: cross.clean, held, skippedNotTask, flags: cross.flags };
}

/**
 * Who should answer a held item: the proposed assignee, else the notify target already resolved for
 * it, else the owner of the existing/parent card it points at. undefined only when nothing resolves.
 */
export function resolveHeldTargetName(held: HeldItem, snap: Map<string, BoardTask>): string | undefined {
  const it = held.originalItem;

  const fromItem = it?.assignee?.trim() || it?.notifyAssignee?.trim();
  if (fromItem) return fromItem;

  const cardId = it?.existingTaskId || it?.parentTaskId;
  if (cardId) {
    const owner = snap.get(cardId)?.assignees[0]?.trim();
    if (owner) return owner;
  }
  return undefined;
}
