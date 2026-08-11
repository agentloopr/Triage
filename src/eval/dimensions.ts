/**
 * The six dimensions a run is scored on.
 *
 * These are questions about *outcomes*, not about model output. "Did the card get created with
 * enough detail to be actionable" is answerable by looking at the board; "was the reasoning good" is
 * not, and scoring it would just be one model agreeing with another.
 *
 * `miss_rate` is the one that matters most and is the hardest to measure: a dropped item leaves no
 * trace anywhere. Everything else is visible in what was written.
 */
export type EvalDimension = 'creation' | 'routing' | 'status' | 'comment' | 'miss_rate' | 'false_alarms';

export const SIX_DIMENSIONS: Array<{ key: EvalDimension; name: string; question: string }> = [
  {
    key: 'creation',
    name: 'Task creation',
    question: 'When something should become a task, did one get created — with the right title and enough detail to act on?',
  },
  { key: 'routing', name: 'Routing', question: 'Did it reach the right person AND the right list?' },
  {
    key: 'status',
    name: 'Status updates',
    question: 'When real-world status changed, did the card status change to match?',
  },
  {
    key: 'comment',
    name: 'Information capture',
    question: 'Did the full relevant detail land in the description or comment — not truncated, not lossy?',
  },
  {
    key: 'miss_rate',
    name: 'Catch / miss rate',
    question: 'Did it surface what should be tracked, and NOT silently drop things that should have been? The silent killer.',
  },
  {
    key: 'false_alarms',
    name: 'False alarms',
    question: 'Did it avoid raising already-done work or non-issues? A trust metric — this is what makes people stop reading the output.',
  },
];

export type DimScore = 'pass' | 'partial' | 'fail' | 'n/a';

export type DimResult = {
  dimension: EvalDimension;
  score: DimScore;
  why: string;
  /** `code` beats `judge` on merge — an objective check is never overridden by an opinion. */
  source: 'judge' | 'code';
};
