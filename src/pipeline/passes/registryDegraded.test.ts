import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OpsRegistry, setOpsRegistryPath } from '../../registry/opsRegistry';
import { setCorrectionsPath } from '../../state/corrections';
import type { BoardTask } from '../../trackers';
import type { CategorizationItem } from '../parsing/categorizationManifest';
import { REGISTRY_DEGRADED_GATE, runContractCheck } from './contractCheck';

const DIR = join(tmpdir(), `degraded-test-${process.pid}`);
const REGISTRY_PATH = join(DIR, 'ops-registry.json');

const GOOD: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [{ name: 'Avery Chen', externalIds: { clickup: '1' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] }],
  routes: [{ key: 'backend', externalIds: {}, pattern: 'backend|api', defaultAssignee: 'Avery Chen', validAssignees: ['Avery Chen'], status: 'active' }],
  log: [],
};

const BOARD: BoardTask[] = [{ id: 't1', title: 'Existing', listKey: 'backend', assignees: ['Avery Chen'], status: 'to do' }];

const items: CategorizationItem[] = [1, 2, 3].map((n) => ({
  item: n,
  title: `Item ${n}`,
  category: 'NEW_TASK',
  list: 'backend',
  assignee: 'Avery Chen',
  finalDesc: 'a well-specified task that would otherwise sail through every gate',
  tier2Cited: false,
  raw: '',
}));

const inventoryItems = items.map((i) => ({
  number: i.item, title: i.title, desc: 'desc', timestamp: '', possibleMatchHint: '(none)',
}));

const run = () =>
  runContractCheck(
    { manifestItems: items, inventoryItems, tasks: BOARD, boardSnapshot: '', sourceSummary: '', sourceText: '' },
    // The blind read is never reached — the short-circuit happens first. If it IS reached, this throws.
    { runAgent: async () => { throw new Error('the blind read must not run while degraded'); } }
  );

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  setCorrectionsPath(join(DIR, 'corrections.json'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

/**
 * When the roster and routing file is unreadable, the pipeline holds the ENTIRE batch rather than
 * letting anything reach the writer.
 *
 * This is deliberately a global short-circuit and not a per-item gate. The human-resume path does not
 * re-check the registry, so a per-item hold would leave a route where approving a held card writes a
 * task that cannot be assigned to anyone — the failure would surface later, on someone else's board,
 * with no trace of why.
 */
describe('registry degraded — fail closed, whole batch', () => {
  it('holds every item when the registry file is missing', async () => {
    setOpsRegistryPath(join(DIR, 'does-not-exist.json'));
    const out = await run();

    expect(out.clean).toEqual([]);
    expect(out.held).toHaveLength(items.length);
    expect(out.held.every((h) => h.gate === REGISTRY_DEGRADED_GATE)).toBe(true);
  });

  it('holds every item when the registry file is corrupt', async () => {
    writeFileSync(REGISTRY_PATH, '{ this is not json', 'utf8');
    setOpsRegistryPath(REGISTRY_PATH);

    const out = await run();
    expect(out.clean).toEqual([]);
    expect(out.held).toHaveLength(items.length);
  });

  it('holds when the registry parses but has no members or routes array', async () => {
    writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, updatedAt: 'x' }), 'utf8');
    setOpsRegistryPath(REGISTRY_PATH);

    expect((await run()).clean).toEqual([]);
  });

  // The question is unanswerable per-item, so fanning it out would be noise a human learns to ignore.
  it('explains that this needs an ops fix rather than asking a per-item question', async () => {
    setOpsRegistryPath(join(DIR, 'does-not-exist.json'));
    const out = await run();

    expect(out.held[0]!.question).toContain('No answer is needed here');
    expect(out.held[0]!.question).toContain('re-run once the file is restored');
    // Every item shares one gate string, so the delivery layer can collapse them into one message.
    expect(new Set(out.held.map((h) => h.gate)).size).toBe(1);
  });

  it('carries each original item so nothing is lost on the resume path', async () => {
    setOpsRegistryPath(join(DIR, 'does-not-exist.json'));
    const out = await run();
    expect(out.held.map((h) => h.originalItem?.item)).toEqual([1, 2, 3]);
  });

  it('runs normally once the registry is readable again', async () => {
    writeFileSync(REGISTRY_PATH, JSON.stringify(GOOD), 'utf8');
    setOpsRegistryPath(REGISTRY_PATH);

    const out = await runContractCheck(
      { manifestItems: items, inventoryItems, tasks: BOARD, boardSnapshot: '', sourceSummary: '', sourceText: '' },
      { runAgent: async () => 'VERDICT_CATEGORY: NEW_TASK\nWORTH_A_CARD: real_task\nGROUNDED: yes\nROUTING_OK: yes\nRATIONALE: no match found.' }
    );

    expect(out.held.filter((h) => h.gate === REGISTRY_DEGRADED_GATE)).toEqual([]);
    expect(out.clean.length).toBeGreaterThan(0);
  });
});
