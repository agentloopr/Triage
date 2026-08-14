/**
 * Per-role state — one file per archetype, holding what that role currently has open plus whatever
 * context a human wants the model to know about them.
 *
 * **Why this is a file per role rather than one shared file.** The unit a human edits is a role: you
 * open `engineer.json`, add "Priya is on leave until the 14th", and that is the whole operation. A
 * single combined file makes every edit a merge conflict with the pipeline's own writes, and the
 * pipeline writes after every run.
 *
 * **What makes it state rather than decoration.** It is written by the pipeline (after 2c, from what
 * actually got created or updated) and read back into the 2a/2b roster block on the next run. So a
 * second meeting that mentions work someone already picked up sees that they already picked it up.
 * An earlier draft of this repo shipped role *profiles* with no state at all on the grounds that
 * state only means something for a live agent with memory — which was true of an empty file, and
 * stopped being true once something wrote to it.
 *
 * **Fail-open, like the profiles.** A missing, unreadable or corrupt file costs the prompt some
 * context and warns; it never fails a run. Nothing here can cause a wrong write — the routing gate
 * still validates every assignee against the registry afterwards.
 */
import { join } from 'node:path';
import { ROLES_DIR, STATE_DIR } from '../config';
import { ROLE_ARCHETYPES, type RoleArchetype, isRoleArchetype } from '../registry/opsRegistry';
import { atomicWriteJson, readJsonOrNull, withExclusiveFileLock } from './jsonStore';

/** Keep the injected block small; the taxonomy next to it is what decides the answer. */
export const MAX_OPEN_ITEMS = 5;

export interface RoleOpenItem {
  /** Tracker id when the work landed on a card, absent when it was held. */
  taskId?: string;
  title: string;
  /** ISO date this was last touched by a run. */
  at: string;
}

export interface RoleState {
  version: 1;
  role: RoleArchetype;
  /** Free text a human maintains. The pipeline never overwrites this. */
  context: string;
  /** Most-recent-first, capped. Written by the pipeline. */
  openItems: RoleOpenItem[];
  updatedAt: string;
}

let overrideDir: string | null = null;

/** Point at a different directory — for tests, and for a consumer keeping state outside the repo. */
export function setRoleStateDir(dir: string | null): void {
  overrideDir = dir;
}

function dir(): string {
  return overrideDir ?? join(STATE_DIR, 'roles');
}

function pathFor(role: RoleArchetype): string {
  return join(dir(), `${role}.json`);
}

/**
 * The version-controlled seed each role ships with, under `config/roles/state/`.
 *
 * Two locations rather than one, because the two have different owners. The seed is **yours**: it is
 * in git, it is where you write "Priya is on leave until the 14th", and a `git pull` should bring
 * your team's edits with it. Live state is the **pipeline's**: it changes after every run, and a file
 * the pipeline rewrites constantly has no business being version-controlled — it would put a diff in
 * every commit and a conflict in every merge.
 *
 * Reads fall back seed-ward; the first write copies the seed's context forward, so nothing a human
 * wrote is lost the moment the pipeline touches the file.
 */
function seedPathFor(role: RoleArchetype): string {
  return join(ROLES_DIR, 'state', `${role}.json`);
}

function empty(role: RoleArchetype): RoleState {
  return { version: 1, role, context: '', openItems: [], updatedAt: new Date().toISOString() };
}

/**
 * Read one role's state. Never throws — an absent file is an empty state, and a corrupt one is
 * quarantined by `readJsonOrNull` and reported before we start empty.
 */
export function readRoleState(role: RoleArchetype): RoleState {
  const raw =
    readJsonOrNull<Partial<RoleState>>(pathFor(role)) ??
    // Seeds are hand-maintained and version-controlled, so a broken one must not be renamed out from
    // under the person editing it — report and move on rather than quarantine.
    readJsonOrNull<Partial<RoleState>>(seedPathFor(role), { quarantine: false });
  if (!raw) return empty(role);

  // Hand-edited files are expected here, so validate rather than trust the shape.
  return {
    version: 1,
    role,
    context: typeof raw.context === 'string' ? raw.context : '',
    openItems: Array.isArray(raw.openItems)
      ? raw.openItems
          .filter((i): i is RoleOpenItem => !!i && typeof i.title === 'string' && typeof i.at === 'string')
          .slice(0, MAX_OPEN_ITEMS)
      : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

/**
 * Record work that landed for a role, newest first, de-duplicated by task id or title.
 *
 * `context` is never touched: it is the human's half of the file, and a run that overwrote it would
 * silently delete the one thing here nobody else can reconstruct.
 *
 * **The read and the write are one locked step.** They were two, with nothing between them, which
 * made every concurrent run a lost update: eight simultaneous writers left two unique items in a
 * file capped at five. That is not a wrong write — the routing gate re-validates every assignee
 * afterwards, so nothing bad reaches the board — but the whole point of this file is that the *next*
 * run knows what the last one did, and a merge that drops most of its inputs quietly stops being
 * that. Read-then-write across processes needs the same lock as everything else on disk here.
 */
export function recordRoleWork(role: RoleArchetype, items: RoleOpenItem[]): void {
  if (!items.length) return;
  const file = pathFor(role);

  try {
    withExclusiveFileLock(file, () => {
      const prior = readRoleState(role);

      const seen = new Set<string>();
      const merged: RoleOpenItem[] = [];
      for (const it of [...items, ...prior.openItems]) {
        const key = (it.taskId ?? it.title).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(it);
        if (merged.length >= MAX_OPEN_ITEMS) break;
      }

      atomicWriteJson(file, {
        ...prior,
        openItems: merged,
        updatedAt: new Date().toISOString(),
      } satisfies RoleState);
    });
  } catch (err) {
    // Fail-open, and now that includes losing the lock race: a memo written after the writes have
    // already succeeded must never turn a successful run into a failed one.
    console.warn(`[role-state] could not write ${role}: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * The write seam.
 *
 * Injected rather than called directly, for the same reason `PendingHumanStore` is: **a pipeline that
 * writes to a default location on disk whether or not you asked is a surprise**, and surprises on the
 * write path are the expensive kind. Omit it and the run keeps no per-role memory at all.
 *
 * This was not hypothetical. The first version of this module wrote unconditionally to
 * `STATE_DIR/roles`, and the test suite — which calls `runPipeline` directly — quietly populated the
 * repo's own state directory, which then leaked into prompts built later in the same run and set off
 * cassette-drift warnings across a provider recording that had not changed.
 */
export interface RoleStateStore {
  record(role: RoleArchetype, items: RoleOpenItem[]): void;
}

/** Writes under `dir`, or under the configured state directory when omitted. */
export function fileRoleStateStore(dir?: string): RoleStateStore {
  return {
    record(role, items) {
      const previous = overrideDir;
      if (dir) overrideDir = dir;
      try {
        recordRoleWork(role, items);
      } finally {
        overrideDir = previous;
      }
    },
  };
}

/** Roles that have anything worth injecting. */
export function loadRoleStates(): Map<RoleArchetype, RoleState> {
  const out = new Map<RoleArchetype, RoleState>();
  for (const role of ROLE_ARCHETYPES) {
    const s = readRoleState(role);
    if (s.context.trim() || s.openItems.length) out.set(role, s);
  }
  return out;
}

/**
 * The per-person state lines the roster block appends.
 *
 * Deliberately terse and capped: this sits directly under the taxonomy in the prompt, and a roster
 * that outweighs the rules beside it is how a prompt stops working without anyone editing the rules.
 */
export function roleStateLines(role: unknown, name: string): string[] {
  if (!isRoleArchetype(role)) return [];
  const s = readRoleState(role);
  const lines: string[] = [];

  if (s.context.trim()) lines.push(`    context: ${s.context.trim().slice(0, 200)}`);
  if (s.openItems.length) {
    const titles = s.openItems.map((i) => (i.taskId ? `${i.title} (${i.taskId})` : i.title)).join('; ');
    lines.push(`    already open for ${name}: ${titles.slice(0, 300)}`);
  }
  return lines;
}
