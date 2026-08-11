import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type OpsRegistry,
  OpsRegistryDegradedError,
  compileOpsRegistry,
  externalId,
  getMembers,
  getRoutes,
  invalidateOpsRegistryCache,
  mutateRegistry,
  opsRegistryDegradedReason,
  setOpsRegistryDegradedNotifier,
} from './opsRegistry';

const DIR = join(tmpdir(), `registry-test-${process.pid}`);
const PATH = join(DIR, 'ops-registry.json');

const REG: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    {
      name: 'Avery Chen',
      externalIds: { clickup: '1001', linear: 'usr_avery' },
      channelIds: { slack: 'U001' },
      email: 'avery@example.com',
      role: 'engineer',
      defaultProjects: ['backend'],
    },
    {
      name: 'Rowan Diaz',
      externalIds: { clickup: '1002' },
      email: 'rowan@example.com',
      role: 'designer',
      defaultProjects: ['design'],
    },
    {
      name: 'Sky Patel',
      externalIds: { clickup: '1003' },
      email: 'sky@example.com',
      role: 'qa',
      defaultProjects: [],
      status: 'offboarded',
    },
  ],
  routes: [
    {
      key: 'backend',
      externalIds: { clickupList: '900001', linearTeam: 'BE' },
      pattern: 'backend|api|server',
      defaultAssignee: 'Avery Chen',
      validAssignees: ['Avery Chen', 'Sky Patel'],
      validStatuses: ['to do', 'in progress', 'complete'],
      preferredRoles: ['engineer'],
    },
    {
      key: 'design',
      externalIds: { clickupList: '900002' },
      pattern: 'design|figma',
      defaultAssignee: 'Rowan Diaz',
      validAssignees: ['Rowan Diaz'],
    },
  ],
  log: [],
};

function write(reg: OpsRegistry, mtimeSeconds?: number): void {
  writeFileSync(PATH, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  // Filesystem mtime resolution can collapse two fast writes into one timestamp, which would make
  // the cache test pass for the wrong reason. Force a distinct mtime instead.
  if (mtimeSeconds != null) utimesSync(PATH, mtimeSeconds, mtimeSeconds);
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  invalidateOpsRegistryCache();
  setOpsRegistryDegradedNotifier(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

describe('compile', () => {
  it('resolves assignee names and keeps them as NAMES, never ids', () => {
    const { routes } = compileOpsRegistry(REG);
    const backend = routes.find((r) => r.key === 'backend');
    expect(backend?.defaultAssignee).toBe('Avery Chen');
    expect(backend?.validAssignees).toContain('Avery Chen');
  });

  // Offboarding one person must take effect everywhere at once, not require N route edits.
  it('drops an offboarded member out of every assignee set automatically', () => {
    const { routes } = compileOpsRegistry(REG);
    expect(routes.find((r) => r.key === 'backend')?.validAssignees).not.toContain('Sky Patel');
  });

  it('matches names case- and separator-insensitively', () => {
    const reg = structuredClone(REG);
    reg.routes[0]!.defaultAssignee = 'avery_chen';
    expect(compileOpsRegistry(reg).routes[0]?.defaultAssignee).toBe('Avery Chen');
  });

  it('drops an unknown assignee rather than inventing one', () => {
    const reg = structuredClone(REG);
    reg.routes[0]!.validAssignees = ['Avery Chen', 'Nobody At All'];
    expect(compileOpsRegistry(reg).routes[0]?.validAssignees).toEqual(['Avery Chen']);
  });

  // Fault isolation: a typo in one hand-edited pattern must not take routing down entirely.
  it('skips a route with an invalid pattern and keeps the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = structuredClone(REG);
    reg.routes[0]!.pattern = '([unclosed';
    const { routes } = compileOpsRegistry(reg);
    expect(routes.map((r) => r.key)).toEqual(['design']);
  });

  it('compiles the pattern into a usable RegExp', () => {
    const backend = compileOpsRegistry(REG).routes.find((r) => r.key === 'backend');
    expect(backend?.re.test('the API server work')).toBe(true);
    expect(backend?.re.test('a figma file')).toBe(false);
  });
});

describe('load + mtime cache', () => {
  it('picks up a hand edit on the next call, with no restart', () => {
    write(REG, 1_700_000_000);
    expect(getRoutes({ path: PATH }).map((r) => r.key)).toEqual(['backend', 'design']);

    const edited = structuredClone(REG);
    edited.routes.push({
      key: 'growth',
      externalIds: { clickupList: '900003' },
      pattern: 'growth|campaign',
      validAssignees: ['Rowan Diaz'],
    });
    write(edited, 1_700_000_100);

    expect(getRoutes({ path: PATH }).map((r) => r.key)).toEqual(['backend', 'design', 'growth']);
  });

  it('hides offboarded members and inactive routes by default, and shows them on request', () => {
    const reg = structuredClone(REG);
    reg.routes[1]!.status = 'archived';
    write(reg, 1_700_000_200);

    expect(getMembers({ path: PATH }).map((m) => m.name)).toEqual(['Avery Chen', 'Rowan Diaz']);
    expect(getMembers({ path: PATH, includeOffboarded: true })).toHaveLength(3);
    expect(getRoutes({ path: PATH }).map((r) => r.key)).toEqual(['backend']);
    expect(getRoutes({ path: PATH, includeInactive: true })).toHaveLength(2);
  });
});

describe('degraded mode', () => {
  it('reports a missing file loudly and serves an empty roster', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reports: string[] = [];
    setOpsRegistryDegradedNotifier((m) => reports.push(m));

    expect(opsRegistryDegradedReason(PATH)).toContain('nobody is in the roster');
    expect(getMembers({ path: PATH })).toEqual([]);
    expect(reports[0]).toContain('DEGRADED');
  });

  it('reports a corrupt file rather than treating it as absent', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(PATH, '{ not json', 'utf8');
    expect(opsRegistryDegradedReason(PATH)).not.toBeNull();
  });

  it('says healthy once the file is valid', () => {
    write(REG, 1_700_000_300);
    expect(opsRegistryDegradedReason(PATH)).toBeNull();
  });

  // The important one. A write while degraded would persist the empty roster, and the outage would
  // then look resolved because the file exists and parses.
  it('REFUSES to write while degraded instead of persisting an empty roster', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      mutateRegistry((r) => {
        r.members = [];
        return 'wipe';
      }, 'test', PATH)
    ).rejects.toBeInstanceOf(OpsRegistryDegradedError);
  });
});

describe('mutateRegistry', () => {
  it('applies the mutation, stamps the log, and leaves valid JSON on disk', async () => {
    write(REG, 1_700_000_400);

    const summary = await mutateRegistry(
      (r) => {
        r.members.push({
          name: 'Jules Kim',
          externalIds: { clickup: '1004' },
          email: 'jules@example.com',
          role: 'product-manager',
          defaultProjects: [],
        });
        return 'added Jules Kim';
      },
      'test-actor',
      PATH
    );

    expect(summary).toBe('added Jules Kim');
    const onDisk = JSON.parse(readFileSync(PATH, 'utf8')) as OpsRegistry;
    expect(onDisk.members.map((m) => m.name)).toContain('Jules Kim');
    expect(onDisk.log.at(-1)).toMatchObject({ by: 'test-actor', summary: 'added Jules Kim' });
    expect(getMembers({ path: PATH }).map((m) => m.name)).toContain('Jules Kim');
  });

  it('serializes concurrent mutations instead of losing updates', async () => {
    write(REG, 1_700_000_500);
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((tag) =>
        mutateRegistry(
          (r) => {
            r.routes.push({
              key: `route-${tag}`,
              externalIds: {},
              pattern: tag,
              validAssignees: [],
            });
            return `added ${tag}`;
          },
          'test',
          PATH
        )
      )
    );
    const onDisk = JSON.parse(readFileSync(PATH, 'utf8')) as OpsRegistry;
    expect(onDisk.routes.map((r) => r.key)).toEqual(
      expect.arrayContaining(['route-a', 'route-b', 'route-c', 'route-d'])
    );
  });
});

describe('externalId', () => {
  it('returns the tracker-specific id', () => {
    const m = compileOpsRegistry(REG).members[0]!;
    expect(externalId(m, 'clickup')).toBe('1001');
    expect(externalId(m, 'linear')).toBe('usr_avery');
  });

  // A missing id is a config error; it must not surface as `undefined` three frames later.
  it('throws a message naming the entity and the exact key to add', () => {
    const m = compileOpsRegistry(REG).members[1]!; // Rowan has no linear id
    expect(() => externalId(m, 'linear')).toThrow(/Rowan Diaz.*externalIds\.linear/);
  });
});
