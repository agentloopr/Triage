/**
 * Role agents — one per archetype, PRD §5.
 *
 * A role agent is the loop from `toolLoop.ts` given three things that already exist:
 *
 *   its **profile**  (`config/roles/<role>.md`)        → who it is and what it owns
 *   its **state**    (`config/roles/state/<role>.json`) → what it already has open, plus human context
 *   its **tools**    (`readOnlyTracker`)                → what it may look at
 *
 * **A role agent cannot write, structurally.** Not because the prompt asks it not to — because
 * `readOnlyTracker` refuses every `apply()` and there is no code path from here to the tracker's
 * write methods. Prompt text is a request; a wrapper is a guarantee. That distinction is the whole
 * reason this is safe to point at a real board.
 *
 * **What it is for.** The deterministic pipeline decides *what* an item is; a role agent decides how
 * that item reads to the person who owns it — enriching a thin description from card history,
 * confirming the work is really theirs, and phrasing the update the way that role phrases updates
 * (the profile's `Update style` section, which until now was text nobody executed).
 *
 * **What it may decide, and what decides it.** A role agent may *propose* a different category, list
 * or assignee. It does not get to apply one: proposals are copied field-by-field onto a candidate
 * item and the full deterministic gate set is re-run over it, so a proposal the gates cannot confirm
 * becomes a human hold rather than a write. Merging a reply wholesale — or trusting a proposal
 * unchecked — would be an agent that defeats every gate in the repo by talking.
 *
 * That is production's shape, where the board agent proposes and one script enforces the guards, and
 * it is what PRD §5's "authority to write" actually describes. The earlier version of this file could
 * only rewrite one prose field, which was safe and was not orchestration.
 */
import { getRoleProfile } from '../registry/roleProfiles';
import { type RoleArchetype, getMembers } from '../registry/opsRegistry';
import { readRoleState } from '../state/roleState';
import { screenedPrimary } from '../utils/security';
import { isMeetingCategory, type MeetingCategory } from '../pipeline/parsing/categorizationManifest';
import { makeToolLoopRunner } from '../pipeline/toolLoop';
import type { ModelClient } from '../providers';
import type { TrackerAdapter } from '../trackers';

/**
 * What a role agent **proposes**. Nothing here is applied as stated: every field is copied by name
 * onto a candidate item and the whole deterministic gate set is re-run over it. A proposal the gates
 * reject becomes a human hold, never a write — see `applyProposals` in `pipeline/run.ts`.
 *
 * That is the shape production has, where the board agent proposes and one script enforces the
 * guards. An agent that could only rewrite prose was not an orchestrator; an agent that could write
 * directly would put a model in the write path. Proposing into the gates is neither.
 */
export interface RoleEnrichment {
  /** A fuller description, or undefined to keep what the pipeline produced. */
  finalDesc?: string;
  /** A different category. Re-gated: an unsupported one is refused, and the item holds. */
  proposedCategory?: MeetingCategory;
  /** A different list key. Re-gated by `routingGate` — an unknown key holds. */
  proposedList?: string;
  /** A different owner. Re-gated — off-roster, or not valid for the list, holds. */
  proposedAssignee?: string;
  /**
   * "Wrong owner, and I do not know whose it is." Becomes an `uncertainFields` entry on `assignee`,
   * which `uncertainFieldsGate` turns into a hold with that reason as the question.
   *
   * This used to reach only the run summary and stop nothing — an agent noticing the wrong owner,
   * and a card landing on that person anyway unless a human happened to read the log.
   */
  ownershipDoubt?: string;
  /** Always present: what it looked at and why, for the trace. */
  note: string;
}

export interface RoleAgentInput {
  role: RoleArchetype;
  /** The person this item is routed to, by canonical name. */
  owner: string;
  title: string;
  desc: string;
  /** Set for UPDATE/SUBTASK/DUPLICATE — the card this concerns. */
  taskId?: string;
}

export interface RoleAgentDeps {
  model: ModelClient;
  tracker: TrackerAdapter;
  maxIterations?: number;
  onEvent?: (e: { kind: 'tool'; name: string; args: Record<string, unknown> } | { kind: 'cap-hit'; iterations: number }) => void;
}

const OUTPUT_CONTRACT = [
  'Reply in exactly this shape, no preamble. Use the word KEEP for anything you would not change:',
  '',
  'NOTE: <one line — what you checked and what you concluded>',
  'DESC: <the improved description, or KEEP>',
  'CATEGORY: <KEEP, or one of NEW_TASK | DUPLICATE | SUBTASK | UPDATE | RELATE>',
  'LIST: <KEEP, or the list key this work belongs on>',
  'ASSIGNEE: <KEEP, or the name of the person who should own this>',
  "OWNERSHIP: <OK, or one line saying why this is not this person's work when you cannot name who>",
].join('\n');

export function buildRoleAgentPrompt(input: RoleAgentInput): string {
  const profile = getRoleProfile(input.role);
  const state = readRoleState(input.role);

  const lines: string[] = [
    `You are the ${profile?.title ?? input.role} on this team. You are reviewing one item of work`,
    `about to be recorded on the board for ${input.owner}.`,
    '',
  ];

  if (profile) {
    lines.push(`WHAT YOUR ROLE OWNS: ${profile.owns}`, `WHAT YOUR ROLE WATCHES FOR: ${profile.watchesFor}`, `HOW YOUR ROLE PHRASES AN UPDATE: ${profile.updateStyle}`, '');
  }

  // Everything below traces back to something a person wrote — the item came from a transcript or a
  // card, and role state is a file a human maintains by hand plus item titles the pipeline wrote
  // there from the source. The role profile above does not: it ships in this repo.
  //
  // This was the last unscreened path into a model prompt, and it is easy to miss because a role
  // agent reads like an internal component talking to itself. The state file especially looks like
  // configuration rather than input.
  if (state.context.trim()) {
    lines.push(`CONTEXT ABOUT THIS ROLE RIGHT NOW: ${screenedPrimary(state.context.trim(), 'role-state-context')}`, '');
  }
  if (state.openItems.length) {
    lines.push(
      `ALREADY OPEN FOR ${input.owner}:`,
      ...state.openItems.map(
        (i) => `  - ${screenedPrimary(i.title, 'role-state-item')}${i.taskId ? ` (${i.taskId})` : ''}`
      ),
      ''
    );
  }

  lines.push(
    'THE ITEM:',
    `  TITLE: ${screenedPrimary(input.title, 'role-item-title')}`,
    `  DESC: ${input.desc ? screenedPrimary(input.desc, 'role-item-desc') : '(none)'}`,
    ...(input.taskId ? [`  EXISTING CARD: ${input.taskId}`] : []),
    '',
    'You have read-only tools. Use them if — and only if — the description is too thin to act on or',
    'you doubt this is really this person\'s work. Reading nothing is a fine answer for a clear item.',
    '',
    'The pipeline has already categorised, routed and assigned this item. You may PROPOSE a different',
    'category, list or assignee where you have a specific reason — but understand what a proposal is:',
    'it is re-checked by the same rules the original answer passed, and a proposal those rules cannot',
    'confirm stops the item and asks a human instead of writing it. So propose when you know something',
    'the pipeline could not, and answer KEEP when you do not. KEEP is the right answer most of the time,',
    'and a speculative change costs someone a question.',
    '',
    OUTPUT_CONTRACT
  );

  return lines.join('\n');
}

/**
 * Run one role agent.
 *
 * Fails open, exactly like the profiles it is built from: an agent that errors, times out, or
 * replies unparseably returns `undefined` and the caller keeps the pipeline's own answer. Enrichment
 * is a nicety; the run must not depend on it.
 */
export async function runRoleAgent(input: RoleAgentInput, deps: RoleAgentDeps): Promise<RoleEnrichment | undefined> {
  const run = makeToolLoopRunner({
    model: deps.model,
    tracker: deps.tracker, // wrapped in readOnlyTracker inside the loop
    ...(deps.maxIterations != null ? { maxIterations: deps.maxIterations } : {}),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
  });

  try {
    const raw = await run(buildRoleAgentPrompt(input), `role/${input.role}/item-${slug(input.title)}`);
    return parseRoleReply(raw);
  } catch {
    return undefined;
  }
}

const LABEL_RE = /^(NOTE|DESC|CATEGORY|LIST|ASSIGNEE|OWNERSHIP):\s*(.*)$/;

/**
 * Line-based rather than regex-sliced.
 *
 * The previous version cut DESC at the `OWNERSHIP:` line, which was correct while OWNERSHIP was the
 * only label after it. With three more labels in between, "cut at the next known label" is the rule,
 * and expressing that by walking lines is both shorter and immune to the ordering of the reply —
 * whereas a second `search()` for whichever label happens to come next is the kind of thing that
 * works until a model emits them in a different order.
 */
export function parseRoleReply(raw: string): RoleEnrichment | undefined {
  const fields = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current) fields.set(current, buf.join('\n').trim());
    buf = [];
  };

  for (const line of raw.split('\n')) {
    const m = LABEL_RE.exec(line);
    if (m) {
      flush();
      current = m[1]!;
      buf.push(m[2]!);
    } else if (current) {
      buf.push(line);
    }
  }
  flush();

  const note = fields.get('NOTE');
  if (!note) return undefined; // no NOTE line means the contract was not followed; keep what we had

  /** "KEEP" is the explicit no-op, and so is an absent or empty value. */
  const changed = (label: string, noop = 'KEEP'): string | undefined => {
    const v = fields.get(label)?.trim();
    return v && v.toUpperCase() !== noop ? v : undefined;
  };

  const category = changed('CATEGORY');
  const ownership = changed('OWNERSHIP', 'OK');

  return {
    note,
    // Treating an absent or empty DESC as "clear the description" would let a vague reply delete the
    // only text on a card.
    ...(changed('DESC') ? { finalDesc: changed('DESC')! } : {}),
    // An unrecognised category is dropped rather than passed on: the manifest grammar is a closed
    // set, and inventing a sixth value downstream would fail somewhere less obvious than here.
    ...(category && isMeetingCategory(category) ? { proposedCategory: category } : {}),
    ...(changed('LIST') ? { proposedList: changed('LIST')! } : {}),
    ...(changed('ASSIGNEE') ? { proposedAssignee: changed('ASSIGNEE')! } : {}),
    ...(ownership ? { ownershipDoubt: ownership } : {}),
  };
}

/** Which archetype a canonical member name belongs to, or undefined if they are not on the roster. */
export function roleOf(name: string): RoleArchetype | undefined {
  const target = name.trim().toLowerCase();
  return getMembers().find((m) => m.name.toLowerCase() === target)?.role;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
}
