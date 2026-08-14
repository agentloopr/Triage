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
import { atomicWriteJson, readJsonOrNull, withExclusiveFileLock } from './jsonStore';
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
  /**
   * Set while an approval is in flight, so a second one does not execute the same write.
   *
   * Without it, two concurrent `npm run answer -- <id> --approve` both read the hold, both execute,
   * and **two cards land on the board from one decision** — observed, not theorised. The previous
   * design happened to avoid this by deleting the hold first, which is why splitting claim from
   * finalize reintroduced it: durability and exclusivity were being provided by the same delete.
   */
  claim?: { token: string; atIso: string };
};

/**
 * How long a claim is honoured before another approval may take it.
 *
 * A process that dies mid-write leaves its claim behind; without an expiry the hold would be stuck
 * forever, which is a worse failure than the double write. Long enough that a slow tracker call
 * cannot be overtaken by an impatient second operator.
 */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

export type Resolution = 'approve' | 'skip';

export type ResolveResult =
  | { status: 'resolved'; decision: Resolution; hold: PendingHold; /** Pass to `finalize`. */ claimToken: string }
  | { status: 'unknown' }
  | { status: 'not_resumable'; hold: PendingHold }
  /** Someone else is mid-approval on this hold. Theirs will finish or release it. */
  | { status: 'in_progress'; hold: PendingHold; since: string };

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
  finalize(id: string, claimToken: string): boolean;
  /** Give a claim back without resolving, so a retry can take it. */
  release(id: string, claimToken: string): void;
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

export function pendingHumanStore(
  path: string,
  opts: {
    now?: () => number;
    /**
     * Passed through to the cross-process lock. Exposed so a test can assert that a method actually
     * takes it — without this, "does `register` lock?" is unobservable in one process, and the test
     * for it passed whether the lock was there or not.
     */
    lock?: { timeoutMs?: number; staleMs?: number };
  } = {}
): PendingHumanStore {
  const now = opts.now ?? (() => Date.now());
  const locked = <T>(fn: () => T): T => withExclusiveFileLock(path, fn, { ...opts.lock, now });

  // Read on every call rather than caching. The point of this store is surviving a restart, and a
  // cache is how a second process's writes become invisible to the first.
  // (This used to carry a note saying read-modify-write was atomic only within one process and that
  // file locking should be added if two ever resolved holds concurrently. The locking arrived; the
  // note stayed, describing the behaviour of code three lines above that had stopped being true.)
  const read = (): File => readJsonOrNull<File>(path) ?? { ...EMPTY, holds: [] };
  const write = (f: File): void => atomicWriteJson(path, f);

  return {
    register(sourceId, held) {
      // Under the lock, like every other mutation. It was the one method left out, and it is the
      // one the PIPELINE calls while a human may be answering: an unlocked register read the file,
      // an approval wrote a claim into it, and the register's write put the pre-claim copy back —
      // erasing a claim that had already been granted. Observed in an audit probe.
      return locked(() => {
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
      });
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
      // Under the CROSS-PROCESS lock. `npm run answer` is a CLI, so two operators are two processes,
      // and an in-process lock cannot see the other one at all: both read the file, both find the
      // hold unclaimed, both write. Measured that way before this lock existed.
      return locked((): ResolveResult => {
        const file = read();
        const hold = file.holds.find((h) => h.id === id);
        if (!hold) return { status: 'unknown' };
        if (decision === 'approve' && !hold.originalItem) return { status: 'not_resumable', hold };

        // A live claim by someone else wins — for EITHER decision. The guard used to read
        // `live && decision === 'approve'`, so a skip walked past an in-flight approval, took the
        // claim, and deleted the hold: measured as one card written AND the same hold reported
        // skipped. A decision already being acted on is not available to a second decision,
        // whichever way each one points.
        const live = hold.claim && now() - Date.parse(hold.claim.atIso) < CLAIM_TTL_MS;
        if (live) return { status: 'in_progress', hold, since: hold.claim!.atIso };

        const claimToken = `${process.pid}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
        const claimed: PendingHold = { ...hold, claim: { token: claimToken, atIso: new Date(now()).toISOString() } };
        write({ version: 1, holds: file.holds.map((h) => (h.id === id ? claimed : h)) });
        return { status: 'resolved', decision, hold: claimed, claimToken };
      });
    },

    finalize(id, claimToken) {
      return locked(() => {
        const file = read();
        const hold = file.holds.find((h) => h.id === id);
        if (!hold) return false;
        // **Finalizing requires holding a matching claim — no claim is a refusal, not a pass.**
        // The guard used to read `hold.claim && ...`, so an UNCLAIMED hold fell straight through and
        // any string at all deleted it: `finalize(id, 'i-made-this-up')` returned true. The token
        // was doing nothing in exactly the case where nothing else was either.
        //
        // A stale token — from a claim taken over after expiring — is refused for the same reason:
        // it must not delete the hold the new owner is working on.
        if (!hold.claim || hold.claim.token !== claimToken) return false;
        write({ version: 1, holds: file.holds.filter((h) => h.id !== id) });
        return true;
      });
    },

    release(id, claimToken) {
      return locked(() => {
        const file = read();
        const hold = file.holds.find((h) => h.id === id);
        if (!hold || hold.claim?.token !== claimToken) return;
        const { claim: _dropped, ...rest } = hold;
        write({ version: 1, holds: file.holds.map((h) => (h.id === id ? (rest as PendingHold) : h)) });
      });
    },

    resolve(id, decision) {
      const res = this.claim(id, decision);
      // Acting on the result, not discarding it. A `false` means the claim was taken over between
      // the two calls, so this resolution did NOT take effect — reporting `resolved` anyway is the
      // same silent-success bug that `resumeHold` had, one layer down.
      if (res.status === 'resolved' && !this.finalize(id, res.claimToken)) {
        return { status: 'in_progress', hold: res.hold, since: res.hold.claim?.atIso ?? 'unknown' };
      }
      return res;
    },
  };
}
