/**
 * The board snapshot renderer — shared by every adapter.
 *
 * In production each adapter would have rendered its own text and the pipeline would have
 * regex-parsed it back into structure, which is two parsers and a whole class of drift. Here
 * adapters normalize to `BoardTask[]` and this one function renders it, so the prompt-facing format
 * is defined in exactly one place and nothing ever parses it back.
 *
 * Row format (full):    id | title | list | assignees | status | description
 * Row format (compact): id | title | list | assignees | status
 *
 * Subtasks are tagged `[SUBTASK of <parent>]` and sorted immediately after their parent — the
 * categorization pass reasons about containment, and adjacency is what makes that legible.
 */
import type { BoardTask } from './index';

export const DEFAULT_DESC_MAX_CHARS = 500;

export interface SnapshotOptions {
  /** 0 or Infinity for uncapped. */
  descMaxChars?: number;
}

/** Parents first, each immediately followed by its subtasks; orphaned subtasks last. */
export function orderTasks(tasks: BoardTask[]): BoardTask[] {
  const parents = tasks.filter((t) => !t.parentId);
  const childrenOf = new Map<string, BoardTask[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const bucket = childrenOf.get(t.parentId) ?? [];
    bucket.push(t);
    childrenOf.set(t.parentId, bucket);
  }

  const ordered: BoardTask[] = [];
  const seenParents = new Set<string>();
  for (const p of parents) {
    ordered.push(p);
    seenParents.add(p.id);
    for (const c of childrenOf.get(p.id) ?? []) ordered.push(c);
  }
  // A subtask whose parent isn't in this page would otherwise vanish from the snapshot entirely.
  for (const [parentId, children] of childrenOf) {
    if (!seenParents.has(parentId)) ordered.push(...children);
  }
  return ordered;
}

export function renderBoardSnapshot(tasks: BoardTask[], opts?: SnapshotOptions): string {
  return renderRows(tasks, opts, true);
}

/** No descriptions — for the passes that only need to know what exists, not what it says. */
export function renderCompactSnapshot(tasks: BoardTask[]): string {
  return renderRows(tasks, {}, false);
}

function renderRows(tasks: BoardTask[], opts: SnapshotOptions | undefined, withDesc: boolean): string {
  const capRaw = opts?.descMaxChars ?? DEFAULT_DESC_MAX_CHARS;
  const cap = capRaw > 0 ? capRaw : Infinity;

  return orderTasks(tasks)
    .map((t) => {
      const title = t.parentId ? `[SUBTASK of ${t.parentId}] ${oneLine(t.title)}` : oneLine(t.title);
      const cells = [t.id, title, t.listKey, t.assignees.join(', '), t.status];
      if (withDesc) {
        const desc = oneLine(t.description ?? '');
        cells.push(desc.length > cap ? `${desc.slice(0, cap)}…` : desc);
      }
      return cells.join(' | ');
    })
    .join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\r?\n+/g, ' ').trim();
}
