/**
 * Runtime-editable org registry — the roster and project→list routing, in one hand-editable JSON
 * file. Edit it, and the next call sees the change. No restart, no redeploy, no code edit. That is
 * the nicest thing in this repo to demo: change an assignee, re-run, watch routing change.
 *
 * Two behaviours are load-bearing and were ported deliberately:
 *
 * **Degraded mode is fail-CLOSED for writers.** If the file is missing or unparseable, readers fall
 * back to an empty seed with a loud, re-firing warning — but writers refuse outright. A write while
 * degraded would persist "nobody exists" as the new source of truth and erase the very signal that
 * something was wrong: the file would then exist and parse, and the outage would look resolved.
 *
 * **One bad row never nukes routing.** An invalid regex in one route is skipped with a warning
 * rather than throwing, so a typo in a hand edit degrades one route instead of the whole system.
 *
 * Schema note vs. the internal version: members carry `externalIds: Record<string,string>` rather
 * than a single numeric tracker id. That is what lets one registry serve ClickUp and Linear at once,
 * and it fixes a real bug — the old code used `clickupId > 0` to mean "resolvable", which quietly
 * conflated "this member has no id" with "this member's id is 0".
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { OPS_REGISTRY_PATH } from '../config';
import { atomicWriteJson, makeFifoLock, readJsonOrNull } from '../state/jsonStore';

// ── Serialized shape (mirrors the JSON on disk) ──────────────────────────────

/**
 * Role archetypes. These are *profiles* that shape routing, assignment and prompt context. On the
 * default path they are not running agents at all; with the agent layer on they also become the
 * read-only role agents in `src/agents/`. Orchestration above them is deterministic code
 * (`selectForDelegation`), not a model.
 *
 * The union values are also the `config/roles/<name>.md` filenames; keep them in lockstep.
 */
export const ROLE_ARCHETYPES = [
  'engineer',
  'designer',
  'product-manager',
  'qa',
  'marketer',
  'sales-gtm',
  'delivery-lead',
  'founder-exec',
] as const;

export type RoleArchetype = (typeof ROLE_ARCHETYPES)[number];

export function isRoleArchetype(v: unknown): v is RoleArchetype {
  return typeof v === 'string' && (ROLE_ARCHETYPES as readonly string[]).includes(v);
}

export interface RegistryMember {
  /** Canonical key. The pipeline speaks these; only adapters ever see the ids below. */
  name: string;
  /** Per-tracker ids, e.g. `{ clickup: "12345678", linear: "usr_abc" }`. */
  externalIds: Record<string, string>;
  /** Per-channel ids, e.g. `{ slack: "U123" }`. */
  channelIds?: Record<string, string>;
  email: string;
  role: RoleArchetype;
  defaultProjects: string[];
  githubUsername?: string | null;
  status?: 'active' | 'offboarded';
}

export interface RegistryRoute {
  key: string;
  /** e.g. `{ clickupList: "901…", linearTeam: "TEAM" }`. */
  externalIds: Record<string, string>;
  /** RegExp SOURCE string — a RegExp object cannot serialize. Compiled at load. */
  pattern: string;
  patternFlags?: string;
  defaultAssignee?: string | null;
  technicalAssignee?: string | null;
  technicalPattern?: string | null;
  technicalPatternFlags?: string;
  /** Member NAMES. Offboarded and unknown names are dropped at compile time. */
  validAssignees: string[];
  /** The list's real status vocabulary. The routing gate consults it; adapters enforce it. */
  validStatuses?: string[];
  preferredRoles?: RoleArchetype[];
  status?: 'active' | 'completed' | 'archived';
}

export interface OpsRegistry {
  version: 1;
  updatedAt: string;
  members: RegistryMember[];
  routes: RegistryRoute[];
  log: RegistryLogEntry[];
}

export interface RegistryLogEntry {
  ts: string;
  by?: string;
  kind: string;
  summary: string;
}

// ── Compiled shape (what the pipeline sees) ──────────────────────────────────

export interface CompiledMember extends Omit<RegistryMember, 'status'> {
  status: 'active' | 'offboarded';
}

export interface CompiledRoute {
  key: string;
  externalIds: Record<string, string>;
  re: RegExp;
  technicalRe?: RegExp;
  /** Resolved member NAMES — never ids. Offboarded members have already dropped out. */
  defaultAssignee?: string;
  technicalAssignee?: string;
  validAssignees: string[];
  validStatuses?: string[];
  preferredRoles?: RoleArchetype[];
  status: 'active' | 'completed' | 'archived';
}

export const EMPTY_REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  members: [],
  routes: [],
  log: [],
};

// ── Load + mtime cache ───────────────────────────────────────────────────────

let cache: { mtimeMs: number; raw: OpsRegistry; members: CompiledMember[]; routes: CompiledRoute[] } | null =
  null;

let degraded = false;
let warnedAtMs = 0;
let everWarned = false;
const REWARN_INTERVAL_MS = 5 * 60 * 1000;

let onDegraded: ((msg: string) => void) | null = null;

/** Injected, not imported, so this module stays free of any notification dependency. */
export function setOpsRegistryDegradedNotifier(fn: ((msg: string) => void) | null): void {
  onDegraded = fn;
}

/**
 * Point the registry at a different file.
 *
 * `OPS_REGISTRY_PATH` is resolved once at import time, so setting the env var later has no effect —
 * which is exactly the kind of thing that makes a test pass against the wrong file and look fine.
 * Tests and per-scenario fixtures use this instead.
 */
let overridePath: string | null = null;

export function setOpsRegistryPath(path: string | null): void {
  overridePath = path;
  invalidateOpsRegistryCache();
}

function registryPath(explicit?: string): string {
  return explicit ?? overridePath ?? OPS_REGISTRY_PATH;
}

export class OpsRegistryDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsRegistryDegradedError';
  }
}

/**
 * The one call every write-path gate should make. Refreshes the degraded flag for *this* tick and
 * returns a human-readable reason, or null when healthy. Do not read a cached flag instead — it is
 * only accurate immediately after a load.
 */
export function opsRegistryDegradedReason(explicitPath?: string): string | null {
  const path = registryPath(explicitPath);
  loadOpsRegistry(path);
  return degraded
    ? `ops-registry unavailable (${path}) — running on the empty fallback seed, nobody is in the roster`
    : null;
}

function warnDegraded(msg: string): void {
  degraded = true;
  const now = Date.now();
  // Loud on the first hit, then re-loud periodically. A once-ever warning is trivially missed in
  // logs nobody tails, and running on an empty roster must be impossible to miss.
  if (!everWarned || now - warnedAtMs >= REWARN_INTERVAL_MS) {
    console.error(`[ops-registry] DEGRADED — ${msg}`);
    everWarned = true;
    warnedAtMs = now;
    try {
      onDegraded?.(`[ops-registry] DEGRADED — ${msg}`);
    } catch (err) {
      console.error(`[ops-registry] degraded-notifier itself failed: ${(err as Error)?.message ?? err}`);
    }
  }
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function compileOpsRegistry(raw: OpsRegistry): {
  members: CompiledMember[];
  routes: CompiledRoute[];
} {
  const members: CompiledMember[] = (raw.members ?? []).map((m) => ({
    ...m,
    externalIds: { ...(m.externalIds ?? {}) },
    defaultProjects: [...(m.defaultProjects ?? [])],
    status: m.status === 'offboarded' ? 'offboarded' : 'active',
  }));

  // Active members only — so offboarding a person automatically removes them from every default and
  // valid-assignee set, which is what makes it bite in the routing gate rather than needing N edits.
  const active = new Map<string, string>();
  for (const m of members) {
    if (m.status !== 'offboarded') active.set(normalizeName(m.name), m.name);
  }
  const resolve = (name?: string | null): string | undefined =>
    name ? active.get(normalizeName(name)) : undefined;

  const routes: CompiledRoute[] = [];
  for (const r of raw.routes ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, r.patternFlags ?? 'i');
    } catch (err) {
      console.warn(
        `[ops-registry] route "${r.key}" has an invalid pattern (${(err as Error)?.message ?? err}) — skipped`
      );
      continue; // fault isolation: one bad row never nukes routing
    }

    let technicalRe: RegExp | undefined;
    if (r.technicalPattern) {
      try {
        technicalRe = new RegExp(r.technicalPattern, r.technicalPatternFlags ?? 'i');
      } catch {
        technicalRe = undefined;
      }
    }

    const defaultAssignee = resolve(r.defaultAssignee);
    const technicalAssignee = resolve(r.technicalAssignee);
    routes.push({
      key: r.key,
      externalIds: { ...(r.externalIds ?? {}) },
      re,
      ...(technicalRe ? { technicalRe } : {}),
      ...(defaultAssignee ? { defaultAssignee } : {}),
      ...(technicalAssignee ? { technicalAssignee } : {}),
      validAssignees: (r.validAssignees ?? [])
        .map((n) => resolve(n))
        .filter((n): n is string => n != null),
      ...(r.validStatuses ? { validStatuses: [...r.validStatuses] } : {}),
      ...(r.preferredRoles ? { preferredRoles: [...r.preferredRoles] } : {}),
      status: r.status === 'completed' ? 'completed' : r.status === 'archived' ? 'archived' : 'active',
    });
  }

  return { members, routes };
}

export function loadOpsRegistry(explicitPath?: string): OpsRegistry {
  const path = registryPath(explicitPath);
  try {
    if (!existsSync(path)) {
      warnDegraded(`${path} does not exist — using the empty seed. Nobody is in the roster.`);
      return EMPTY_REGISTRY;
    }
    const { mtimeMs } = statSync(path);
    if (cache && cache.mtimeMs === mtimeMs) {
      degraded = false;
      return cache.raw;
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as OpsRegistry;
    if (!raw || !Array.isArray(raw.members) || !Array.isArray(raw.routes)) {
      throw new Error('registry is missing members[] / routes[]');
    }
    const { members, routes } = compileOpsRegistry(raw);
    cache = { mtimeMs, raw, members, routes };
    degraded = false;
    return raw;
  } catch (err) {
    warnDegraded(`failed to load ${path} (${(err as Error)?.message ?? err}) — using the empty seed`);
    return EMPTY_REGISTRY;
  }
}

function loadCompiled(path: string): { members: CompiledMember[]; routes: CompiledRoute[] } {
  loadOpsRegistry(path);
  if (cache && !degraded) return { members: cache.members, routes: cache.routes };
  return compileOpsRegistry(EMPTY_REGISTRY);
}

export function getMembers(opts?: { includeOffboarded?: boolean; path?: string }): CompiledMember[] {
  const all = loadCompiled(registryPath(opts?.path)).members;
  return opts?.includeOffboarded ? all : all.filter((m) => m.status !== 'offboarded');
}

export function getRoutes(opts?: { includeInactive?: boolean; path?: string }): CompiledRoute[] {
  const all = loadCompiled(registryPath(opts?.path)).routes;
  return opts?.includeInactive ? all : all.filter((r) => r.status === 'active');
}

export function invalidateOpsRegistryCache(): void {
  cache = null;
  degraded = false;
  everWarned = false;
  warnedAtMs = 0;
}

/**
 * Read a tracker-specific id, failing with a message that says exactly what to add and where.
 * A missing id is a config error, and a config error should never surface as `undefined` three
 * frames away from its cause.
 */
export function externalId(
  entity: { key?: string; name?: string; externalIds: Record<string, string> },
  idKey: string
): string {
  const v = entity.externalIds?.[idKey];
  if (!v) {
    const label = entity.key ?? entity.name ?? '(unnamed)';
    throw new Error(`"${label}" has no "${idKey}" id in the ops registry — add externalIds.${idKey}`);
  }
  return v;
}

// ── Write path ───────────────────────────────────────────────────────────────

const withWriteLock = makeFifoLock();

/**
 * Fresh read for a write — deliberately NOT falling back to the empty seed the way the read path
 * does. See the header: writing while degraded is what makes a transient outage permanent.
 */
function readFreshForWrite(path: string): OpsRegistry | null {
  const raw = readJsonOrNull<OpsRegistry>(path, { quarantine: false });
  if (raw && Array.isArray(raw.members) && Array.isArray(raw.routes)) return raw;
  return null;
}

export async function mutateRegistry(
  mutator: (reg: OpsRegistry) => string,
  actor: string,
  explicitPath?: string
): Promise<string> {
  const path = registryPath(explicitPath);
  return withWriteLock(async () => {
    const reg = readFreshForWrite(path);
    if (!reg) {
      throw new OpsRegistryDegradedError(
        `refusing to write ${path}: it is missing or unparseable right now. Writing would persist an ` +
          `empty roster as the new source of truth. Restore the file, then retry.`
      );
    }
    reg.version = 1;
    if (!Array.isArray(reg.log)) reg.log = [];
    const summary = mutator(reg);
    reg.updatedAt = new Date().toISOString();
    reg.log.push({ ts: reg.updatedAt, by: actor, kind: 'registry_update', summary });
    if (reg.log.length > 500) reg.log = reg.log.slice(-500);
    atomicWriteJson(path, reg);
    invalidateOpsRegistryCache();
    return summary;
  });
}
