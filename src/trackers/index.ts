/**
 * The tracker seam.
 *
 * The rule that makes this abstraction real rather than ceremonial: **the pipeline speaks canonical
 * member names and list keys; only the adapter ever sees a tracker id.** Every gate, prompt, parser
 * and the entire categorization taxonomy is tracker-blind because of it.
 *
 * `OpOutcome` is the other half. A write is not a boolean. In production the ClickUp path returned
 * success for three genuinely different situations — applied, already in that state, and refused by
 * the protected-status guard — and collapsing them lost the one that needed a human. Promoting that
 * distinction into the *interface* generalizes correctly: "never auto-move a card out of a protected
 * status" is a policy every tracker needs, not a ClickUp response-parsing quirk.
 */

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export interface BoardTask {
  id: string;
  title: string;
  description?: string;
  listKey: string;
  /** Canonical member NAMES, never tracker ids. */
  assignees: string[];
  status: string;
  priority?: Priority;
  dueDate?: string;
  parentId?: string;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export type TrackerOperation =
  | {
      kind: 'createTask';
      listKey: string;
      title: string;
      description?: string;
      assignees: string[];
      priority?: Priority;
      dueDate?: string;
      status?: string;
      parentId?: string;
      requestedBy?: string;
    }
  | { kind: 'addComment'; taskId: string; body: string }
  | { kind: 'setStatus'; taskId: string; status: string }
  | { kind: 'setDueDate'; taskId: string; dueDate: string }
  | { kind: 'setPriority'; taskId: string; priority: Priority }
  /** Replace semantics, not append — the one that silently corrupts a board if an adapter gets it wrong. */
  | { kind: 'setAssignees'; taskId: string; assignees: string[] }
  | { kind: 'linkTasks'; taskIdA: string; taskIdB: string }
  | { kind: 'moveList'; taskId: string; listKey: string };

export type OpOutcome =
  | { status: 'applied'; resultId?: string }
  /** Already in the desired state. Not an error, and not a change — the audit needs to tell them apart. */
  | { status: 'unchanged'; detail: string }
  /** A guard refused it. Needs a human; retrying will not help. */
  | { status: 'refused'; detail: string }
  /** The tracker cannot express this operation at all (e.g. ClickUp v2 has no move-list endpoint). */
  | { status: 'unsupported'; detail: string }
  | { status: 'failed'; detail: string };

export interface TrackerCapabilities {
  moveList: boolean;
  linkTasks: boolean;
  subtasks: boolean;
  priority: boolean;
  dueDate: boolean;
  protectedStatusGuard: boolean;
}

export interface TrackerAdapter {
  readonly name: string;
  readonly capabilities: Readonly<TrackerCapabilities>;
  getTask(id: string): Promise<BoardTask | null>;
  getComments(id: string, limit?: number): Promise<Comment[]>;
  listTasks(opts?: { listKeys?: string[]; includeClosed?: boolean }): Promise<BoardTask[]>;
  /** The prompt-facing board text. Adapter-owned so the pipeline never regex-parses a tracker's format. */
  renderSnapshot(tasks: BoardTask[]): string;
  apply(op: TrackerOperation): Promise<OpOutcome>;
}
