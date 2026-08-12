/**
 * Pass 2b — the blind, disconfirming re-verification prompt.
 *
 * **This is the headline of the whole system, and its entire value rests on one property: this
 * prompt is built from the Pass-1 inventory item, never from Pass 2a's manifest.** The second read
 * cannot see the first read's answer, so agreement between them is evidence rather than an echo.
 * A test asserts the rendered prompt contains no 2a-derived field, and it should fail loudly if
 * someone ever "helpfully" threads the manifest item through here.
 *
 * The other deliberate choice is the *disconfirming* bias: the pass is told to assume the item is
 * NOT new and to go hunting for a match. A second read told to "check the work" tends to agree; a
 * second read told to refute finds things.
 *
 * The six worked examples below are generic — fixture personas, synthetic card ids, an invented
 * client. They are the *reasoning* of the production set with none of its content, and each one
 * exists to teach a different verdict field, so dropping any of them costs a specific behaviour.
 * They stay sentinel-delimited (`══════` + `WORKED EXAMPLES`) so they remain locatable by grep and
 * replaceable wholesale, and so `scaffolding.test.ts` can assert the block is still there.
 */
import { learnedFactsBlock } from '../../state/corrections';
import { roleRosterBlock } from '../../registry/roleProfiles';
import { formatTier2EvidenceBlock } from '../evidence/tier2Prefetch';
import type { EnrichedInventoryItem } from '../types';
import { WORTH_A_CARD_RUBRIC } from '../worthACardRubric';

export type ContractCheckPromptOptions = {
  participantLine?: string;
  tier2Evidence?: string;
  /** Source confidence in [0,1]; below LOW_PROVENANCE_NOTE it is surfaced to the read. */
  provenance?: number | null;
};

const LOW_PROVENANCE_NOTE = 0.75;

export function buildContractCheckerPrompt(
  item: EnrichedInventoryItem,
  boardSnapshot: string,
  sourceSummary: string,
  sourceText: string,
  opts: ContractCheckPromptOptions = {}
): string {
  const tier2Block = formatTier2EvidenceBlock(opts.tier2Evidence);
  const roster = roleRosterBlock();

  const provNote =
    typeof opts.provenance === 'number' && opts.provenance < LOW_PROVENANCE_NOTE
      ? `SOURCE_CONFIDENCE: ${opts.provenance.toFixed(2)} (LOW — the source lines this item was extracted from are low-confidence and may be mis-transcribed; weigh WORTH_A_CARD accordingly)`
      : null;

  // Built from the INVENTORY item only. Adding anything 2a produced here destroys the blindness.
  const itemBlock = [
    `ITEM: ${item.number}`,
    `TITLE: ${item.title}`,
    `DESC: ${item.desc || '(none)'}`,
    `TIMESTAMP: ${item.timestamp || '(none)'}`,
    `POSSIBLE_MATCH_HINT: ${item.possibleMatchHint || '(none)'}`,
    ...(provNote ? [provNote] : []),
  ].join('\n');

  return [
    '══════════════════════════════════════════════════════════════════════',
    'INDEPENDENT VERIFICATION PASS — READ-ONLY',
    '══════════════════════════════════════════════════════════════════════',
    'YOUR ONLY OUTPUT: one VERDICT block for the single item at the bottom. No writes, no commentary.',
    '',
    'A first agent already categorized this item. You do NOT see its decision — re-derive the',
    'category YOURSELF, from scratch, with a DISCONFIRMING bias. Your job is to catch a wrong "NEW".',
    '',
    'DISCONFIRMING PROTOCOL (do this, in order):',
    '1. ASSUME this item is NOT new. Actively hunt the FULL BOARD SNAPSHOT for an existing card it could',
    '   match — same deliverable (DUPLICATE), a broader card that contains it (SUBTASK), or a card it',
    '   reports progress on (UPDATE). Use POSSIBLE_MATCH_HINT only as a starting point; scan widely.',
    '2. For any candidate, use the comment/activity history to confirm or REFUTE the match, and cite it',
    '   in RATIONALE. If a "TIER-2 EVIDENCE" block is provided with the item below, that IS your',
    '   comment-history read for the cards it lists. If a candidate is not covered there, you have no',
    '   evidence for it — say so rather than assuming.',
    '3. Only conclude NEW_TASK after you have looked for a match and found none. "I could not find a match"',
    '   is a valid, expected outcome — but you must have actually looked.',
    '',
    'Categories (pick exactly one): NEW_TASK · DUPLICATE · SUBTASK (containment: closes when the parent',
    'closes — keyword overlap is NOT containment) · UPDATE (existing card + genuinely new progress, not',
    'already in its activity log) · RELATE (two existing cards explicitly tied together). No numeric score.',
    '',
    'SECOND, INDEPENDENT JUDGEMENT — is this worth a card? (a SOURCE_CONFIDENCE note below, if present,',
    'flags a low-confidence line → weigh it toward unsure):',
    WORTH_A_CARD_RUBRIC,
    '',
    'THIRD, INDEPENDENT CHECK — GROUNDING (DETECTION only — you do NOT rewrite anything here):',
    're-read the SOURCE below (the ONLY source for what this item IS) and check every specific',
    "term/name/claim in the item's TITLE + DESC against it.",
    '  • GROUNDED: yes — every key term traces to something actually said in the source.',
    '  • GROUNDED: no — a specific detail (a name, a category/label, a number, a claim) does NOT appear',
    '    in the source at all. This commonly happens when a SIMILAR-looking board card exists and its',
    '    wording bled into this item — the board is for MATCHING only, never a source of content.',
    '    → DO NOT rewrite, correct, or output any replacement wording — that is not your job, and a',
    '      "corrected" rewrite is itself a model output that can also be wrong. Your ONLY job is to answer',
    '      one more question: does the existing card this item matches/updates (if any) still genuinely',
    '      cover the REAL (source) topic? Answer CARD_STILL_MATCHES:',
    '      yes (still the same deliverable, despite the ungrounded detail) / no (what the source',
    '      actually describes is NOT what that card is about — the ungrounded wording was masking a wrong',
    '      match) / n/a (this item has no existing-card match to recheck, e.g. a plain NEW_TASK).',
    '      Only a "no" here escalates to a human — framed as "is this really that card, or unrelated/new',
    '      work?" (a card-identity question), never as a wording check. "yes"/"n/a" → no action at all;',
    '      the item proceeds with its wording UNCHANGED (grounding is an earlier pass\'s job to get right,',
    '      and this check exists only to catch a wrong CARD match hiding behind ungrounded wording).',
    '',
    'FOURTH, INDEPENDENT CHECK — ROUTING (NEW_TASK / SUBTASK only — "ask, don\'t guess" for an unfamiliar',
    'client/entity or a genuine tie between lists):',
    '  • ROUTING_OK: yes — the deliverable clearly belongs to a known/recognizable client, product or',
    '    internal concern.',
    '  • ROUTING_OK: no — the item names a client/product/entity you cannot place from the roster below or',
    '    the board (never referenced before, no clarifying context), OR 2+ specific lists are each plausible',
    '    with nothing in the source deciding between them. Name the unclear entity / competing lists',
    '    in RATIONALE. For DUPLICATE/UPDATE/RELATE (identity already resolved to an existing card) or when',
    '    routing is simply not applicable, answer n/a.',
    '',
    '══════════════════════════════════════════════════════════════════════',
    'WORKED EXAMPLES (the payoff of disconfirming — your board/items differ; apply the reasoning, do not copy)',
    '══════════════════════════════════════════════════════════════════════',
    '',
    '— Disconfirming CAUGHT a hidden match (title looked new, but a match existed):',
    '  Item "Set up staging server on the VPS host". Hunting the snapshot surfaced "VPS host setup" (t-def4).',
    '  Comment history on t-def4 shows the staging box is already being provisioned → same deliverable.',
    '  VERDICT_CATEGORY: DUPLICATE',
    '  MATCH_TASK_ID: t-def4',
    '  WORTH_A_CARD: real_task',
    '  GROUNDED: yes',
    '  ROUTING_OK: n/a',
    '  RATIONALE: [Tier-2: task-comments on t-def4] Same deliverable, already in progress — not new.',
    '',
    '— Genuinely NEW after looking (closest card is a DIFFERENT deliverable — containment fails):',
    '  Item "Add a font dropdown to the editor UI". Closest card "Editor — test & refine" (t-abc2).',
    '  Comment history on t-abc2 shows it covers testing existing behaviour; a font dropdown would NOT',
    '  close when that card closes → containment fails → NEW after an honest look.',
    '  VERDICT_CATEGORY: NEW_TASK',
    '  MATCH_TASK_ID: (none)',
    '  WORTH_A_CARD: real_task',
    '  GROUNDED: yes',
    '  ROUTING_OK: yes',
    '  RATIONALE: [Tier-2: task-comments on t-abc2] Distinct feature, not contained by the test card → NEW.',
    '',
    '— NOT worth a card (a vague relay with no deliverable — do not create; a human will confirm):',
    '  Item "Address the two things X mentioned". No named deliverable, no artifact, speaker calls them minor.',
    '  VERDICT_CATEGORY: NEW_TASK',
    '  MATCH_TASK_ID: (none)',
    '  WORTH_A_CARD: not_a_task',
    '  GROUNDED: yes',
    '  ROUTING_OK: yes',
    '  RATIONALE: No concrete deliverable or owner; a PM would not open a board card for an unspecified aside.',
    '',
    '— NOT grounded, NO ACTION (a term bled in, but no existing-card match to worry about — proceed',
    '  as-is, no human involved, wording is NOT rewritten here):',
    '  Item title says "Check the certification activation status". The source only discusses "has the plan',
    '  been activated — 7 days, public holiday" — the word "certification" is never said, and no existing',
    '  card is being matched (this is a standalone NEW_TASK).',
    '  VERDICT_CATEGORY: NEW_TASK',
    '  MATCH_TASK_ID: (none)',
    '  WORTH_A_CARD: real_task',
    '  GROUNDED: no',
    '  CARD_STILL_MATCHES: n/a',
    '  ROUTING_OK: yes',
    '  RATIONALE: "certification" is not said anywhere in this item\'s source window — the real topic is',
    '  plan/subscription activation. No existing card to re-check, so this is not escalated; grounding',
    '  is an earlier pass\'s job, not something this check rewrites.',
    '',
    '— NOT grounded, ESCALATES (the ungrounded wording was masking a WRONG card match — this becomes a',
    '  card-identity question, never a wording question):',
    '  Same ungrounded title, but the first read matched it to existing card t-c3n8 "Complete certification',
    '  exam study and take the exam" as an UPDATE. What the source actually describes (plan/subscription',
    '  activation, 7 days, public holiday) is a DIFFERENT thing entirely from that card (an exam, not a',
    '  subscription activation) — the match itself is wrong, not just the wording.',
    '  VERDICT_CATEGORY: UPDATE',
    '  MATCH_TASK_ID: t-c3n8',
    '  WORTH_A_CARD: real_task',
    '  GROUNDED: no',
    '  CARD_STILL_MATCHES: no',
    '  ROUTING_OK: yes',
    '  RATIONALE: What the source describes (plan/subscription activation) is NOT what t-c3n8 covers',
    '  (a certification EXAM) — the ungrounded wording was masking a wrong card match, not just a typo.',
    '',
    '— NOT routing-confident (unrecognized client/entity, nothing in the role profiles or board matches):',
    '  Item "Fix a UI bug for the Northwind client website". "Northwind" appears nowhere in the role',
    '  profiles, the board, or LEARNED FACTS, and the source gives no further context on what it is.',
    '  VERDICT_CATEGORY: NEW_TASK',
    '  MATCH_TASK_ID: (none)',
    '  WORTH_A_CARD: real_task',
    '  GROUNDED: yes',
    '  ROUTING_OK: no',
    '  RATIONALE: "Northwind" is an unrecognized client/entity — no canonical list or board context',
    '  identifies it; routing it (even to a catch-all) would be a guess.',
    '',
    '══════════════════════════════════════════════════════════════════════',
    'OUTPUT — emit EXACTLY this block, nothing else',
    '══════════════════════════════════════════════════════════════════════',
    'VERDICT_CATEGORY: <NEW_TASK | DUPLICATE | SUBTASK | UPDATE | RELATE>',
    'MATCH_TASK_ID: <board id(s) — the existing card for DUPLICATE/UPDATE, the parent for SUBTASK, both',
    '  ids (comma-separated) for RELATE, or (none) for NEW_TASK>',
    'WORTH_A_CARD: <real_task | not_a_task | unsure>',
    'GROUNDED: <yes | no>',
    'CARD_STILL_MATCHES: <only if GROUNDED:no — yes | no | n/a; else omit>',
    'ROUTING_OK: <yes | no | n/a>',
    'RATIONALE: <one short paragraph; for DUPLICATE/SUBTASK/UPDATE cite the comment history you read; if',
    '  not_a_task/unsure/GROUNDED:no/ROUTING_OK:no, say briefly why>',
    'FORBIDDEN: any text outside the block; tool-call narration.',
    '',
    // The ROUTING_OK check above asks whether an entity can be placed "from the roster below". Until
    // Phase 4 that sentence pointed at nothing — the prompt promised context it never supplied.
    ...(roster.length ? [...roster, ''] : []),
    ...(opts.participantLine ? [`PARTICIPANTS (speaker mapping only): ${opts.participantLine}`, ''] : []),
    // Placed immediately BEFORE the board snapshot. This pass's whole job is "assume this is NOT new,
    // hunt the board", so it must know the team's taught facts BEFORE it scans — otherwise it hunts
    // for a garbled token, finds nothing, and concludes NEW. Empty until something is taught.
    ...learnedFactsBlock(30),
    '══════════════════════════════════════════════════════════════════════',
    'FULL BOARD SNAPSHOT — all open tasks + subtasks (scan here)',
    'Format: task_id | title | list | assignee | status | description',
    '══════════════════════════════════════════════════════════════════════',
    boardSnapshot || '(board snapshot unavailable)',
    '',
    '--- SOURCE SUMMARY ---',
    sourceSummary || '(none)',
    ...(sourceText ? ['', '--- FULL SOURCE ---', sourceText, '--- END SOURCE ---'] : []),
    '',
    '══════════════════════════════════════════════════════════════════════',
    'THE SINGLE ITEM TO RE-VERIFY (output one VERDICT block)',
    '══════════════════════════════════════════════════════════════════════',
    itemBlock,
    ...(tier2Block ? ['', tier2Block] : []),
  ].join('\n');
}
