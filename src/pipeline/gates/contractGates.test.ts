import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OpsRegistry, setOpsRegistryPath } from '../../registry/opsRegistry';
import { recordCorrection, recordNotDuplicate, setCorrectionsPath } from '../../state/corrections';
import type { BoardTask } from '../../trackers';
import type { CategorizationItem } from '../parsing/categorizationManifest';
import { indexTasks, setTaskUrlBuilder } from './clarify';
import {
  binaryHoldGate,
  classifyLearnableFromContent,
  classifyLearnableGate,
  crossItemGate,
  effectiveWrite,
  fillFieldGaps,
  matchesNormOrHr,
  routingGate,
  uncertainFieldsGate,
  writeDispute,
} from './contractGates';

const DIR = join(tmpdir(), `gates-test-${process.pid}`);
const REGISTRY_PATH = join(DIR, 'ops-registry.json');

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: { clickup: '1' }, email: 'a@x.com', role: 'engineer', defaultProjects: [] },
    { name: 'Rowan Diaz', externalIds: { clickup: '2' }, email: 'r@x.com', role: 'designer', defaultProjects: [] },
    { name: 'Jules Kim', externalIds: { clickup: '3' }, email: 'j@x.com', role: 'product-manager', defaultProjects: [] },
  ],
  routes: [
    { key: 'backend', externalIds: {}, pattern: 'backend|api|rate limit', defaultAssignee: 'Avery Chen', validAssignees: ['Avery Chen'], status: 'active' },
    { key: 'design', externalIds: {}, pattern: 'design|figma', defaultAssignee: 'Rowan Diaz', validAssignees: ['Rowan Diaz'], status: 'active' },
    { key: 'open', externalIds: {}, pattern: 'misc', validAssignees: [], status: 'active' }, // unrestricted
  ],
  log: [],
};

const BOARD: BoardTask[] = [
  { id: 't100', title: 'Add rate limiting to the public API', listKey: 'backend', assignees: ['Avery Chen'], status: 'in progress' },
  { id: 't200', title: 'Redesign the onboarding flow', listKey: 'design', assignees: ['Rowan Diaz'], status: 'to do' },
  { id: 't300', title: 'Billing webhook retry', listKey: 'backend', assignees: [], status: 'to do' },
];
const SNAP = () => indexTasks(BOARD);

const item = (over: Partial<CategorizationItem> = {}): CategorizationItem => ({
  item: 1, title: 'Some deliverable', category: 'NEW_TASK', tier2Cited: false, raw: '', ...over,
});

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(REGISTRY_PATH);
  setCorrectionsPath(join(DIR, 'corrections.json'));
  setTaskUrlBuilder((id) => `https://example.test/t/${id}`);
});
afterEach(() => {
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  setTaskUrlBuilder(null);
  rmSync(DIR, { recursive: true, force: true });
});

describe('matchesNormOrHr', () => {
  it('catches an ongoing norm that is not a one-time task', () => {
    expect(matchesNormOrHr('Always run the linter before pushing')).toBe('norm/policy');
    expect(matchesNormOrHr('From now on we deploy on Fridays')).toBe('norm/policy');
  });
  it('catches a people-management item', () => {
    expect(matchesNormOrHr('Talk to Sam about their availability')).toBe('people-management');
  });
  it('leaves an ordinary deliverable alone', () => {
    expect(matchesNormOrHr('Add rate limiting to the API')).toBeNull();
  });
});

describe('effectiveWrite', () => {
  it('maps each category to the write it actually produces', () => {
    expect(effectiveWrite('NEW_TASK')).toEqual({ action: 'CREATE' });
    expect(effectiveWrite('UPDATE', 't1')).toEqual({ action: 'COMMENT', target: 't1' });
    expect(effectiveWrite('SUBTASK', 't1')).toEqual({ action: 'CREATE_CHILD', target: 't1' });
    expect(effectiveWrite('DUPLICATE', 't1')).toEqual({ action: 'NOTHING' });
    expect(effectiveWrite('RELATE', 't1')).toEqual({ action: 'LINK', target: 't1' });
    expect(effectiveWrite('UNKNOWN')).toEqual({ action: 'UNKNOWN' });
  });

  it('DUPLICATE carries no target — which card it names is moot, it writes nothing either way', () => {
    expect(effectiveWrite('DUPLICATE', 't1').target).toBeUndefined();
  });
});

describe('writeDispute', () => {
  // A different category almost always means a different write — this is the boundary that matters,
  // wider than the old new-vs-existing rule (which trusted 2a on any DUPLICATE/UPDATE/SUBTASK mix).
  it('disputes when one read says new work and the other says an existing card', () => {
    expect(writeDispute('NEW_TASK', undefined, 'DUPLICATE', 't1')).not.toBeNull();
    expect(writeDispute('UPDATE', 't1', 'NEW_TASK', undefined)).not.toBeNull();
  });

  it('disputes an existing-card mismatch the old category-label rule trusted 2a on', () => {
    // UPDATE (comment) vs DUPLICATE (nothing) — same "existing card" bucket under the old rule, but
    // a genuinely different write: one posts a comment, the other writes nothing at all.
    expect(writeDispute('UPDATE', 't1', 'DUPLICATE', 't1')).not.toBeNull();
    // UPDATE (comment) vs SUBTASK (create-child) — different action, different write.
    expect(writeDispute('SUBTASK', 't1', 'UPDATE', 't1')).not.toBeNull();
  });

  it('disputes the same action on two DIFFERENT cards', () => {
    expect(writeDispute('UPDATE', 't1', 'UPDATE', 't2')).not.toBeNull();
  });

  it('does NOT dispute the same action on the same card', () => {
    expect(writeDispute('UPDATE', 't1', 'UPDATE', 't1')).toBeNull();
  });

  it('does NOT dispute when only one read named a target — an absence is not a manufactured mismatch', () => {
    expect(writeDispute('UPDATE', 't1', 'UPDATE', undefined)).toBeNull();
    expect(writeDispute('UPDATE', undefined, 'UPDATE', 't1')).toBeNull();
  });

  // Both write NOTHING, so the disagreement about WHICH card is moot — this is the property that
  // makes an arbiter (rather than a blanket hold) the right shape for the wider rule.
  it('does NOT dispute DUPLICATE(A) vs DUPLICATE(B) — both write nothing', () => {
    expect(writeDispute('DUPLICATE', 't1', 'DUPLICATE', 't2')).toBeNull();
  });

  it('never disputes plain agreement', () => {
    expect(writeDispute('NEW_TASK', undefined, 'NEW_TASK', undefined)).toBeNull();
  });
});

describe('binaryHoldGate', () => {
  it('passes a fully-specified NEW_TASK clean', () => {
    expect(binaryHoldGate(item({ list: 'backend', assignee: 'Avery Chen', finalDesc: 'do it' }), SNAP())).toBeNull();
  });

  it('holds a norm/policy title', () => {
    expect(binaryHoldGate(item({ title: 'Always tag releases' }), SNAP())?.gate).toContain('norm/policy');
  });

  it('holds a DUPLICATE with no cited evidence', () => {
    const g = binaryHoldGate(item({ category: 'DUPLICATE', existingTaskId: 't100', tier2Cited: false }), SNAP());
    expect(g?.gate).toBe('evidence not cited');
  });

  it('holds a SUBTASK with no cited evidence', () => {
    expect(binaryHoldGate(item({ category: 'SUBTASK', parentTaskId: 't100', tier2Cited: false }), SNAP())?.gate)
      .toBe('evidence not cited');
  });

  it('lets a DUPLICATE through once evidence is cited', () => {
    expect(binaryHoldGate(item({ category: 'DUPLICATE', existingTaskId: 't100', tier2Cited: true }), SNAP())).toBeNull();
  });

  it('holds when the referenced card is no longer on the board', () => {
    const g = binaryHoldGate(item({ category: 'DUPLICATE', existingTaskId: 'gone', tier2Cited: true }), SNAP());
    expect(g?.gate).toBe('referenced task id not on the board');
  });

  it('holds when the parent card is no longer on the board', () => {
    expect(binaryHoldGate(item({ category: 'SUBTASK', parentTaskId: 'gone', tier2Cited: true }), SNAP())?.gate)
      .toBe('parent task id not on the board');
  });

  it('holds a subtask routed to a different list than its parent', () => {
    const g = binaryHoldGate(item({ category: 'SUBTASK', parentTaskId: 't100', list: 'design', tier2Cited: true }), SNAP());
    expect(g?.gate).toBe('subtask list ≠ parent list');
    expect(g?.question).toContain('backend'); // names the parent's real list
  });

  it('holds a RELATE whose link target is gone', () => {
    expect(binaryHoldGate(item({ category: 'RELATE', linkTaskId1: 't100', linkTaskId2: 'gone' }), SNAP())?.gate)
      .toBe('RELATE link id not on the board');
  });

  describe('UPDATE is gated on card identity, not comment history', () => {
    it('holds a vague update nothing confirmed', () => {
      const g = binaryHoldGate(item({ category: 'UPDATE', existingTaskId: 't100', title: 'this is done' }), SNAP(), { isVague: true });
      expect(g?.gate).toBe('vague update — card not confirmed');
    });

    it('lets a vague update through once identity is independently confirmed', () => {
      const g = binaryHoldGate(
        item({ category: 'UPDATE', existingTaskId: 't100', title: 'this is done' }),
        SNAP(),
        { isVague: true, identityConfirmed: true }
      );
      expect(g).toBeNull();
    });

    it('holds an explicit update whose title does not resemble the matched card', () => {
      const g = binaryHoldGate(item({ category: 'UPDATE', existingTaskId: 't100', title: 'quarterly offsite venue' }), SNAP());
      expect(g?.gate).toBe('update — card match not confident');
    });

    it('lets an explicit update through on a strong title match', () => {
      const g = binaryHoldGate(item({ category: 'UPDATE', existingTaskId: 't100', title: 'rate limiting on the public API' }), SNAP());
      expect(g).toBeNull();
    });

    it('accepts cited evidence in place of a title match', () => {
      const g = binaryHoldGate(
        item({ category: 'UPDATE', existingTaskId: 't100', title: 'totally different words', tier2Cited: true }),
        SNAP()
      );
      expect(g).toBeNull();
    });

    it('holds a reassign to someone not on the roster', () => {
      const g = binaryHoldGate(
        item({ category: 'UPDATE', existingTaskId: 't100', title: 'rate limiting on the public API', assignee: 'Nobody Here' }),
        SNAP()
      );
      expect(g?.gate).toBe('assignee not in team roster');
    });

    it('holds a move to a list that does not exist', () => {
      const g = binaryHoldGate(
        item({ category: 'UPDATE', existingTaskId: 't100', title: 'rate limiting on the public API', list: 'nowhere' }),
        SNAP()
      );
      expect(g?.gate).toBe('unknown list key');
    });
  });
});

describe('routingGate', () => {
  it('ignores categories that are not creating work', () => {
    expect(routingGate(item({ category: 'UPDATE', list: 'nonsense' }))).toBeNull();
    expect(routingGate(item({ category: 'DUPLICATE', list: 'nonsense' }))).toBeNull();
  });

  it('holds an unknown list and names the valid ones', () => {
    const g = routingGate(item({ list: 'platfrm' }));
    expect(g?.gate).toBe('unknown list key');
    expect(g?.question).toContain('backend');
  });

  it('holds an assignee who is not a team member', () => {
    expect(routingGate(item({ list: 'backend', assignee: 'Ghost Person' }))?.gate).toBe('assignee not in team roster');
  });

  it('holds an assignee who does not own work on that list', () => {
    const g = routingGate(item({ list: 'backend', assignee: 'Rowan Diaz' }));
    expect(g?.gate).toBe('assignee not valid for list');
    expect(g?.question).toContain('Avery Chen'); // says who does
  });

  it('passes the list owner', () => {
    expect(routingGate(item({ list: 'backend', assignee: 'Avery Chen' }))).toBeNull();
  });

  // An empty valid-assignee list means unrestricted, not "nobody" — otherwise adding a new list
  // would block every task on it.
  it('treats an empty valid-assignee list as unrestricted', () => {
    expect(routingGate(item({ list: 'open', assignee: 'Jules Kim' }))).toBeNull();
  });

  it('leaves a missing assignee to the gap-fill gate', () => {
    expect(routingGate(item({ list: 'backend' }))).toBeNull();
  });

  // The feedback loop reaching a deterministic gate: a human said Rowan may own backend work.
  it('stops holding once a human has added the assignee', async () => {
    expect(routingGate(item({ list: 'backend', assignee: 'Rowan Diaz' }))?.gate).toBe('assignee not valid for list');
    await recordCorrection({ kind: 'valid_assignee', listKey: 'backend', assigneeName: 'Rowan Diaz' }, 'human');
    expect(routingGate(item({ list: 'backend', assignee: 'Rowan Diaz' }))).toBeNull();
  });
});

describe('fillFieldGaps', () => {
  it('routes an unrouted NEW_TASK from its title', () => {
    const { filled } = fillFieldGaps(item({ title: 'add an api rate limit', finalDesc: 'x' }), SNAP());
    expect(filled.list).toBe('backend');
  });

  it('canonicalizes a sloppy list key', () => {
    const { filled } = fillFieldGaps(item({ list: 'BACKEND ', finalDesc: 'x', assignee: 'Avery Chen' }), SNAP());
    expect(filled.list).toBe('backend');
  });

  // "ask, don't guess": a default owner is a pipeline fallback, not a fact from the source.
  it('fills the default owner but marks it uncertain rather than writing it silently', () => {
    const { filled } = fillFieldGaps(item({ list: 'backend', finalDesc: 'x' }), SNAP());
    expect(filled.assignee).toBe('Avery Chen');
    expect(filled.uncertainFields?.some((u) => u.field === 'assignee')).toBe(true);
    expect(uncertainFieldsGate(filled)?.gate).toBe('uncertain field(s)');
  });

  it('supplies defaults that are never worth holding over', () => {
    const { filled } = fillFieldGaps(item({ list: 'backend', assignee: 'Avery Chen', finalDesc: 'x' }), SNAP(), '2026-08-11');
    expect(filled.priority).toBe('normal');
    expect(filled.status).toBe('not started');
    expect(filled.dueDate).toBe('2026-08-11');
  });

  it('reports what it cannot resolve', () => {
    const { missing } = fillFieldGaps(item({ title: 'quarterly offsite venue' }), SNAP());
    expect(missing).toContain('FINAL_DESC');
    expect(missing).toContain('LIST');
  });

  it('resolves the notify target for an UPDATE from the card owner', () => {
    const { filled, missing } = fillFieldGaps(item({ category: 'UPDATE', existingTaskId: 't100', finalDesc: 'x' }), SNAP());
    expect(filled.notifyAssignee).toBe('Avery Chen');
    expect(missing).toEqual([]);
  });

  it('reports a missing notify target when the card has no owner', () => {
    const { missing } = fillFieldGaps(item({ category: 'UPDATE', existingTaskId: 't300', finalDesc: 'x' }), SNAP());
    expect(missing).toContain('NOTIFY_ASSIGNEE');
  });

  it('never mutates the original item', () => {
    const original = item({ list: 'backend', finalDesc: 'x' });
    fillFieldGaps(original, SNAP());
    expect(original.assignee).toBeUndefined();
    expect(original.priority).toBeUndefined();
  });

  it('preserves uncertainty the model self-reported', () => {
    const { filled } = fillFieldGaps(
      item({ list: 'backend', assignee: 'Avery Chen', finalDesc: 'x', uncertainFields: [{ field: 'content', reason: 'garbled audio' }] }),
      SNAP()
    );
    expect(filled.uncertainFields).toHaveLength(1);
  });
});

describe('uncertainFieldsGate', () => {
  it('is silent on a confident item', () => {
    expect(uncertainFieldsGate(item())).toBeNull();
  });
  it('asks about every uncertain field in plain English, never raw tokens', () => {
    const g = uncertainFieldsGate(item({ uncertainFields: [{ field: 'list', reason: 'ambiguous', suggested: 'backend' }] }));
    expect(g?.question).toContain('which list this belongs on');
    expect(g?.question).not.toContain('FINAL_DESC');
  });
});

describe('crossItemGate', () => {
  it('merges two updates on the same card into one comment', () => {
    const items = [
      item({ item: 1, category: 'UPDATE', existingTaskId: 't100', finalDesc: 'moved to review' }),
      item({ item: 2, category: 'UPDATE', existingTaskId: 't100', finalDesc: 'ships Friday' }),
    ];
    const out = crossItemGate(items, SNAP());
    expect(out.clean).toHaveLength(1);
    expect(out.clean[0]!.finalDesc).toBe('moved to review ships Friday');
    expect(out.flags.find((f) => f.kind === 'updates_merged')?.items).toEqual([1, 2]);
  });

  it('merges every UPDATE-writable field forward, not just finalDesc', () => {
    const items = [
      item({ item: 1, category: 'UPDATE', existingTaskId: 't100', finalDesc: 'moved to review' }),
      item({ item: 2, category: 'UPDATE', existingTaskId: 't100', finalDesc: 'ships Friday', status: 'in review', priority: 'high' }),
    ];
    const out = crossItemGate(items, SNAP());
    expect(out.clean).toHaveLength(1);
    expect(out.clean[0]!.status).toBe('in review');
    expect(out.clean[0]!.priority).toBe('high');
  });

  it('HOLDS two UPDATEs on one card that set the same field to different values, rather than silently picking one', () => {
    const items = [
      item({ item: 1, category: 'UPDATE', existingTaskId: 't100', finalDesc: 'moved to review', status: 'in review' }),
      item({ item: 2, category: 'UPDATE', existingTaskId: 't100', finalDesc: 'shipped', status: 'complete' }),
    ];
    const out = crossItemGate(items, SNAP());
    expect(out.clean).toHaveLength(0);
    expect(out.held).toHaveLength(2);
    expect(out.held.every((h) => h.gate === 'conflicting updates to the same card')).toBe(true);
    // Not silently in the digest as a merge — this is a hold, and no updates_merged flag is raised.
    expect(out.flags.find((f) => f.kind === 'updates_merged')).toBeUndefined();
  });

  it('flags over-subtasking without blocking it', () => {
    const items = [1, 2, 3].map((n) => item({ item: n, category: 'SUBTASK', parentTaskId: 't200', tier2Cited: true }));
    const out = crossItemGate(items, SNAP());
    expect(out.flags.find((f) => f.kind === 'over_subtask')?.items).toEqual([1, 2, 3]);
    expect(out.clean).toHaveLength(3);
  });

  // The headline fix: this positively identifies a duplicate, and it HOLDS rather than only logging.
  it('HOLDS a NEW_TASK that closely matches an existing card', () => {
    const out = crossItemGate([item({ item: 1, title: 'Redesign the onboarding flow', list: 'design' })], SNAP());
    expect(out.clean).toHaveLength(0);
    expect(out.held[0]!.gate).toBe('possible missed duplicate');
    // The flag survives alongside the hold because it carries the score you need to tune the floor.
    expect(out.flags.find((f) => f.kind === 'missed_dup')?.note).toMatch(/sim 1\.00|sim 0\.\d\d/);
  });

  it('does not hold a genuinely new task', () => {
    const out = crossItemGate([item({ item: 1, title: 'Book the quarterly offsite venue', list: 'open' })], SNAP());
    expect(out.clean).toHaveLength(1);
    expect(out.held).toHaveLength(0);
  });

  // Otherwise the person who corrected it once has to correct it every run.
  it('respects a human saying those two are not the same work', async () => {
    await recordNotDuplicate('Redesign the onboarding flow', 't200', 'human');
    const out = crossItemGate([item({ item: 1, title: 'Redesign the onboarding flow', list: 'design' })], SNAP());
    expect(out.clean).toHaveLength(1);
    expect(out.held).toHaveLength(0);
  });

  it('holds a RELATE that links a card to itself', () => {
    const out = crossItemGate([item({ item: 1, category: 'RELATE', linkTaskId1: 't100', linkTaskId2: 't100' })], SNAP());
    expect(out.held[0]!.gate).toBe('RELATE self-link');
    expect(out.clean).toHaveLength(0);
  });

  it('flags two near-identical new tasks on the same list', () => {
    const items = [
      item({ item: 1, title: 'Write the launch announcement post', list: 'design' }),
      item({ item: 2, title: 'Write the launch announcement post now', list: 'design' }),
    ];
    const out = crossItemGate(items, SNAP());
    expect(out.flags.find((f) => f.kind === 'near_dup_pair')?.items).toEqual([1, 2]);
  });

  it('does not flag near-identical titles on different lists', () => {
    const items = [
      item({ item: 1, title: 'Write the launch announcement post', list: 'design' }),
      item({ item: 2, title: 'Write the launch announcement post', list: 'backend' }),
    ];
    expect(crossItemGate(items, SNAP()).flags.find((f) => f.kind === 'near_dup_pair')).toBeUndefined();
  });
});

describe('learnable classification', () => {
  it('maps exactly one gate to a typed rule', () => {
    expect(classifyLearnableGate('assignee not valid for list')).toBe('valid_assignee');
  });

  // Everything unanticipated must still be remembered, or the unanticipated corrections — most of
  // them — are silently forgotten.
  it('remembers every other gate as a free-form note', () => {
    expect(classifyLearnableGate('uncertain field(s)')).toBe('note');
    expect(classifyLearnableGate('a gate nobody has written yet')).toBe('note');
  });

  it('upgrades to a typed rule when the answer states one', () => {
    expect(classifyLearnableFromContent('uncertain field(s)', 'add Rowan to the backend list')).toBe('valid_assignee');
    expect(classifyLearnableFromContent('uncertain field(s)', 'make them a valid assignee')).toBe('valid_assignee');
  });

  it('leaves an ordinary answer as a note', () => {
    expect(classifyLearnableFromContent('uncertain field(s)', 'yes that is right')).toBe('note');
  });
});
