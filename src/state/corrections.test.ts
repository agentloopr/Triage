import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routingGate } from '../pipeline/gates/contractGates';
import type { CategorizationItem } from '../pipeline/parsing/categorizationManifest';
import { type OpsRegistry, setOpsRegistryPath } from '../registry/opsRegistry';
import {
  getValidAssigneeAdditions,
  isKnownNotDuplicate,
  learnedFactsBlock,
  listLearnedNotes,
  loadCorrections,
  normalizeKey,
  recordCorrection,
  recordNotDuplicate,
  resolveListAlias,
  resolveNameAlias,
  setCorrectionsPath,
} from './corrections';
import { setCorruptFileNotifier } from './jsonStore';

/**
 * The human-correction feedback loop (PRD §11 P1).
 *
 * The store had no direct test until now — it was only exercised sideways, through a fixture
 * scenario and a few gate cases. That is the gap the Phases 1–2 verification walk flagged, and it
 * matters here more than most places: this is the one subsystem whose entire purpose is that
 * answering a question *once* stops the pipeline asking it again. If a correction is recorded and
 * silently fails to change the next decision, the symptom is not an error — it is a human being
 * asked the same thing every week and slowly deciding the tool is not worth the trouble.
 */
const DIR = join(tmpdir(), `corrections-${process.pid}`);
const FILE = join(DIR, 'corrections.json');
const REGISTRY_PATH = join(DIR, 'ops-registry.json');

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: { clickup: '1' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] },
    { name: 'Rowan Diaz', externalIds: { clickup: '2' }, email: 'r@x.com', role: 'designer', defaultProjects: [] },
  ],
  routes: [
    {
      key: 'backend',
      externalIds: {},
      pattern: 'backend|api',
      defaultAssignee: 'Avery Chen',
      // Rowan is deliberately NOT valid here — that is what a correction has to change.
      validAssignees: ['Avery Chen'],
      status: 'active',
    },
  ],
  log: [],
};

const item = (over: Partial<CategorizationItem> = {}): CategorizationItem => ({
  item: 1,
  title: 'Add rate limiting',
  category: 'NEW_TASK',
  list: 'backend',
  assignee: 'Avery Chen',
  finalDesc: 'Throttle the public endpoints.',
  tier2Cited: false,
  raw: '',
  ...over,
});

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(REGISTRY_PATH);
  setCorrectionsPath(FILE);
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  setCorruptFileNotifier(null);
  vi.restoreAllMocks();
  rmSync(DIR, { recursive: true, force: true });
});

/** The PRD's own wording: "a test proving a recorded correction changes a later decision." */
describe('a recorded correction changes a later decision', () => {
  it('an assignee the registry alone would reject is accepted after one correction', async () => {
    const held = routingGate(item({ assignee: 'Rowan Diaz' }));
    expect(held).not.toBeNull();
    expect(held!.gate).toMatch(/assignee/i);

    await recordCorrection({ kind: 'valid_assignee', listKey: 'backend', assigneeName: 'Rowan Diaz' }, 'a human');

    expect(routingGate(item({ assignee: 'Rowan Diaz' }))).toBeNull();
  });

  it('and the correction can be taken back', async () => {
    await recordCorrection({ kind: 'valid_assignee', listKey: 'backend', assigneeName: 'Rowan Diaz' }, 'a human');
    expect(routingGate(item({ assignee: 'Rowan Diaz' }))).toBeNull();

    await recordCorrection({ kind: 'remove_valid_assignee', listKey: 'backend', assigneeName: 'Rowan Diaz' }, 'a human');
    expect(routingGate(item({ assignee: 'Rowan Diaz' }))).not.toBeNull();
  });

  /**
   * The duplicate case, which is the one a human notices being wrong twice.
   *
   * "No, that is a different piece of work" has to stick, or the same two cards get proposed as
   * duplicates after every meeting that mentions either of them.
   */
  it('a pair marked not-a-duplicate stays not-a-duplicate', async () => {
    expect(isKnownNotDuplicate('Ship onboarding revamp', 't500')).toBe(false);

    await recordNotDuplicate('Ship onboarding revamp', 't500', 'a human');

    expect(isKnownNotDuplicate('Ship onboarding revamp', 't500')).toBe(true);
    // Scoped to the pair — the same title against a different card is still an open question.
    expect(isKnownNotDuplicate('Ship onboarding revamp', 't999')).toBe(false);
  });

  it('survives a restart — corrections are on disk, not in memory', async () => {
    await recordCorrection({ kind: 'valid_assignee', listKey: 'backend', assigneeName: 'Rowan Diaz' }, 'a human');

    setCorrectionsPath(null);
    setCorrectionsPath(FILE); // re-point at the same file, as a fresh process would

    expect(getValidAssigneeAdditions('backend')).toContain('Rowan Diaz');
  });
});

describe('aliases', () => {
  it('resolves a list alias a human taught it', async () => {
    await recordCorrection({ kind: 'list_alias', alias: 'The API stuff', canonical: 'backend' }, 'a human');
    expect(resolveListAlias(normalizeKey('the api stuff'))).toBe('backend');
  });

  it('resolves a name alias, which is how a nickname stops causing holds', async () => {
    await recordCorrection({ kind: 'name_alias', alias: 'Av', canonical: 'Avery Chen' }, 'a human');
    expect(resolveNameAlias(normalizeKey('av'))).toBe('Avery Chen');
  });

  // "Avery Chen (Engineering)" and "avery  chen" are the same person to a human and must be here too.
  it('normalizes away trailing parentheticals and repeated spaces', () => {
    expect(normalizeKey('Avery Chen (Engineering)')).toBe('avery chen');
    expect(normalizeKey('  avery   chen ')).toBe('avery chen');
  });
});

describe('taught facts reach the prompt', () => {
  it('a recorded note appears in the block the prompts inject', async () => {
    await recordCorrection({ kind: 'note', text: 'Northwind is a client, route it to backend', scope: 'backend' }, 'a human');

    expect(listLearnedNotes()).toHaveLength(1);
    expect(learnedFactsBlock(30).join('\n')).toContain('Northwind is a client');
  });

  it('emits nothing at all when nothing has been taught', () => {
    // An empty block must be empty, not a header with no content — a prompt section promising facts
    // and delivering none teaches the model that the section is noise.
    expect(learnedFactsBlock(30)).toEqual([]);
  });
});

describe('the store itself', () => {
  it('starts empty rather than throwing when the file does not exist', () => {
    expect(loadCorrections()).toMatchObject({ notes: [], notDuplicatePairs: [] });
  });

  /**
   * The shared-mutable-constant bug, pinned.
   *
   * `loadCorrections` once returned `{ ...EMPTY }` — a shallow copy sharing the same arrays — so the
   * first `push` mutated a module constant for the lifetime of the process, and data appeared in a
   * store whose file had never existed.
   */
  it('hands out a fresh object each time, sharing no arrays', () => {
    const a = loadCorrections();
    const b = loadCorrections();

    expect(a.notes).not.toBe(b.notes);
    a.notes.push({ text: 'mutated', by: 'test', at: 'now' });
    expect(loadCorrections().notes).toEqual([]);
  });

  it('reports a corrupt file loudly and starts empty rather than pretending it was absent', () => {
    const reports: string[] = [];
    setCorruptFileNotifier((m) => reports.push(m));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(FILE, '{ not json', 'utf8');

    expect(loadCorrections().notes).toEqual([]);
    expect(reports[0]).toContain('CORRUPT');
  });

  it('records who taught it and when, so a wrong correction can be traced', async () => {
    await recordCorrection({ kind: 'note', text: 'a fact', scope: 'backend' }, 'Avery Chen', '2026-08-11T00:00:00.000Z');

    const [note] = listLearnedNotes();
    expect(note).toMatchObject({ by: 'Avery Chen', at: '2026-08-11T00:00:00.000Z' });
  });
});
