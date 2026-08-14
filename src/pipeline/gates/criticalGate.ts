/**
 * The critical-task approval gate — a hold that does not mean "I am unsure".
 *
 * Every other gate in this repo fires because something is missing or two reads disagree. This one
 * fires when the pipeline is **completely confident** and the write is high-stakes anyway. Those are
 * different questions, and a pipeline that only asks the first one will rotate a production
 * credential without hesitating, because nothing about that item is ambiguous.
 *
 * Ported from the production system, where it runs before the board agent is invoked so the board
 * never auto-writes a critical task. Here it runs first among the per-item gates, for the same
 * reason: every gate produces a hold either way, so ordering only decides which question a human
 * sees — and for a credential rotation, "this touches credentials, confirm" is the right question,
 * not "I need an assignee for this".
 *
 * ── THE PATTERNS ARE NOT CONFIGURABLE, AND THAT IS THE FEATURE ────────────────────────────────
 *
 * `CRITICAL_RULES` is a compiled constant. No environment variable, config value, correction,
 * registry entry, prompt or model output can add to it, remove from it, or reorder it. The only
 * thing that is configurable is the boolean that turns the gate on.
 *
 * This matters because of what sits upstream. An agent may propose a category, a list, an assignee
 * and a description; a source document is attacker-controlled text in any deployment that ingests
 * email or public issues. If the rule table could be widened or narrowed by anything reaching the
 * pipeline through those paths, then the review step could be talked out of reviewing — and the
 * most valuable thing to talk it out of is exactly the write this gate exists to catch.
 *
 * So the gate's guarantee is not "these patterns are complete". It is: **whatever these patterns
 * catch, no input can stop them catching it.** `criticalGate.test.ts` asserts that directly.
 *
 * Coverage is deliberately narrow. The patterns require fairly explicit phrasing so that ordinary
 * work is not held — "rotate the tyres on the van" and "deploy the staging banner" must both pass.
 * A gate that holds a tenth of a normal week teaches people to approve without reading, which is
 * worse than no gate.
 *
 * ── TWO DEFECTS THE PORT FOUND IN THE ORIGINAL TABLE ──────────────────────────────────────────
 *
 * Both were live in production and are fixed here, because "port it verbatim" would have meant
 * shipping known-wrong patterns for the sake of fidelity.
 *
 *   1. **A false negative on the most ordinary phrasing there is.** `deploy(ing)? (to )?prod` only
 *      matched when the verb sat directly beside the target, so "Deploy to production" held and
 *      "Deploy the billing service to production tonight" did not. The commonest way an engineer
 *      writes the riskiest item in the table was the way that slipped through.
 *   2. **A false positive on counting.** `card number` matched "card number of items in the
 *      backlog is wrong on the summary" — English reuses "number of X" for quantity, and a gate
 *      that fires on sentences like that trains people to click approve without reading.
 *
 * Neither was found by review. Both were found by writing down what the gate must NOT catch and
 * running it, which is the half of a rule table that usually goes untested.
 */

import type { CategorizationItem } from '../parsing/categorizationManifest';
import { formatClarifyAsk } from './clarify';
import type { GateResult } from './contractGates';

export type CriticalCategory = 'credentials' | 'client-pii' | 'production-deploy' | 'client-comms';

type CriticalRule = { category: CriticalCategory; label: string; re: RegExp };

/**
 * High-precision patterns — tuned to require fairly explicit phrasing so legitimate everyday tasks
 * are not held. Add categories here, in compiled code, and never from anything a request can reach.
 */
const CRITICAL_RULES: readonly Readonly<CriticalRule>[] = Object.freeze([
  {
    category: 'credentials',
    label: 'credentials / API keys / access management',
    re: /\b(api[\s-]?key|api[\s-]?token|access[\s-]?token|secret[\s-]?key|client[\s-]?secret|oauth[\s-]?secret|private[\s-]?key|ssh[\s-]?key|service[\s-]?account[\s-]?key|password|passwd|credentials?|\.env\b|rotate (?:the )?(?:key|token|secret|credential)|revoke (?:the )?(?:key|token|access)|grant(?:ing)? (?:access|permission)|access management|iam (?:role|policy|user))\b/i,
  },
  {
    category: 'client-pii',
    label: 'client PII / confidential client data',
    // `card number` carries a negative lookahead for "of": "card number of items in the backlog"
    // is a quantity, not a card. English reuses "number of X" for counting, and without this the
    // gate fires on ordinary sentences — see the note on ported defects in the header.
    re: /\b(ssn|social security|passport (?:number|no)|aadh?aar|credit[\s-]?card|debit[\s-]?card|card number(?!\s+of\b)|cvv|bank account|account number|routing number|date of birth|\bdob\b|tax id|\bpii\b|personally identifiable|confidential client data|client'?s? personal (?:data|info|details))\b/i,
  },
  {
    category: 'production-deploy',
    label: 'production deployment (staging → production)',
    // The verb and "to production" are allowed up to four words apart. "Deploy the billing service
    // to production" is the ordinary way people write this, and the adjacent-only form missed it.
    re: /\b((?:deploy|push|ship|release|roll ?out|cut)\w*(?:\s+[\w-]+){0,4}\s+to\s+prod(?:uction)?|prod(?:uction)? (?:deploy(?:ment)?|release|push|rollout)|staging\s*(?:→|->|to)\s*prod(?:uction)?|go[\s-]?live (?:to )?prod(?:uction)?|cut(?:ting)? a (?:prod|production) release)\b/i,
  },
  {
    category: 'client-comms',
    label: 'client-facing communication (proposal / contract / client email)',
    re: /\b(send (?:the )?(?:proposal|contract|quote|invoice|sow|statement of work)\b|sign(?:ing)? (?:the )?contract|email (?:the |to (?:the )?)?client|reply to (?:the )?client|send to (?:the )?client|client[\s-]?facing (?:email|message|proposal|comms?)|outbound (?:client )?(?:email|proposal)|send (?:the )?(?:agreement|nda))\b/i,
  },
].map(Object.freeze) as readonly Readonly<CriticalRule>[]);

/** What a caller may see of a rule: everything except a live handle on the pattern. */
export type CriticalRuleView = { category: CriticalCategory; label: string };

/**
 * The rule table, for tests and for docs — **as data, never as a live `RegExp`.**
 *
 * Two earlier versions of this leaked a mutable gate, and the second is the instructive one:
 *
 *   1. `Object.freeze([...])` froze the array and left every rule object writable, so
 *      `criticalRules()[0].re = /never/` disarmed the credentials category while
 *      `Object.isFrozen(rules)` still returned true.
 *   2. Freezing each rule fixed that and **did not fix the actual problem.** `Object.freeze` makes a
 *      property non-writable; it does nothing to the object the property points at. `RegExp` has a
 *      legacy in-place mutator — `re.compile('never-matches', 'i')` — which needs no assignment at
 *      all. Measured: gate matches, `compile()` runs without throwing, gate stops matching.
 *
 * Both fixes were patches on the same shape: hand out a reference and then try to make the reference
 * safe. The reference is the bug. Callers get categories and labels; the patterns stay module-private
 * and are reachable only through `classifyCritical`, which returns a description of a match rather
 * than the thing that matched.
 */
export const criticalRules = (): readonly CriticalRuleView[] =>
  Object.freeze(CRITICAL_RULES.map((r) => Object.freeze({ category: r.category, label: r.label })));

/** First matching rule against title + description, or null. Returns a view, not the rule. */
export function classifyCritical(text: string): CriticalRuleView | null {
  const hit = CRITICAL_RULES.find((r) => r.re.test(text));
  return hit ? Object.freeze({ category: hit.category, label: hit.label }) : null;
}

/**
 * Holds any item whose title or description names high-stakes work.
 *
 * Applies to every category, not just NEW_TASK: commenting "rotated the production key" onto a card
 * is a write about a credential, and the point is that a human sees it before the board records it.
 */
export function criticalGate(item: CategorizationItem, enabled: boolean): GateResult {
  if (!enabled) return null;

  const hit = classifyCritical(`${item.title} ${item.finalDesc ?? ''}`);
  if (!hit) return null;

  return {
    gate: `critical — ${hit.label}`,
    question: formatClarifyAsk({
      facts: [`This reads as ${hit.label}, so it is held for confirmation rather than written.`],
      choice: 'Approve this write, or skip it?',
      hint: 'Held because of what it touches, not because the pipeline was unsure — every other field checked out.',
    }),
  };
}
