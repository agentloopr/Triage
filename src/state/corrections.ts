/**
 * The corrections store — how a human override becomes something the pipeline knows next time.
 *
 * This is the difference between a system that is *configured* and one that *learns*. When a person
 * resolves a hold ("no, those two cards are different work", "Rowan owns growth now"), the decision
 * is recorded here and fed back into later prompts and gates. Nobody edits code; the next run
 * behaves differently.
 *
 * Two shapes, deliberately:
 *   • **typed facts** — machine-actionable, consulted directly by gates (valid assignees, list
 *     aliases, not-duplicate pairs);
 *   • **free-form notes** — everything else worth remembering, injected into prompts as context.
 *
 * Forcing every correction into a rigid schema would mean discarding the ones that don't fit, which
 * is most of them.
 */
import { CORRECTIONS_PATH } from '../config';
import { atomicWriteJson, readJsonOrNull, withExclusiveFileLock } from './jsonStore';

export interface NotDuplicatePair {
  /** Normalized proposed title that was wrongly matched. */
  proposedTitle: string;
  /** The existing card it was wrongly matched TO. */
  existingId: string;
  by: string;
  at: string;
}

export interface LearnedNote {
  text: string;
  /** Optional list key or member name this relates to. */
  scope?: string;
  by: string;
  at: string;
}

export interface CorrectionsStore {
  version: 1;
  /** listKey → member NAMES additionally allowed to own work there. */
  validAssigneeAdditions: Record<string, string[]>;
  /** normalized alias → canonical list key. */
  listAliases: Record<string, string>;
  /** normalized alias → canonical member name. */
  nameAliases: Record<string, string>;
  notDuplicatePairs: NotDuplicatePair[];
  notes: LearnedNote[];
}

export type Correction =
  | { kind: 'valid_assignee'; listKey: string; assigneeName: string }
  | { kind: 'remove_valid_assignee'; listKey: string; assigneeName: string }
  | { kind: 'list_alias'; alias: string; canonical: string }
  | { kind: 'name_alias'; alias: string; canonical: string }
  | { kind: 'note'; text: string; scope?: string };

/**
 * A FUNCTION, not a shared constant. A module-level `EMPTY` object spread with `{ ...EMPTY }` copies
 * only the top level, so every "fresh" store would share the same `notes` and `notDuplicatePairs`
 * arrays — and the first `push` would mutate the constant for the lifetime of the process.
 */
const emptyStore = (): CorrectionsStore => ({
  version: 1,
  validAssigneeAdditions: {},
  listAliases: {},
  nameAliases: {},
  notDuplicatePairs: [],
  notes: [],
});

const MAX_PAIRS = 500;
const MAX_NOTES = 500;

let overridePath: string | null = null;

/** Point the store at a different file — for tests and for per-scenario fixtures. */
export function setCorrectionsPath(path: string | null): void {
  overridePath = path;
}

function path(): string {
  return overridePath ?? CORRECTIONS_PATH;
}

export const normalizeKey = (s: string): string =>
  s.trim().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').toLowerCase();

export function loadCorrections(): CorrectionsStore {
  const raw = readJsonOrNull<Partial<CorrectionsStore>>(path());
  if (!raw) return emptyStore();
  return {
    version: 1,
    validAssigneeAdditions: raw.validAssigneeAdditions ?? {},
    listAliases: raw.listAliases ?? {},
    nameAliases: raw.nameAliases ?? {},
    notDuplicatePairs: raw.notDuplicatePairs ?? [],
    notes: raw.notes ?? [],
  };
}

/** Member NAMES additionally permitted on a list, on top of the registry's `validAssignees`. */
export function getValidAssigneeAdditions(listKey: string): string[] {
  return loadCorrections().validAssigneeAdditions[normalizeKey(listKey)] ?? [];
}

export function resolveListAlias(normalizedAlias: string): string | undefined {
  return loadCorrections().listAliases[normalizeKey(normalizedAlias)];
}

export function resolveNameAlias(normalizedAlias: string): string | undefined {
  return loadCorrections().nameAliases[normalizeKey(normalizedAlias)];
}

/**
 * True when a human has already said this proposed title is NOT the same work as that card.
 *
 * Without this, the pipeline re-proposes the same rejected duplicate every time the topic comes up,
 * and the person who corrected it once has to correct it forever.
 */
export function isKnownNotDuplicate(proposedTitle: string, existingId: string): boolean {
  const t = normalizeKey(proposedTitle);
  const id = existingId.toLowerCase();
  return loadCorrections().notDuplicatePairs.some(
    (p) => p.existingId.toLowerCase() === id && normalizeKey(p.proposedTitle) === t
  );
}

export function listLearnedNotes(limit = 40): LearnedNote[] {
  return loadCorrections().notes.slice(-limit).reverse();
}

/** Prompt-ready lines for the most recent corrections — the "fed back into future prompts" half. */
export function learnedFactsBlock(limit = 30): string[] {
  const store = loadCorrections();
  const lines: string[] = [];

  for (const n of store.notes.slice(-limit).reverse()) {
    lines.push(`• ${n.text}${n.scope ? ` [${n.scope}]` : ''}`);
  }
  for (const p of store.notDuplicatePairs.slice(-limit).reverse()) {
    lines.push(`• "${p.proposedTitle}" is NOT the same work as card ${p.existingId} — a human confirmed this.`);
  }
  for (const [listKey, names] of Object.entries(store.validAssigneeAdditions)) {
    if (names.length) lines.push(`• ${names.join(', ')} may own work on "${listKey}".`);
  }
  return lines.slice(0, limit);
}

/**
 * Read, mutate, cap, write — under a lock held across processes.
 *
 * `npm run correct` is a CLI, so "two writers" means two people at two terminals, and the in-process
 * FIFO lock this used to hold could not see the second one. Measured: eight simultaneous processes
 * each recording a distinct correction left four on disk. **A correction the CLI acknowledged and
 * then dropped is worse than one it refused** — the human believes the pipeline has been told, and
 * the next run repeats the decision they overrode.
 */
async function mutate(fn: (s: CorrectionsStore) => void): Promise<void> {
  withExclusiveFileLock(path(), () => {
    const store = loadCorrections();
    fn(store);
    if (store.notDuplicatePairs.length > MAX_PAIRS) {
      store.notDuplicatePairs = store.notDuplicatePairs.slice(-MAX_PAIRS);
    }
    if (store.notes.length > MAX_NOTES) store.notes = store.notes.slice(-MAX_NOTES);
    atomicWriteJson(path(), store);
  });
}

export async function recordCorrection(fact: Correction, by: string, at = new Date().toISOString()): Promise<void> {
  await mutate((s) => {
    switch (fact.kind) {
      case 'valid_assignee': {
        const key = normalizeKey(fact.listKey);
        const cur = new Set(s.validAssigneeAdditions[key] ?? []);
        cur.add(fact.assigneeName);
        s.validAssigneeAdditions[key] = [...cur];
        break;
      }
      case 'remove_valid_assignee': {
        const key = normalizeKey(fact.listKey);
        s.validAssigneeAdditions[key] = (s.validAssigneeAdditions[key] ?? []).filter((n) => n !== fact.assigneeName);
        break;
      }
      case 'list_alias':
        s.listAliases[normalizeKey(fact.alias)] = fact.canonical;
        break;
      case 'name_alias':
        s.nameAliases[normalizeKey(fact.alias)] = fact.canonical;
        break;
      case 'note':
        s.notes.push({ text: fact.text, ...(fact.scope ? { scope: fact.scope } : {}), by, at });
        break;
    }
  });
}

export async function recordNotDuplicate(
  proposedTitle: string,
  existingId: string,
  by: string,
  at = new Date().toISOString()
): Promise<void> {
  await mutate((s) => {
    const exists = s.notDuplicatePairs.some(
      (p) => p.existingId.toLowerCase() === existingId.toLowerCase() && normalizeKey(p.proposedTitle) === normalizeKey(proposedTitle)
    );
    if (!exists) s.notDuplicatePairs.push({ proposedTitle, existingId, by, at });
  });
}
