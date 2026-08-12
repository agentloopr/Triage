/**
 * Role profiles — the archetypes that replace per-person agents.
 *
 * The system this was extracted from runs one agent per team member, each with its own persona file,
 * state and tool access. That does not generalize: the profiles are full of one company's people, and
 * a reader cannot use them. Archetypes do generalize, and they de-identify by construction — there is
 * no real name to strip because the concept itself is generic.
 *
 * **These are load-bearing, not documentation.** A profile is read at prompt-build time and shapes
 * how work is routed. That is deliberate: `config/roles/` existed as an empty directory for three
 * phases while two prompts already referred to "the role profiles", and a promise in a prompt with
 * nothing behind it is worse than no promise, because the model acts on it.
 *
 * A profile is the **static** half — what this kind of person owns, and how they phrase an update.
 * The changing half lives in `state/roleState.ts`: what they currently have open, plus whatever
 * context a human wants attached to them. Both halves land in the same roster block, because from
 * the prompt's point of view "Avery is an engineer" and "Avery already picked up the rate limiting"
 * are the same kind of fact.
 *
 * Missing or malformed profiles **fail open**: the prompt loses context and says so in a warning,
 * rather than a run dying because a markdown file was edited badly. Nothing here can produce a wrong
 * write — the routing gate still validates every assignee against the registry afterwards.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_ARCHETYPES, type RoleArchetype, getMembers } from './opsRegistry';
import { roleStateLines } from '../state/roleState';
import { ROLES_DIR } from '../config';

export interface RoleProfile {
  role: RoleArchetype;
  title: string;
  owns: string;
  watchesFor: string;
  routingKeywords: string[];
  updateStyle: string;
}

/** The sections every profile must define. Order is the file's, not enforced. */
const REQUIRED = ['Owns', 'Watches for', 'Routing keywords', 'Update style'] as const;

let cache: Map<RoleArchetype, RoleProfile> | null = null;
let overrideDir: string | null = null;

/** Point at a different directory — for tests and for a consumer shipping their own profiles. */
export function setRolesDir(dir: string | null): void {
  overrideDir = dir;
  cache = null;
}

function dir(): string {
  return overrideDir ?? ROLES_DIR;
}

function parseProfile(role: RoleArchetype, markdown: string): RoleProfile | null {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!title) return null;

  const sections = new Map<string, string>();
  // Split on `## ` headings; everything until the next heading is that section's body.
  const parts = markdown.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    sections.set(part.slice(0, nl).trim(), part.slice(nl + 1).trim().replace(/\s*\n\s*/g, ' '));
  }

  for (const name of REQUIRED) {
    if (!sections.get(name)) return null;
  }

  return {
    role,
    title,
    owns: sections.get('Owns')!,
    watchesFor: sections.get('Watches for')!,
    routingKeywords: sections
      .get('Routing keywords')!
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    updateStyle: sections.get('Update style')!,
  };
}

export function loadRoleProfiles(): Map<RoleArchetype, RoleProfile> {
  if (cache) return cache;

  const loaded = new Map<RoleArchetype, RoleProfile>();
  const missing: string[] = [];

  for (const role of ROLE_ARCHETYPES) {
    const path = join(dir(), `${role}.md`);
    if (!existsSync(path)) {
      missing.push(role);
      continue;
    }
    const parsed = parseProfile(role, readFileSync(path, 'utf8'));
    if (parsed) loaded.set(role, parsed);
    else missing.push(`${role} (missing a required section)`);
  }

  if (missing.length) {
    console.warn(
      `[roles] ${missing.length} profile(s) unavailable: ${missing.join(', ')} — routing context will be thinner. Expected in ${dir()}`
    );
  }

  cache = loaded;
  return loaded;
}

export function getRoleProfile(role: RoleArchetype): RoleProfile | null {
  return loadRoleProfiles().get(role) ?? null;
}

export function invalidateRoleProfileCache(): void {
  cache = null;
}

/**
 * The roster block the categorization and verification prompts inject.
 *
 * One line per person: name, archetype, and what that archetype owns, followed by that role's state
 * — the human-maintained context and what the pipeline already put on their plate. Deliberately
 * compact — the production system splices roughly ten kilobytes of persona prose per agent into its
 * prompts, and the taxonomy above it is the text that actually decides the answer. A roster that
 * outweighs the rules it sits next to is how a prompt stops working without anyone editing the rules.
 *
 * The state lines are what make a second meeting about the same work legible: without them every run
 * starts from an empty memory of who is already doing what.
 *
 * Returns `[]` when nothing can be loaded, so callers emit no header rather than an empty one.
 */
export function roleRosterBlock(): string[] {
  const members = getMembers();
  if (members.length === 0) return [];

  const profiles = loadRoleProfiles();
  const lines = members.flatMap((m) => {
    const p = profiles.get(m.role);
    const head = p ? `  ${m.name} — ${p.title}: ${firstSentence(p.owns)}` : `  ${m.name} — ${m.role}`;
    return [head, ...roleStateLines(m.role, m.name)];
  });

  return ['ROSTER (canonical names, with what each person\'s role owns):', ...lines];
}

/** Keywords for every archetype currently on the roster, for the routing hint. */
export function rosterRoutingKeywords(): string[] {
  const roles = new Set(getMembers().map((m) => m.role));
  const out = new Set<string>();
  for (const role of roles) {
    for (const k of getRoleProfile(role)?.routingKeywords ?? []) out.add(k);
  }
  return [...out];
}

function firstSentence(s: string): string {
  const end = s.indexOf('. ');
  return end === -1 ? s : s.slice(0, end);
}
