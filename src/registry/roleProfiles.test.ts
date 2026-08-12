import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_ARCHETYPES, type OpsRegistry, setOpsRegistryPath } from './opsRegistry';
import {
  getRoleProfile,
  invalidateRoleProfileCache,
  loadRoleProfiles,
  roleRosterBlock,
  rosterRoutingKeywords,
  setRolesDir,
} from './roleProfiles';

/**
 * Role profiles are the PRD's headline design change, and the thing most likely to quietly become
 * decoration. `config/roles/` sat empty for three phases while two prompts already told the model to
 * consult "the role profiles" — so these tests check that the files exist, parse, and reach the
 * prompt, not merely that the loader compiles.
 */
const DIR = join(tmpdir(), `roles-${process.pid}`);

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: {}, email: 'a@x.com', role: 'engineer', defaultProjects: [] },
    { name: 'Rowan Diaz', externalIds: {}, email: 'r@x.com', role: 'designer', defaultProjects: [] },
  ],
  routes: [],
  log: [],
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'r.json'), JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(join(DIR, 'r.json'));
  invalidateRoleProfileCache();
});
afterEach(() => {
  setOpsRegistryPath(null);
  setRolesDir(null);
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

describe('the shipped profiles', () => {
  it('ships exactly one profile per archetype, and every one parses', () => {
    const loaded = loadRoleProfiles();
    expect([...loaded.keys()].sort()).toEqual([...ROLE_ARCHETYPES].sort());
  });

  it.each(ROLE_ARCHETYPES)('%s defines every required section with real content', (role) => {
    const p = getRoleProfile(role);
    expect(p).not.toBeNull();
    expect(p!.title.length).toBeGreaterThanOrEqual(2); // "QA" is a legitimate title
    expect(p!.owns.length).toBeGreaterThan(40);
    expect(p!.watchesFor.length).toBeGreaterThan(40);
    expect(p!.updateStyle.length).toBeGreaterThan(20);
    expect(p!.routingKeywords.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps the filenames in lockstep with the archetype union', () => {
    // The union is what the registry validates a member's `role` against; a profile named anything
    // else is unreachable no matter how good it is.
    for (const role of ROLE_ARCHETYPES) expect(getRoleProfile(role)?.role).toBe(role);
  });

  // Deliberately no "names no real person or product" assertion here: CI's identifier scan already
  // covers every *.md in the repo, and restating the deny-list in a test file only means the test
  // file itself trips the scan.
});

describe('the roster block the prompts inject', () => {
  it('carries each member with what their role owns', () => {
    const block = roleRosterBlock().join('\n');
    expect(block).toContain('Avery Chen — Engineer:');
    expect(block).toContain('Rowan Diaz — Designer:');
  });

  /**
   * Compact on purpose. The production system splices roughly ten kilobytes of persona prose per
   * agent; the taxonomy sitting next to it is the text that actually decides the answer, and a
   * roster that outweighs the rules is how a prompt stops working with no rule ever being edited.
   */
  it('stays short enough not to drown the taxonomy it sits next to', () => {
    expect(roleRosterBlock().join('\n').length).toBeLessThan(1_200);
  });

  it('emits nothing at all when the roster is empty, rather than a bare header', () => {
    writeFileSync(join(DIR, 'r.json'), JSON.stringify({ ...REGISTRY, members: [] }), 'utf8');
    setOpsRegistryPath(join(DIR, 'r.json'));
    expect(roleRosterBlock()).toEqual([]);
  });

  it('collects routing keywords for the archetypes actually on the roster', () => {
    const keywords = rosterRoutingKeywords();
    expect(keywords).toContain('api'); // engineer
    expect(keywords).toContain('ui'); // designer
    expect(keywords).not.toContain('fundraising'); // founder-exec is not on this roster
  });
});

/**
 * Fails open. A badly edited markdown file makes the prompt thinner and says so; it does not take
 * down a run. Nothing here can cause a wrong write — the routing gate still validates every assignee
 * against the registry afterwards.
 */
describe('degradation', () => {
  it('warns and carries on when a profile directory is missing entirely', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setRolesDir(join(DIR, 'nope'));

    expect(loadRoleProfiles().size).toBe(0);
    expect(warn.mock.calls[0]?.[0]).toMatch(/profile\(s\) unavailable/);
  });

  it('still names every member when profiles cannot be read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setRolesDir(join(DIR, 'nope'));

    const block = roleRosterBlock().join('\n');
    expect(block).toContain('Avery Chen');
    expect(block).toContain('Rowan Diaz');
  });

  it('rejects a profile missing a required section rather than half-loading it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rolesDir = join(DIR, 'roles');
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, 'engineer.md'), '# Engineer\n\n## Owns\nThings.\n', 'utf8');
    setRolesDir(rolesDir);

    expect(getRoleProfile('engineer')).toBeNull();
  });
});
