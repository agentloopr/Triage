/**
 * Per-role state.
 *
 * The two tests that matter here are the ones about **not losing things**: a human's `context` line
 * surviving a pipeline write, and a failed tracker write NOT being recorded as work in progress.
 * Everything else is bookkeeping.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_OPEN_ITEMS,
  type RoleState,
  fileRoleStateStore,
  loadRoleStates,
  readRoleState,
  recordRoleWork,
  roleStateLines,
  setRoleStateDir,
} from './roleState';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'role-state-'));
  setRoleStateDir(dir);
});
afterEach(() => {
  setRoleStateDir(null);
  rmSync(dir, { recursive: true, force: true });
});

const read = (role: string): RoleState => JSON.parse(readFileSync(join(dir, `${role}.json`), 'utf8')) as RoleState;
const at = '2026-08-12T10:00:00.000Z';

describe('readRoleState', () => {
  it('returns an empty state for a role with no file, rather than throwing', () => {
    const s = readRoleState('engineer');
    expect(s.openItems).toEqual([]);
    expect(s.context).toBe('');
  });

  it('starts empty on a corrupt file instead of taking the run down with it', () => {
    writeFileSync(join(dir, 'qa.json'), '{ not json', 'utf8');
    expect(readRoleState('qa').openItems).toEqual([]);
  });

  it('ignores malformed entries in a hand-edited file rather than trusting the shape', () => {
    writeFileSync(
      join(dir, 'designer.json'),
      JSON.stringify({ version: 1, role: 'designer', context: 42, openItems: [{ title: 'ok', at }, { nope: true }, 'x'] }),
      'utf8'
    );
    const s = readRoleState('designer');
    expect(s.context).toBe(''); // a number is not context
    expect(s.openItems.map((i) => i.title)).toEqual(['ok']);
  });
});

describe('recordRoleWork', () => {
  it('writes what landed, newest first', () => {
    recordRoleWork('engineer', [{ taskId: 't1', title: 'Add rate limiting', at }]);
    recordRoleWork('engineer', [{ taskId: 't2', title: 'Cap upload size', at }]);
    expect(read('engineer').openItems.map((i) => i.taskId)).toEqual(['t2', 't1']);
  });

  it('de-duplicates by task id, so re-running a meeting does not stack the same card', () => {
    recordRoleWork('engineer', [{ taskId: 't1', title: 'Add rate limiting', at }]);
    recordRoleWork('engineer', [{ taskId: 't1', title: 'Add rate limiting (again)', at }]);
    expect(read('engineer').openItems).toHaveLength(1);
  });

  it(`caps at ${MAX_OPEN_ITEMS}, because this text sits next to the taxonomy in the prompt`, () => {
    for (let i = 0; i < MAX_OPEN_ITEMS + 4; i++) recordRoleWork('qa', [{ taskId: `t${i}`, title: `item ${i}`, at }]);
    expect(read('qa').openItems).toHaveLength(MAX_OPEN_ITEMS);
  });

  // The one that would be silent and expensive: a human writes a note, the next run erases it.
  it('NEVER overwrites the human-maintained context', () => {
    writeFileSync(
      join(dir, 'marketer.json'),
      JSON.stringify({ version: 1, role: 'marketer', context: 'Priya is on leave until the 14th', openItems: [] }),
      'utf8'
    );
    recordRoleWork('marketer', [{ taskId: 't9', title: 'Refresh pricing copy', at }]);
    expect(read('marketer').context).toBe('Priya is on leave until the 14th');
  });

  it('writes nothing at all when there is nothing to record', () => {
    recordRoleWork('engineer', []);
    expect(() => read('engineer')).toThrow(); // no file created
  });
});

describe('roleStateLines — what actually reaches the prompt', () => {
  it('emits nothing for a role with no context and no open work', () => {
    expect(roleStateLines('engineer', 'Avery Chen')).toEqual([]);
  });

  it('names the person, not the archetype, so the model can match it to the roster line above', () => {
    recordRoleWork('engineer', [{ taskId: 't1', title: 'Add rate limiting', at }]);
    const lines = roleStateLines('engineer', 'Avery Chen');
    expect(lines.join('\n')).toContain('Avery Chen');
    expect(lines.join('\n')).toContain('Add rate limiting');
  });

  it('emits nothing for a value that is not a known archetype', () => {
    expect(roleStateLines('wizard', 'Avery Chen')).toEqual([]);
  });
});

/**
 * The bug this exists to prevent, because it already happened once: role state was written
 * unconditionally to the configured state directory, so the test suite — which calls `runPipeline`
 * directly — populated the repo's own `.state/roles/`. That state then reached prompts built later in
 * the same run and set off cassette-drift warnings across a recording nobody had touched.
 *
 * A run that was not handed a store must not touch the disk at all.
 */
describe('fileRoleStateStore — writes only where it was told', () => {
  it('writes to the directory it was given, not the configured default', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'role-state-alt-'));
    try {
      fileRoleStateStore(elsewhere).record('engineer', [{ taskId: 't1', title: 'Add rate limiting', at }]);

      const written = JSON.parse(readFileSync(join(elsewhere, 'engineer.json'), 'utf8')) as RoleState;
      expect(written.openItems).toHaveLength(1);
      // The ambient directory is untouched.
      expect(() => read('engineer')).toThrow();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('restores the ambient directory afterwards, so one scoped write does not redirect later reads', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'role-state-alt-'));
    try {
      fileRoleStateStore(elsewhere).record('engineer', [{ taskId: 't1', title: 'Add rate limiting', at }]);
      recordRoleWork('qa', [{ taskId: 't2', title: 'Write the runbook', at }]);
      expect(read('qa').openItems).toHaveLength(1); // landed in `dir`, not in `elsewhere`
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('loadRoleStates', () => {
  it('returns only the roles that have something worth injecting', () => {
    recordRoleWork('engineer', [{ taskId: 't1', title: 'Add rate limiting', at }]);
    expect([...loadRoleStates().keys()]).toEqual(['engineer']);
  });
});
