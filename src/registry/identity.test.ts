import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OpsRegistry, setOpsRegistryPath } from './opsRegistry';
import {
  findMemberByName,
  findRouteByKey,
  findRouteByKeyIncludingInactive,
  getEffectiveValidAssignees,
  normalizeListKey,
  resolveRouteAssignee,
  routeTitleToList,
} from './identity';
import { isKnownNotDuplicate, learnedFactsBlock, recordCorrection, recordNotDuplicate, setCorrectionsPath } from '../state/corrections';

const DIR = join(tmpdir(), `identity-test-${process.pid}`);
const REGISTRY_PATH = join(DIR, 'ops-registry.json');
const CORRECTIONS_PATH = join(DIR, 'corrections.json');

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: { clickup: '1' }, email: 'a@example.com', role: 'engineer', defaultProjects: [] },
    { name: 'Rowan Diaz', externalIds: { clickup: '2' }, email: 'r@example.com', role: 'designer', defaultProjects: [] },
    { name: 'Alex Stone', externalIds: { clickup: '3' }, email: 's@example.com', role: 'qa', defaultProjects: [] },
    { name: 'Alex Rivera', externalIds: { clickup: '4' }, email: 'v@example.com', role: 'marketer', defaultProjects: [] },
  ],
  routes: [
    {
      key: 'platform', externalIds: { clickupList: '900' }, pattern: 'platform|infra|deploy',
      defaultAssignee: 'Avery Chen', technicalAssignee: 'Avery Chen', technicalPattern: 'deploy',
      validAssignees: ['Avery Chen'], status: 'active',
    },
    {
      key: 'design', externalIds: { clickupList: '901' }, pattern: 'design|figma',
      defaultAssignee: 'Rowan Diaz', validAssignees: ['Rowan Diaz'], status: 'active',
    },
    {
      key: 'legacy migration', externalIds: { clickupList: '902' }, pattern: 'legacy',
      validAssignees: [], status: 'completed',
    },
  ],
  log: [],
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(REGISTRY, null, 2), 'utf8');
  // Both stores resolve their path at import time, so the env var is useless here — set the
  // override explicitly, or every assertion silently runs against the wrong file.
  setOpsRegistryPath(REGISTRY_PATH);
  setCorrectionsPath(CORRECTIONS_PATH);
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  rmSync(DIR, { recursive: true, force: true });
});

const routes = () => REGISTRY.routes;

describe('normalizeListKey', () => {
  it('is tolerant of case, spacing and trailing decoration', () => {
    expect(normalizeListKey('  Platform  ')).toBe('platform');
    expect(normalizeListKey('Platform (active)')).toBe('platform');
  });
});

describe('findRouteByKey', () => {
  it('resolves a key that differs only by case or decoration', () => {
    expect(findRouteByKey('PLATFORM')?.key).toBe('platform');
    expect(findRouteByKey('platform (current)')?.key).toBe('platform');
  });

  // Guessing here would turn a question for a human into a silent mis-route.
  it('returns undefined for a genuinely unknown key rather than fuzzy-matching', () => {
    expect(findRouteByKey('platfrm')).toBeUndefined();
    expect(findRouteByKey('')).toBeUndefined();
    expect(findRouteByKey(null)).toBeUndefined();
  });

  it('stops resolving a completed route for new routing, but still finds it for history', () => {
    expect(findRouteByKey('legacy migration')).toBeUndefined();
    expect(findRouteByKeyIncludingInactive('legacy migration')?.key).toBe('legacy migration');
  });

  it('resolves through a human-taught alias', async () => {
    expect(findRouteByKey('internal tools')).toBeUndefined();
    await recordCorrection({ kind: 'list_alias', alias: 'internal tools', canonical: 'platform' }, 'tester');
    expect(findRouteByKey('internal tools')?.key).toBe('platform');
  });
});

describe('routeTitleToList', () => {
  it('matches on the route pattern', () => {
    expect(routeTitleToList('deploy the new infra')?.key).toBe('platform');
    expect(routeTitleToList('update the figma file')?.key).toBe('design');
  });
  it('returns null when nothing matches', () => {
    expect(routeTitleToList('book the offsite venue')).toBeNull();
  });
  it('never matches a completed route', () => {
    expect(routeTitleToList('legacy cleanup')).toBeNull();
  });
});

describe('resolveRouteAssignee', () => {
  it('prefers the technical owner when the text matches the technical pattern', () => {
    const r = routes().find((x) => x.key === 'platform')!;
    const compiled = findRouteByKey('platform')!;
    expect(r.technicalPattern).toBe('deploy');
    expect(resolveRouteAssignee(compiled, 'deploy the release')).toBe('Avery Chen');
  });
  it('falls back to the default owner', () => {
    expect(resolveRouteAssignee(findRouteByKey('design')!, 'new figma mockups')).toBe('Rowan Diaz');
  });
});

describe('findMemberByName', () => {
  it('resolves an exact name regardless of case and separators', () => {
    expect(findMemberByName('avery_chen')?.name).toBe('Avery Chen');
  });

  it('resolves an unambiguous first name', () => {
    expect(findMemberByName('Rowan')?.name).toBe('Rowan Diaz');
  });

  // Two Alexes must reach a human rather than be resolved to whichever appears first.
  it('refuses an ambiguous first name instead of picking one', () => {
    expect(findMemberByName('Alex')).toBeUndefined();
  });

  it('resolves through a human-taught alias', async () => {
    await recordCorrection({ kind: 'name_alias', alias: 'av', canonical: 'Avery Chen' }, 'tester');
    expect(findMemberByName('av')?.name).toBe('Avery Chen');
  });
});

describe('getEffectiveValidAssignees — the feedback loop', () => {
  it('starts from the registry list alone', () => {
    expect(getEffectiveValidAssignees(findRouteByKey('design')!)).toEqual(['Rowan Diaz']);
  });

  // The headline claim: a human correction changes a later decision, with no code or registry edit.
  it('admits someone a human added, without a registry edit', async () => {
    await recordCorrection({ kind: 'valid_assignee', listKey: 'design', assigneeName: 'Avery Chen' }, 'tester');
    expect(getEffectiveValidAssignees(findRouteByKey('design')!)).toEqual(
      expect.arrayContaining(['Rowan Diaz', 'Avery Chen'])
    );
  });

  it('removes them again on a later correction', async () => {
    await recordCorrection({ kind: 'valid_assignee', listKey: 'design', assigneeName: 'Avery Chen' }, 'tester');
    await recordCorrection({ kind: 'remove_valid_assignee', listKey: 'design', assigneeName: 'Avery Chen' }, 'tester');
    expect(getEffectiveValidAssignees(findRouteByKey('design')!)).toEqual(['Rowan Diaz']);
  });
});

describe('not-duplicate corrections', () => {
  // Without this the pipeline re-proposes the same rejected duplicate forever, and the person who
  // corrected it once has to keep correcting it.
  it('remembers that two things are not the same work', async () => {
    expect(isKnownNotDuplicate('Billing retry fix', 't300')).toBe(false);
    await recordNotDuplicate('Billing retry fix', 't300', 'tester');
    expect(isKnownNotDuplicate('billing retry fix', 'T300')).toBe(true);
  });

  it('does not leak the correction to a different card', async () => {
    await recordNotDuplicate('Billing retry fix', 't300', 'tester');
    expect(isKnownNotDuplicate('Billing retry fix', 't999')).toBe(false);
  });

  it('is idempotent', async () => {
    await recordNotDuplicate('X', 't1', 'tester');
    await recordNotDuplicate('X', 't1', 'tester');
    expect(learnedFactsBlock().filter((l) => l.includes('t1'))).toHaveLength(1);
  });
});

describe('learnedFactsBlock', () => {
  it('renders notes, not-duplicate pairs and assignee additions for prompt injection', async () => {
    await recordCorrection({ kind: 'note', text: 'Solstice is a client, not a project', scope: 'design' }, 'tester');
    await recordNotDuplicate('Billing retry fix', 't300', 'tester');
    await recordCorrection({ kind: 'valid_assignee', listKey: 'design', assigneeName: 'Avery Chen' }, 'tester');

    const block = learnedFactsBlock().join('\n');
    expect(block).toContain('Solstice is a client');
    expect(block).toContain('[design]');
    expect(block).toContain('NOT the same work as card t300');
    expect(block).toContain('Avery Chen');
  });

  it('is empty on a fresh store', () => {
    expect(learnedFactsBlock()).toEqual([]);
  });
});
