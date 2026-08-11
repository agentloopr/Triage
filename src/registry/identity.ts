/**
 * Identity and routing lookups — the layer that turns free text into a canonical list key or member
 * name, and nothing else.
 *
 * **This module never returns a tracker id.** That is the rule that makes the tracker abstraction
 * real: the pipeline reasons in names and list keys, and only an adapter translates those into
 * whatever the tracker calls them. The system this came from resolved to numeric tracker ids here,
 * which leaked ClickUp into every gate that touched routing.
 *
 * Lookups are tolerant but never fuzzy. A key that differs by case or trailing decoration resolves;
 * a genuinely unknown key returns undefined and the routing gate HOLDs it. Guessing here would turn
 * a question for a human into a silent mis-route.
 */
import { type CompiledMember, type CompiledRoute, getMembers, getRoutes } from './opsRegistry';
import { getValidAssigneeAdditions, resolveListAlias, resolveNameAlias } from '../state/corrections';

export const normalizeListKey = (s: string): string =>
  s.trim().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').toLowerCase();

export const normalizeMemberName = (s: string): string =>
  s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/**
 * Find a route by key. Active routes only — a completed project's key stops resolving for NEW
 * routing, which is how a finished workstream naturally falls out of the pipeline.
 */
export function findRouteByKey(listKey: string | undefined | null): CompiledRoute | undefined {
  if (!listKey) return undefined;
  const routes = getRoutes();
  const n = normalizeListKey(listKey);

  const direct = routes.find((r) => normalizeListKey(r.key) === n);
  if (direct) return direct;

  // A human may have taught us that "internal tools" means the "platform" list.
  const canonical = resolveListAlias(n);
  if (!canonical) return undefined;
  return routes.find((r) => normalizeListKey(r.key) === normalizeListKey(canonical));
}

/** As above, but also searches completed/archived routes — for history and display, never routing. */
export function findRouteByKeyIncludingInactive(listKey: string | undefined | null): CompiledRoute | undefined {
  if (!listKey) return undefined;
  const routes = getRoutes({ includeInactive: true });
  const n = normalizeListKey(listKey);

  const direct = routes.find((r) => normalizeListKey(r.key) === n);
  if (direct) return direct;

  const canonical = resolveListAlias(n);
  if (!canonical) return undefined;
  return routes.find((r) => normalizeListKey(r.key) === normalizeListKey(canonical));
}

/** First route whose pattern matches the text, or null when nothing does. Active routes only. */
export function routeTitleToList(title: string): CompiledRoute | null {
  for (const r of getRoutes()) if (r.re.test(title)) return r;
  return null;
}

/**
 * Who may own work on this route: the registry's list, plus anyone a human has since added.
 *
 * Returns member NAMES. The corrections half is what lets "Rowan is on growth now" take effect
 * without a registry edit — the routing gate consults this, so the next run stops holding.
 */
export function getEffectiveValidAssignees(route: Pick<CompiledRoute, 'key' | 'validAssignees'>): string[] {
  return [...new Set([...route.validAssignees, ...getValidAssigneeAdditions(route.key)])];
}

/** Resolve a spoken/typed name to a canonical roster name, via aliases if needed. */
export function findMemberByName(name: string | undefined | null): CompiledMember | undefined {
  if (!name) return undefined;
  const members = getMembers();
  const n = normalizeMemberName(name);

  const direct = members.find((m) => normalizeMemberName(m.name) === n);
  if (direct) return direct;

  // First-name match, but only when it is unambiguous — two Alexes must reach a human, not a guess.
  const firstNameMatches = members.filter((m) => normalizeMemberName(m.name).split(' ')[0] === n);
  if (firstNameMatches.length === 1) return firstNameMatches[0];

  const canonical = resolveNameAlias(n);
  if (!canonical) return undefined;
  return members.find((m) => normalizeMemberName(m.name) === normalizeMemberName(canonical));
}

/** The assignee a route implies for this text: the technical owner when it matches, else the default. */
export function resolveRouteAssignee(route: CompiledRoute, title: string): string | undefined {
  if (route.technicalRe && route.technicalAssignee && route.technicalRe.test(title)) {
    return route.technicalAssignee;
  }
  return route.defaultAssignee;
}
