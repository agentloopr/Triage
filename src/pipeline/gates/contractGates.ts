/**
 * The deterministic gates — the entire human-in-the-loop policy, as pure-ish functions.
 *
 * Everything here runs AFTER the model has produced a categorization and BEFORE anything is written.
 * A gate's only power is to turn a proposed write into a question. That asymmetry is the design: a
 * wrong hold costs one message, a wrong write costs a corrupted board and the trust that goes with
 * it, so every gate fails toward asking.
 *
 * These functions need no model, no network and no mocks, which is why they carry most of the test
 * weight in this repo.
 */
import { CATCH_ALL_LIST_KEY } from '../../config';
import { findMemberByName, findRouteByKey, getEffectiveValidAssignees, normalizeListKey, routeTitleToList } from '../../registry/identity';
import { getRoutes } from '../../registry/opsRegistry';
import { isKnownNotDuplicate } from '../../state/corrections';
import type { BoardTask } from '../../trackers';
import { jaccard } from '../evidence/tier2Prefetch';
import type { CategorizationItem, MeetingCategory, UncertainField } from '../parsing/categorizationManifest';
import {
  type ClarifyAsk,
  describeMatchOrLink,
  formatClarifyAsk,
  humanizeFieldName,
  taskUrl,
} from './clarify';

export type GateResult = { gate: string; question: string } | null;

export type HeldItem = {
  item: number;
  title: string;
  category: string;
  /** Which gate fired — the label a human sees in the review digest. */
  gate: string;
  question: string;
  /** The full gap-filled item at hold time, so a resolution can re-enter execution without re-running the model. */
  originalItem?: CategorizationItem;
  /** Category-dispute only: the blind verdict, kept structured for resolution. */
  disputeVerdict?: { category: MeetingCategory; matchIds: string[] };
  /**
   * Who should ANSWER this. Resolved at hold time — the proposed assignee, else the existing card's
   * owner. Without it, every question lands on whoever happened to trigger the run, which is how
   * unrelated holds end up being ignored.
   */
  notifyAssignee?: string;
};

export type ContractFlag = {
  kind: 'updates_merged' | 'over_subtask' | 'missed_dup' | 'near_dup_pair';
  items: number[];
  note: string;
};

// ── Deterministic helpers ────────────────────────────────────────────────────

const NORM_RE =
  /\b(going forward|from now on|in the future|always|every ?time|each time|regularly|on an ongoing basis|keep doing|make sure to always)\b/i;
const HR_RE =
  /\b(talk to|speak (?:to|with)|have a (?:conversation|chat|word)|about (?:his|her|their) (?:attitude|availability|reliability|work ethic|behaviou?r|payment)|needs? to show up|reliably available)\b/i;

/** Title-pattern backstop for a non-task that slipped the inventory passes — the only net for this here. */
export function matchesNormOrHr(title: string): string | null {
  if (NORM_RE.test(title)) return 'norm/policy';
  if (HR_RE.test(title)) return 'people-management';
  return null;
}

/**
 * A 2a-vs-2b category disagreement holds only when it crosses the **new-vs-existing** boundary — one
 * read says this is new work, the other says it is an existing card. That is a real question.
 *
 * When both reads agree it is an existing-card action and differ only on *how* to annotate it (any
 * mix of DUPLICATE/UPDATE/SUBTASK), trust 2a and proceed. Holding those held back exactly the status
 * updates this pipeline exists to make, for a distinction no human cares about.
 */
export function categoryDisputeHolds(
  cat2a: MeetingCategory | 'UNKNOWN',
  catBlind: MeetingCategory | 'UNKNOWN'
): boolean {
  if (catBlind === 'UNKNOWN' || catBlind === cat2a) return false;
  const EXISTING_CARD = new Set<string>(['DUPLICATE', 'UPDATE', 'SUBTASK']);
  return !(EXISTING_CARD.has(cat2a) && EXISTING_CARD.has(catBlind));
}

// ── Field completeness + gap fill ────────────────────────────────────────────

/**
 * Fill what can be resolved from the board and routing config, and report what cannot.
 *
 * Anything filled from a *pipeline* default rather than the source is marked uncertain rather than
 * written silently — "ask, don't guess". The human's answer is a one-time confirm-or-correct.
 * Operates on a clone; the model's original item is never mutated.
 */
export function fillFieldGaps(
  item: CategorizationItem,
  snap: Map<string, BoardTask>,
  todayIso?: string
): { filled: CategorizationItem; missing: string[] } {
  const f: CategorizationItem = { ...item };
  const missing: string[] = [];
  const uncertain: UncertainField[] = [...(item.uncertainFields ?? [])];

  if (f.category === 'NEW_TASK' || f.category === 'SUBTASK') {
    if (!f.finalDesc) missing.push('FINAL_DESC');

    if (!f.list) {
      const r = routeTitleToList(f.title);
      if (r) f.list = r.key;
      else missing.push('LIST');
    } else {
      // Canonicalize a provided key so gate, executor and logs all agree. A genuinely unknown key is
      // left alone for the routing gate to hold on.
      const r = findRouteByKey(f.list);
      if (r) f.list = r.key;
    }

    if (!f.assignee) {
      const r = f.list ? findRouteByKey(f.list) : routeTitleToList(f.title);
      const owner = r?.defaultAssignee;
      if (owner) {
        f.assignee = owner;
        // Nobody named an owner and the model left it blank; the list's default is a pipeline
        // fallback, not a fact from the source. Flag it rather than write it as if it were confirmed.
        if (!uncertain.some((u) => u.field === 'assignee')) {
          uncertain.push({
            field: 'assignee',
            reason: `no assignee was named in the source or chosen by categorization — filled from ${f.list ?? 'the list'}'s default owner`,
            suggested: owner,
          });
        }
      } else {
        missing.push('ASSIGNEE');
      }
    }

    if (!f.priority) f.priority = 'normal';
    if (!f.status) f.status = 'not started';
    // Every task carries a due date; when the source stated none, fall back to the run date. A missing
    // due date is never a reason to hold.
    if (!f.dueDate && todayIso) f.dueDate = todayIso;
    if (f.category === 'SUBTASK' && !f.parentTaskId) missing.push('PARENT_TASK_ID');

    // Backstop: the model is told to self-report an unrecognized entity. If it routed to the
    // catch-all at low confidence WITHOUT self-reporting, catch it here — never silently write a
    // low-confidence catch-all route. Only fires when a catch-all list is configured.
    if (
      CATCH_ALL_LIST_KEY &&
      f.list &&
      normalizeListKey(f.list) === normalizeListKey(CATCH_ALL_LIST_KEY) &&
      f.confidence === 'low' &&
      !uncertain.some((u) => u.field === 'list')
    ) {
      uncertain.push({
        field: 'list',
        reason: `routed to the ${CATCH_ALL_LIST_KEY} catch-all at low confidence — the entity in this item may not be recognized`,
        suggested: CATCH_ALL_LIST_KEY,
      });
    }
  } else if (f.category === 'UPDATE') {
    if (!f.finalDesc) missing.push('FINAL_DESC');
    if (!f.existingTaskId) missing.push('EXISTING_TASK_ID');
    // On a reassign, notify the NEW owner; otherwise the card's current owner.
    if (!f.notifyAssignee && f.assignee) f.notifyAssignee = f.assignee;
    if (!f.notifyAssignee && f.existingTaskId) {
      const t = snap.get(f.existingTaskId);
      const owner = t?.assignees[0];
      if (owner) f.notifyAssignee = owner;
    }
    if (!f.notifyAssignee) missing.push('NOTIFY_ASSIGNEE');
  } else if (f.category === 'DUPLICATE') {
    if (!f.existingTaskId) missing.push('EXISTING_TASK_ID');
  } else if (f.category === 'RELATE') {
    if (!f.linkTaskId1) missing.push('LINK_TASK_ID_1');
    if (!f.linkTaskId2) missing.push('LINK_TASK_ID_2');
  }

  if (uncertain.length) f.uncertainFields = uncertain;
  return { filled: f, missing };
}

export function formatUncertainFieldsQuestion(item: CategorizationItem): string {
  const fields = item.uncertainFields ?? [];
  const facts = fields.map((u) => `${u.reason}${u.suggested ? ` (I'd otherwise use "${u.suggested}")` : ''}`);
  const needsList = fields.some((u) => u.field === 'list');
  const needsAssignee = fields.some((u) => u.field === 'assignee');
  const hint =
    needsList || needsAssignee
      ? `Reply e.g. "${[needsList ? 'List: <name>' : '', needsAssignee ? 'Assignee: <name>' : ''].filter(Boolean).join(', ')}", or "skip".`
      : 'Reply with the correction, or "skip".';
  const whatINeed = fields.map((u) => humanizeFieldName(u.field)).join(' and ');

  return formatClarifyAsk({ facts, choice: `Can you confirm ${whatINeed || 'this'}?`, hint });
}

/**
 * The single "ask, don't guess" enforcement point. Holds whenever ANY field is marked uncertain,
 * regardless of which field or why — model self-report, the gap-fill fallback above, or the blind
 * read's own grounding check all feed the same channel, so a new source of uncertainty is covered
 * without touching this gate.
 */
export function uncertainFieldsGate(item: CategorizationItem): GateResult {
  if (!item.uncertainFields?.length) return null;
  return { gate: 'uncertain field(s)', question: formatUncertainFieldsQuestion(item) };
}

// ── Binary hold gates ────────────────────────────────────────────────────────

/** Min title similarity counting as a confident card-identity match for an explicit UPDATE. */
const UPDATE_TITLE_MATCH_FLOOR = 0.18;
/** Whole-board similarity at or above which a NEW_TASK is held as a possible missed duplicate. */
const MISSED_DUP_FLOOR = 0.6;
/** Same, for two NEW_TASKs in one run on the same list. */
const NEAR_DUP_PAIR_FLOOR = 0.7;

export type GateContext = {
  /** The inventory flagged this as a vague reference ("this is done") needing external grounding. */
  isVague?: boolean;
  /** Something independently confirmed which card the vague reference meant. */
  identityConfirmed?: boolean;
  /** Item title + description, for the identity-similarity check. */
  itemText?: string;
};

export function binaryHoldGate(item: CategorizationItem, snap: Map<string, BoardTask>, ctx: GateContext = {}): GateResult {
  const norm = matchesNormOrHr(item.title);
  if (norm) {
    return {
      gate: `title matches ${norm} pattern`,
      question: formatClarifyAsk({
        choice: 'Is this a one-time task, or an ongoing note/policy?',
        hint: 'If a task, restate it as one concrete deliverable with a clear finish line.',
      }),
    };
  }

  // An UPDATE is gated on CARD IDENTITY, not comment history. The deciding evidence is the source
  // (what changed) plus which card it refers to — comment history is the wrong proof for that.
  if (item.category === 'UPDATE') {
    const card = item.existingTaskId ? snap.get(item.existingTaskId) : undefined;
    const titleSim = card ? jaccard(ctx.itemText || item.title, card.title) : 0;

    if (ctx.isVague) {
      if (!ctx.identityConfirmed) {
        return {
          gate: 'vague update — card not confirmed',
          question: formatClarifyAsk({
            facts: ['This points at a card only as "this/that" and I could not confirm which one was meant.'],
            choice: 'Which existing card should I update, or is this a new task?',
          }),
        };
      }
    } else if (!(titleSim >= UPDATE_TITLE_MATCH_FLOOR || item.tier2Cited || ctx.identityConfirmed)) {
      return {
        gate: 'update — card match not confident',
        question: formatClarifyAsk({
          facts: [describeMatchOrLink(snap, item.existingTaskId)].map((f) =>
            f ? `I matched this to (not fully confident it's the right one):\n${f}` : null
          ),
          choice: 'Update that card, or create a new task?',
        }),
      };
    }

    // Identity is settled. An explicit field correction (reassign / move) must still resolve to a
    // real person and a valid person↔list pairing: apply if explicit, ask if unsure.
    if (card) {
      const listCheck = unknownListGate(item.list, 'Which list should this move to?');
      if (listCheck) return listCheck;

      if (item.assignee) {
        const assigneeCheck = assigneeGates(item.assignee, item.list || card.listKey);
        if (assigneeCheck) return assigneeCheck;
      }
    }
  }

  // DUPLICATE / SUBTASK still require cited evidence — "same work" and containment are exactly the
  // claims comment history proves, and it is supplied to the prompt rather than fetched by the model.
  if ((item.category === 'DUPLICATE' || item.category === 'SUBTASK') && !item.tier2Cited) {
    const intended =
      item.category === 'DUPLICATE' ? 'skip it as a duplicate of an existing card' : 'add it as a subtask under an existing card';
    const refId = item.category === 'SUBTASK' ? item.parentTaskId : item.existingTaskId;
    return {
      gate: 'evidence not cited',
      question: formatClarifyAsk({
        facts: [describeMatchOrLink(snap, refId)],
        choice: `Go ahead and ${intended}, or create this as a new task instead?`,
      }),
    };
  }

  // Referenced ids must exist on the open board.
  if ((item.category === 'DUPLICATE' || item.category === 'UPDATE') && item.existingTaskId && !snap.has(item.existingTaskId)) {
    return {
      gate: 'referenced task id not on the board',
      question: formatClarifyAsk({
        facts: [`The card I matched (${taskUrl(item.existingTaskId)}) is no longer on the board — it may have been closed or deleted.`],
        choice: 'What should this be — a different existing card, or a new task?',
      }),
    };
  }
  if (item.category === 'SUBTASK' && item.parentTaskId && !snap.has(item.parentTaskId)) {
    return {
      gate: 'parent task id not on the board',
      question: formatClarifyAsk({
        facts: [`The parent card I matched (${taskUrl(item.parentTaskId)}) is no longer on the board.`],
        choice: 'What should the parent be — a different card, or should this be a standalone task?',
      }),
    };
  }

  // A subtask generally must live on its parent's list. A mismatch means a mis-route, a mis-filed
  // parent, or work that should stand alone — all of which a human resolves faster than a failed write.
  if (item.category === 'SUBTASK' && item.parentTaskId && item.list) {
    const parent = snap.get(item.parentTaskId);
    if (parent?.listKey && normalizeListKey(item.list) !== normalizeListKey(parent.listKey)) {
      return {
        gate: 'subtask list ≠ parent list',
        question: formatClarifyAsk({
          facts: [
            `The parent card lives on list "${parent.listKey}", but this was routed to "${item.list}".`,
            `Parent: "${parent.title}"\n  ${taskUrl(item.parentTaskId)}`,
          ],
          choice: `Keep this as a subtask (I'll move it to "${parent.listKey}"), or make it a standalone task on "${item.list}"?`,
        }),
      };
    }
  }

  if (item.category === 'RELATE') {
    for (const id of [item.linkTaskId1, item.linkTaskId2]) {
      if (id && !snap.has(id)) {
        return {
          gate: 'RELATE link id not on the board',
          question: formatClarifyAsk({
            facts: [`One of the linked cards (${taskUrl(id)}) is no longer on the board.`],
            choice: 'What are the correct two task ids to link?',
          }),
        };
      }
    }
  }

  return null;
}

// ── Routing gate ─────────────────────────────────────────────────────────────

function unknownListGate(listKey: string | undefined, choice: string): GateResult {
  if (!listKey || findRouteByKey(listKey)) return null;
  return {
    gate: 'unknown list key',
    question: formatClarifyAsk({
      facts: [`I don't recognize the list "${listKey}".`],
      choice,
      hint: `Valid lists: ${getRoutes().map((r) => r.key).join(', ')}`,
    }),
  };
}

function assigneeGates(assigneeName: string, listKey: string | undefined): GateResult {
  const member = findMemberByName(assigneeName);
  if (!member) {
    return {
      gate: 'assignee not in team roster',
      question: formatClarifyAsk({
        facts: [`I don't recognize "${assigneeName}" as a team member.`],
        choice: 'Who should this be assigned to?',
      }),
    };
  }

  const route = listKey ? findRouteByKey(listKey) : undefined;
  const valid = route ? getEffectiveValidAssignees(route) : [];
  // An empty valid list means "unrestricted", not "nobody" — holding everything on an unconfigured
  // route would make adding a new list block the whole board.
  if (valid.length > 0 && !valid.includes(member.name)) {
    return {
      gate: 'assignee not valid for list',
      question: formatClarifyAsk({
        facts: [`${member.name} doesn't usually own tasks on ${listKey}.`, `People who do: ${valid.join(', ')}.`],
        choice: `Confirm ${member.name} anyway, or tell me who should own it?`,
      }),
    };
  }
  return null;
}

/**
 * Routing correctness for newly-created work: the list must be known, the assignee must be a real
 * person, and that person must be plausible for that list.
 */
export function routingGate(item: CategorizationItem): GateResult {
  if (item.category !== 'NEW_TASK' && item.category !== 'SUBTASK') return null;
  if (!item.list) return null;

  const listCheck = unknownListGate(item.list, 'Which list should this go on?');
  if (listCheck) return listCheck;

  if (!item.assignee) return null; // a missing assignee is the gap-fill gate's job, not this one
  return assigneeGates(item.assignee, item.list);
}

// ── Learnable classification ─────────────────────────────────────────────────

export type LearnableKind = 'valid_assignee' | 'note';

/**
 * How a resolved hold is remembered. Exactly one gate maps to a typed, mechanically-enforced rule;
 * **everything else becomes a free-form note** fed back into later prompts.
 *
 * That asymmetry is deliberate. Enumerating learnable gates would mean every unanticipated
 * correction is forgotten, and the unanticipated ones are most of them.
 */
export function classifyLearnableGate(gate: string): LearnableKind {
  return gate === 'assignee not valid for list' ? 'valid_assignee' : 'note';
}

/** Content-aware upgrade at answer time — the gate may be generic while the answer states a rule. */
export function classifyLearnableFromContent(gate: string, answer?: string, hasAssigneeRoutingFact?: boolean): LearnableKind {
  if (classifyLearnableGate(gate) === 'valid_assignee') return 'valid_assignee';
  if (hasAssigneeRoutingFact) return 'valid_assignee';
  if (answer) {
    const t = answer.toLowerCase();
    if (/\bvalid\s+assignees?\b/.test(t) || /\bmake\b[^.]*\bvalid\s+assignees?\b/.test(t) || /\badd\b[^.]*\bto\b[^.]*\b(list|project)\b/.test(t)) {
      return 'valid_assignee';
    }
  }
  return 'note';
}

// ── Cross-item consistency ───────────────────────────────────────────────────

/** Run once over the surviving clean set, after every per-item gate. */
export function crossItemGate(
  items: CategorizationItem[],
  snap: Map<string, BoardTask>
): { clean: CategorizationItem[]; held: HeldItem[]; flags: ContractFlag[] } {
  const held: HeldItem[] = [];
  const flags: ContractFlag[] = [];
  const drop = new Set<number>();

  // (a) Two or more UPDATEs on one card → one comment, not N.
  const updatesById = new Map<string, CategorizationItem[]>();
  for (const it of items) {
    if (it.category === 'UPDATE' && it.existingTaskId) {
      const bucket = updatesById.get(it.existingTaskId) ?? [];
      bucket.push(it);
      updatesById.set(it.existingTaskId, bucket);
    }
  }
  for (const [, group] of updatesById) {
    if (group.length < 2) continue;
    const primary = group[0]!;
    primary.finalDesc = group.map((g) => g.finalDesc).filter(Boolean).join(' ');
    for (const g of group.slice(1)) drop.add(g.item);
    flags.push({
      kind: 'updates_merged',
      items: group.map((g) => g.item),
      note: `Merged ${group.length} UPDATEs on ${primary.existingTaskId} into one comment (item ${primary.item}).`,
    });
  }

  // (b) More than two subtasks under one parent — worth a look, not worth blocking.
  const subByParent = new Map<string, number[]>();
  for (const it of items) {
    if (it.category === 'SUBTASK' && it.parentTaskId && !drop.has(it.item)) {
      const bucket = subByParent.get(it.parentTaskId) ?? [];
      bucket.push(it.item);
      subByParent.set(it.parentTaskId, bucket);
    }
  }
  for (const [parent, nums] of subByParent) {
    if (nums.length > 2) {
      flags.push({ kind: 'over_subtask', items: nums, note: `${nums.length} subtasks proposed under parent ${parent} — review for over-subtasking.` });
    }
  }

  // (c) The whole-board duplicate backstop, and it HOLDS.
  //
  // Per-item categorization only ever compares an item against a handful of candidate cards; anything
  // the candidate selector missed is never compared at all. Re-scoring every NEW_TASK against the
  // ENTIRE board is what catches those.
  //
  // This deserves its own note because the version this was extracted from only raised a *flag* — and
  // flags reach a log, never a human and never the write path. So a duplicate this gate positively
  // identified got created anyway, every single time. The flag is kept alongside the hold because it
  // carries the similarity score, which is what you need to tune the floor.
  for (const it of items) {
    if (it.category !== 'NEW_TASK' || drop.has(it.item)) continue;

    let best = { id: '', title: '', sim: 0 };
    for (const t of snap.values()) {
      const sim = jaccard(it.title, t.title);
      if (sim > best.sim) best = { id: t.id, title: t.title, sim };
    }

    if (best.sim >= MISSED_DUP_FLOOR && !isKnownNotDuplicate(it.title, best.id)) {
      flags.push({
        kind: 'missed_dup',
        items: [it.item],
        note: `NEW_TASK "${it.title}" closely matches open card ${best.id} "${best.title}" (sim ${best.sim.toFixed(2)}) — HELD for a human.`,
      });
      held.push({
        item: it.item,
        title: it.title,
        category: it.category,
        gate: 'possible missed duplicate',
        question: formatClarifyAsk({
          facts: [describeMatchOrLink(snap, best.id)],
          choice: 'Create this as a new task anyway, or skip it — that card already covers it?',
        }),
        originalItem: it,
      });
      drop.add(it.item);
    }
  }

  // (d) A link from a card to itself is never what was meant.
  for (const it of items) {
    if (it.category === 'RELATE' && it.linkTaskId1 && it.linkTaskId1 === it.linkTaskId2) {
      held.push({
        item: it.item,
        title: it.title,
        category: it.category,
        gate: 'RELATE self-link',
        question: formatClarifyAsk({
          facts: [`This links a task to itself (${taskUrl(it.linkTaskId1)}).`],
          choice: 'What are the two distinct task ids to link?',
        }),
        originalItem: it,
      });
      drop.add(it.item);
    }
  }

  // (e) Two near-identical NEW_TASKs on the same list in one run — the consolidation backstop.
  const news = items.filter((it) => it.category === 'NEW_TASK' && !drop.has(it.item));
  for (let i = 0; i < news.length; i++) {
    for (let j = i + 1; j < news.length; j++) {
      const a = news[i]!;
      const b = news[j]!;
      if (a.list && a.list === b.list && jaccard(a.title, b.title) >= NEAR_DUP_PAIR_FLOOR) {
        flags.push({
          kind: 'near_dup_pair',
          items: [a.item, b.item],
          note: `NEW_TASK items ${a.item} & ${b.item} are near-identical in ${a.list} — possible intra-run duplicate.`,
        });
      }
    }
  }

  const heldNums = new Set(held.map((h) => h.item));
  return { clean: items.filter((it) => !drop.has(it.item) && !heldNums.has(it.item)), held, flags };
}

export type { ClarifyAsk };
