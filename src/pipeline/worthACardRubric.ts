/**
 * The shared "does this deserve a board card at all?" rubric — one source of truth, used identically
 * by the blind verification read and by any other legitimacy judgement.
 *
 * Source-agnostic: it assumes nothing about transcripts, channels, or any particular tracker. This
 * module has NO imports on purpose — it is a leaf, so every importer stays free of circular-dependency
 * hazards.
 */
export const WORTH_A_CARD_RUBRIC = [
  'WORTH_A_CARD — does this deserve a board card at all? Reason from principle: would a competent PM',
  'actually OPEN AND TRACK a card for this, or just do it in the moment / treat it as chatter? Judge the',
  'SUBSTANCE, not the wording.',
  '  • real_task — a concrete, trackable deliverable with a completion state. This INCLUDES: a status',
  '    change / progress on an existing card, and any build/fix/deploy/send/check with a real outcome.',
  '    A blocked/waiting item IS real_task when the block is gating a concrete deliverable someone is',
  '    actively working on — e.g. "blocked on registrar credentials to finish the DNS setup": the DNS work',
  '    itself is the deliverable, and losing track of the blocker stalls real, in-progress work.',
  '    When it maps to an existing card (an update or comment), it is real_task by definition — do not',
  '    second-guess legitimacy for those.',
  '  • not_a_task — pure information / an explanation / an opinion / a question or discussion needing a',
  '    reply / a vague relay with NO named deliverable or owner (e.g. "there were two small things, I\'ll',
  '    handle them") / work already DONE with nothing remaining / a passing aside a team would never board.',
  '    ALSO not_a_task: a BARE status-check with nothing beyond monitoring + reporting back — no build/',
  '    fix/deploy/send tied to it, just "I will check on X and let you know" — e.g. "waiting for an account',
  '    to activate, will report back Wednesday": the checking-and-reporting IS the entire scope, nothing is',
  '    built/shipped/fixed as a result, and no further deliverable depends on it. THE TEST: does resolving',
  '    this lead to further concrete work, or does it just end at "I told them the status"? If the latter,',
  '    it is a personal reminder, not board-trackable work — contrast with the DNS example above, where',
  '    resolving the block lets real, in-progress work continue.',
  '  • unsure — genuinely on the fence, or the source is too garbled / low-confidence to tell what was',
  '    actually committed.',
  'Bias: if it is a genuine deliverable and you are merely unsure, treat it as real_task — this judgement',
  'only catches work a team would never track. A wrong not_a_task is cheap (a human is asked); do not',
  'inflate a vague aside into a task to be safe.',
].join('\n');
