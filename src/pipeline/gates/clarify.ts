/**
 * How the pipeline asks a human a question.
 *
 * Every gate produces the same shape: **state the fact, name the choice, nothing else.** A person
 * being asked should see what already exists and what they are choosing between — never the
 * pipeline's internal reasoning, and never a raw field token like `FINAL_DESC`.
 *
 * Keeping ~20 gates structurally identical is what makes the holds answerable at a glance instead of
 * being ignored, and an ignored hold is functionally the same as no gate at all.
 */
import type { BoardTask } from '../../trackers';
import type { MeetingCategory } from '../parsing/categorizationManifest';

/** id → task, for the gates' existence and identity checks. */
export function indexTasks(tasks: BoardTask[]): Map<string, BoardTask> {
  return new Map(tasks.map((t) => [t.id, t]));
}

/**
 * How a task id is rendered to a human. The tracker owns this — a bare id is not clickable and not
 * useful in a question — so the adapter layer injects a builder. Default is the plain id, which is
 * correct for the in-memory tracker and any adapter that has no web UI.
 */
let taskUrlBuilder: (id: string) => string = (id) => `card ${id}`;

export function setTaskUrlBuilder(fn: ((id: string) => string) | null): void {
  taskUrlBuilder = fn ?? ((id) => `card ${id}`);
}

export function taskUrl(id: string): string {
  return taskUrlBuilder(id);
}

/** Strip the subtask marker so a title reads naturally inside a question. */
const plainTitle = (t: string): string => t.replace(/^\[SUBTASK of [^\]]+\]\s*/i, '');

/**
 * "title / list · status · owner / link" for an existing card — the shared building block for every
 * question that references another card. null when the id is not in the snapshot (closed, deleted,
 * or simply wrong), which callers turn into an honest caveat rather than a confident claim.
 */
export function describeExistingCard(snap: Map<string, BoardTask>, id: string | undefined | null): string | null {
  if (!id) return null;
  const card = snap.get(id);
  if (!card) return null;
  const meta = [card.listKey, card.status, card.assignees.join(', ')].filter(Boolean).join(' · ');
  return [`"${plainTitle(card.title)}"`, meta, taskUrl(id)].filter(Boolean).join('\n');
}

/**
 * The full "a similar card already exists" fact, or — when the id is no longer in the snapshot — a
 * bare link with the uncertainty stated. Never a bare unlinked id: on its own it tells a human
 * nothing they can act on.
 */
export function describeMatchOrLink(snap: Map<string, BoardTask>, id: string | undefined | null): string | null {
  if (!id) return null;
  const described = describeExistingCard(snap, id);
  if (described) return `A similar card already exists:\n${described}`;
  return `A possible match — ${taskUrl(id)} (couldn't confirm its current details; it may have been closed or deleted).`;
}

/** What the write actually does, so the choice names the real action rather than a vague "treat it as". */
export function actionPhrase(category: MeetingCategory | 'UNKNOWN'): string {
  if (category === 'UPDATE') return 'add it as a comment on that card';
  if (category === 'SUBTASK') return 'add it as a subtask under that card';
  if (category === 'DUPLICATE') return 'skip it — that card already covers it';
  return 'treat it as that card';
}

export type ClarifyAsk = {
  facts?: (string | null | undefined)[];
  choice: string;
  hint?: string;
};

/** Bullet facts, then the question, then an optional reply hint. */
export function formatClarifyAsk(ask: ClarifyAsk): string {
  const facts = (ask.facts ?? []).filter((f): f is string => !!f);
  const parts: string[] = [];

  if (facts.length) {
    parts.push(
      facts
        .map((f) => {
          const [first, ...rest] = f.split('\n');
          return [first, ...rest.map((r) => `  ${r}`)].join('\n');
        })
        .join('\n')
    );
  }
  parts.push(ask.choice);
  if (ask.hint) parts.push(`_${ask.hint}_`);
  return parts.join('\n\n');
}

/** Plain-English label for an uncertain field — never show a human the raw internal token. */
const FIELD_LABELS: Record<string, string> = {
  list: 'which list this belongs on',
  assignee: 'who should own it',
  content: 'the description wording',
};

export function humanizeFieldName(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

const MISSING_FIELD_LABELS: Record<string, string> = {
  LIST: 'which list this belongs on',
  ASSIGNEE: 'who should own it',
  FINAL_DESC: 'a description',
  EXISTING_TASK_ID: 'which existing card this updates',
  PARENT_TASK_ID: 'the parent card',
  NOTIFY_ASSIGNEE: 'who to notify',
  LINK_TASK_ID_1: 'the first linked card',
  LINK_TASK_ID_2: 'the second linked card',
};

export function humanizeMissingField(field: string): string {
  return MISSING_FIELD_LABELS[field] ?? field.toLowerCase().replace(/_/g, ' ');
}
