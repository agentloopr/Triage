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
 * **What it is NOT for.** It does not categorize, route, or decide anything the gates decide. Its
 * output is advisory and is merged field-by-field by the caller, never wholesale — see
 * `applyEnrichment`. An agent that could rewrite a category would be an agent that can defeat every
 * gate in the repo by talking.
 */
import { getRoleProfile } from '../registry/roleProfiles';
import { type RoleArchetype, getMembers } from '../registry/opsRegistry';
import { readRoleState } from '../state/roleState';
import { makeToolLoopRunner } from '../pipeline/toolLoop';
import type { ModelClient } from '../providers';
import type { TrackerAdapter } from '../trackers';

/** What a role agent is allowed to change. Deliberately two fields, both prose. */
export interface RoleEnrichment {
  /** A fuller description, or undefined to keep what the pipeline produced. */
  finalDesc?: string;
  /** Set when the agent believes the named owner is wrong. Advisory — the routing gate still decides. */
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
  'Reply in exactly this shape, no preamble:',
  '',
  'NOTE: <one line — what you checked and what you concluded>',
  'DESC: <the improved description, or the word KEEP to leave it unchanged>',
  'OWNERSHIP: <OK, or one line explaining why this looks like someone else\'s work>',
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

  if (state.context.trim()) lines.push(`CONTEXT ABOUT THIS ROLE RIGHT NOW: ${state.context.trim()}`, '');
  if (state.openItems.length) {
    lines.push(
      `ALREADY OPEN FOR ${input.owner}:`,
      ...state.openItems.map((i) => `  - ${i.title}${i.taskId ? ` (${i.taskId})` : ''}`),
      ''
    );
  }

  lines.push(
    'THE ITEM:',
    `  TITLE: ${input.title}`,
    `  DESC: ${input.desc || '(none)'}`,
    ...(input.taskId ? [`  EXISTING CARD: ${input.taskId}`] : []),
    '',
    'You have read-only tools. Use them if — and only if — the description is too thin to act on or',
    'you doubt this is really this person\'s work. Reading nothing is a fine answer for a clear item.',
    '',
    'You may NOT decide whether this is a new task, a duplicate, a subtask or an update. That is',
    'already decided and is not yours to revisit. Improve how it reads; do not change what it is.',
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

export function parseRoleReply(raw: string): RoleEnrichment | undefined {
  const note = /^NOTE:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  if (!note) return undefined; // no NOTE line means the contract was not followed; keep what we had

  const ownership = /^OWNERSHIP:\s*(.+)$/m.exec(raw)?.[1]?.trim();

  // DESC runs to the OWNERSHIP line or to the end, and may be several lines. Cutting the string
  // first is plainer than a lookahead that has to express "or end of input" — which JS regex does
  // not do the way Perl does, and which is where the first attempt at this was wrong.
  const ownershipAt = raw.search(/^OWNERSHIP:/m);
  const descRegion = ownershipAt === -1 ? raw : raw.slice(0, ownershipAt);
  const desc = /^DESC:\s*([\s\S]*)$/m.exec(descRegion)?.[1]?.trim();

  return {
    note,
    // "KEEP" is the explicit no-op. Treating an absent or empty DESC as "clear the description"
    // would let a vague reply delete the only text on a card.
    ...(desc && desc.toUpperCase() !== 'KEEP' ? { finalDesc: desc } : {}),
    ...(ownership && ownership.toUpperCase() !== 'OK' ? { ownershipDoubt: ownership } : {}),
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
