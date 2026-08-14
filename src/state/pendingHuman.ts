/**
 * Held items, persisted across restarts.
 *
 * A gate that holds an item is only half a feature. If the hold lives in memory, a deploy, a crash or
 * an idle timeout silently discards every open question — and the failure is invisible in exactly the
 * wrong direction: the run reported "3 held for a human", the human answers tomorrow, and the answer
 * lands nowhere. Nobody gets an error. The work is simply gone.
 *
 * Two decisions here are load-bearing:
 *
 *  1. **A resolution re-enters execution deterministically, with no model call.** The full gap-filled
 *     item is stored at hold time (`originalItem`), so approving a hold plans and writes from the
 *     decision the model already made. Re-invoking the model on resume would mean the human approved
 *     one thing and a second inference wrote another.
 *
 *  2. **A hold with no `originalItem` cannot be resumed.** Some gates hold a whole batch without a
 *     usable per-item decision behind it. Approving one of those would have to invent the write, so
 *     `resolve` refuses instead. Refusing is recoverable; inventing a task is not.
 *
 * Storage is the shared `jsonStore` primitive, so this inherits atomic writes and loud corruption
 * handling rather than reimplementing them.
 */
import { atomicWriteJson, readJsonOrNull } from './jsonStore';
import type { HeldItem } from '../pipeline/gates/contractGates';
import type { CategorizationItem } from '../pipeline/parsing/categorizationManifest';

export type PendingHold = {
  /** `<sourceId>#<item>` — stable across restarts, and the same hold twice is the same id. */
  id: string;
  sourceId: string;
  item: number;
  title: string;
  gate: string;
  question: string;
  notifyAssignee?: string;
  /** Absent when the gate held without a per-item decision — such a hold is not resumable. */
  originalItem?: CategorizationItem;
  heldAtIso: string;
};

export type Resolution = 'approve' | 'skip';

export type ResolveResult =
  | { status: 'resolved'; decision: Resolution; hold: PendingHold }
  | { status: 'unknown' }
  | { status: 'not_resumable'; hold: PendingHold };

type File = { version: 1; holds: PendingHold[] };

const EMPTY: File = { version: 1, holds: [] };

export interface PendingHumanStore {
  register(sourceId: string, held: HeldItem[]): PendingHold[];
  list(sourceId?: string): PendingHold[];
  get(id: string): PendingHold | null;
  /**
   * Validate that this hold can take this decision, and hand back what is needed to act on it —
   * **without removing it.** The hold survives until `finalize`.
   */
  claim(id: string, decision: Resolution): ResolveResult;
  /** Remove a claimed hold. Call only once the decision has actually taken effect. */
  finalize(id: string): boolean;
  /**
   * `claim` + `finalize` in one step.
   *
   * Correct only when acting on the decision cannot fail — a skip writes nothing, so there is no
   * outcome to wait for. **Never use it before a tracker write:** that ordering deleted the hold
   * first and executed second, so a tracker outage or a protected-status refusal destroyed the
   * human's decision and left nothing to retry.
   */
  resolve(id: string, decision: Resolution): ResolveResult;
}

export function pendingHumanStore(path: string, opts: { now?: () => number } = {}): PendingHumanStore {
  const now = opts.now ?? (() => Date.now());

  // Read on every call rather than caching. The point of this store is surviving a restart, and a
  // cache is how a second process's writes become invisible to the first.
  // ponytail: read-modify-write is atomic only within one process; add file locking if two
  // processes ever resolve holds concurrently.
  const read = (): File => readJsonOrNull<File>(path) ?? { ...EMPTY, holds: [] };
  const write = (f: File): void => atomicWriteJson(path, f);

  return {
    register(sourceId, held) {
      const file = read();
      const byId = new Map(file.holds.map((h) => [h.id, h]));

      for (const h of held) {
        const id = `${sourceId}#${h.item}`;
        // Re-registering an existing hold keeps the original — a retried delivery must not reset the
        // clock on a question a human has already been looking at.
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          sourceId,
          item: h.item,
          title: h.title,
          gate: h.gate,
          question: h.question,
          ...(h.notifyAssignee ? { notifyAssignee: h.notifyAssignee } : {}),
          ...(h.originalItem ? { originalItem: h.originalItem } : {}),
          heldAtIso: new Date(now()).toISOString(),
        });
      }

      const holds = [...byId.values()];
      write({ version: 1, holds });
      return holds.filter((h) => h.sourceId === sourceId);
    },

    list(sourceId) {
      const holds = read().holds;
      return sourceId ? holds.filter((h) => h.sourceId === sourceId) : holds;
    },

    get(id) {
      return read().holds.find((h) => h.id === id) ?? null;
    },

    /**
     * Remove a hold and report what it was.
     *
     * Removal happens on both decisions, and a second call returns `unknown` rather than resolving
     * again. Answering twice is normal — a person clicks, nothing visibly happens, they click again —
     * and the second click must not produce a second card.
     */
    claim(id, decision) {
      const hold = read().holds.find((h) => h.id === id);
      if (!hold) return { status: 'unknown' };
      if (decision === 'approve' && !hold.originalItem) return { status: 'not_resumable', hold };
      return { status: 'resolved', decision, hold };
    },

    finalize(id) {
      const file = read();
      if (!file.holds.some((h) => h.id === id)) return false;
      write({ version: 1, holds: file.holds.filter((h) => h.id !== id) });
      return true;
    },

    resolve(id, decision) {
      const res = this.claim(id, decision);
      if (res.status === 'resolved') this.finalize(id);
      return res;
    },
  };
}
