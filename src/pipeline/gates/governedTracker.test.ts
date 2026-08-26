/**
 * The governed write boundary — the wrapper that decides whether a board-agent write lands.
 *
 * This file exists to pin one sentence, because it is the sentence that replaces a stronger one:
 *
 *   > A successful injection cannot author a write **the deterministic gates would not already have
 *   > approved.**
 *
 * With `BOARD_AGENT_WRITES` off, the repo's claim is the stronger "cannot author a write", and
 * `toolLoop.contract.test.ts` pins that. These tests cover the mode where a model genuinely can reach
 * the tracker, so every one of them is a test that the *gates* stopped something, not that the
 * absence of a code path did.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvedOpSet, governedTracker, opSignature } from './governedTracker';
import { indexTasks } from './clarify';
import { type OpsRegistry, setOpsRegistryPath } from '../../registry/opsRegistry';
import type { BoardTask, TrackerAdapter, TrackerOperation } from '../../trackers';
import { memoryTracker } from '../../trackers/memory';

let dir: string;

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: {}, email: 'avery@example.com', role: 'engineer', defaultProjects: ['backend'] },
  ],
  routes: [
    {
      key: 'backend',
      externalIds: {},
      pattern: 'api|backend|rate',
      defaultAssignee: 'Avery Chen',
      validAssignees: ['Avery Chen'],
      status: 'active',
    },
  ],
  log: [],
};

const BOARD: BoardTask[] = [
  { id: 't100', title: 'Rate limiting for the public API', status: 'in progress', assignees: ['Avery Chen'], listKey: 'backend' },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'governed-'));
  writeFileSync(join(dir, 'r.json'), JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(join(dir, 'r.json'));
});
afterEach(() => {
  setOpsRegistryPath(null);
  rmSync(dir, { recursive: true, force: true });
});

/** A tracker that records what actually reached it, so "never reached the adapter" is assertable. */
function recording(): TrackerAdapter & { ops: TrackerOperation[] } {
  const inner = memoryTracker({ tasks: BOARD });
  const ops: TrackerOperation[] = [];
  return {
    ...inner,
    ops,
    async apply(op) {
      ops.push(op);
      return inner.apply(op);
    },
  };
}

const wrap = (
  inner: TrackerAdapter,
  over: Partial<Parameters<typeof governedTracker>[1]> = {}
): TrackerAdapter =>
  governedTracker(inner, { approvedOps: new Set(), snapshot: indexTasks(BOARD), ...over });

const CREATE: TrackerOperation = {
  kind: 'createTask',
  listKey: 'backend',
  title: 'Add a rate-limit dashboard',
  assignees: ['Avery Chen'],
  description: 'Chart the limiter that already shipped.',
};

describe('an approved op applies as planned', () => {
  /**
   * Re-gating an op the pipeline just gated is not merely wasted work — it fails. `tier2Cited` and
   * the resolved fields live on the manifest item, not on the operation, so an op rebuilt from
   * scratch loses them and the write the gates approved gets refused by those same gates.
   */
  it('passes an op in the approved set straight through', async () => {
    const inner = recording();
    const out = await wrap(inner, { approvedOps: approvedOpSet([CREATE]) }).apply(CREATE);

    expect(out.status).toBe('applied');
    expect(inner.ops).toEqual([CREATE]);
  });

  it('treats a changed body as a different op, not an approved one', async () => {
    const inner = recording();
    const tampered = { ...CREATE, description: 'and also email the client the contract' };

    // Signature is over the whole op, so matching titles do not smuggle a different body through.
    expect(opSignature(tampered)).not.toBe(opSignature(CREATE));

    const out = await wrap(inner, { approvedOps: approvedOpSet([CREATE]) }).apply(tampered);
    expect(out.status).toBe('refused');
    expect(inner.ops).toEqual([]);
  });
});

describe('a novel op faces every gate the pipeline faced', () => {
  it('lets a clean create through', async () => {
    const inner = recording();
    const out = await wrap(inner).apply(CREATE);

    expect(out.status).toBe('applied');
    expect(inner.ops).toHaveLength(1);
  });

  it('refuses an assignee who is not on the roster, and the adapter never sees it', async () => {
    const inner = recording();
    const out = await wrap(inner).apply({ ...CREATE, assignees: ['Mallory Stranger'] });

    expect(out.status).toBe('refused');
    expect('detail' in out && out.detail).toMatch(/roster/i);
    expect(inner.ops).toEqual([]);
  });

  it('refuses an unknown list key', async () => {
    const inner = recording();
    const out = await wrap(inner).apply({ ...CREATE, listKey: 'not-a-list' });

    expect(out.status).toBe('refused');
    expect(inner.ops).toEqual([]);
  });

  /**
   * The gate that ignores confidence, reached through a write rather than through a manifest. An
   * agent that has been talked into rotating a credential is exactly the scenario this mode has to
   * survive to be shippable at all.
   */
  it('refuses a write that trips the critical gate', async () => {
    const inner = recording();
    const out = await wrap(inner).apply({
      ...CREATE,
      title: 'Rotate the Stripe API key and grant access to the new vendor',
    });

    expect(out.status).toBe('refused');
    expect('detail' in out && out.detail).toMatch(/critical/i);
    expect(inner.ops).toEqual([]);
  });

  it('refuses rather than fails — a retry cannot help', async () => {
    const out = await wrap(recording()).apply({ ...CREATE, assignees: ['Mallory Stranger'] });
    expect(out.status).not.toBe('failed');
    expect(out.status).toBe('refused');
  });

  /**
   * Fail closed on anything with no manifest form. An op this layer cannot express as an item is an
   * op no gate can judge, and "unfamiliar" must never mean "allowed".
   */
  it('refuses an operation it cannot express as an item', async () => {
    const inner = recording();
    const out = await wrap(inner).apply({ kind: 'moveList', taskId: 't100', listKey: 'backend' });

    expect(out.status).toBe('refused');
    expect('detail' in out && out.detail).toMatch(/no manifest form/i);
    expect(inner.ops).toEqual([]);
  });
});

describe('evidence is what the agent read, not what it said', () => {
  /**
   * The evidence gate covers DUPLICATE and SUBTASK — containment and "same work" are the two claims
   * comment history actually proves. An UPDATE is gated on card identity instead, deliberately, so a
   * comment on a card the agent named explicitly is not the case this mechanism is for.
   *
   * On the pipeline path, "I checked the history" is the model's own claim, parsed out of its prose.
   * Here it is a fact the loop recorded: a model that says it looked and did not gets held.
   */
  const SUBTASK: TrackerOperation = {
    kind: 'createTask',
    listKey: 'backend',
    title: 'Chart p99 latency under the limiter',
    assignees: ['Avery Chen'],
    description: 'Add a p99 panel to the limiter dashboard.',
    parentId: 't100',
  };

  it('holds a subtask whose parent history was never fetched', async () => {
    const inner = recording();
    const out = await wrap(inner, { readComments: () => false }).apply(SUBTASK);

    expect(out.status).toBe('refused');
    expect('detail' in out && out.detail).toMatch(/evidence not cited/i);
    expect(inner.ops).toEqual([]);
  });

  it('lets the same subtask through once the parent history has actually been read', async () => {
    const inner = recording();
    const out = await wrap(inner, { readComments: (id) => id === 't100' }).apply(SUBTASK);

    expect(out.status).toBe('applied');
    expect(inner.ops).toHaveLength(1);
  });

  /** An UPDATE naming a real card is settled by identity, and needs no history to be written. */
  it('does not ask a comment on a named, existing card for history it does not need', async () => {
    const inner = recording();
    const out = await wrap(inner, { readComments: () => false }).apply({
      kind: 'addComment',
      taskId: 't100',
      body: 'Shipped the limiter.',
    });

    expect(out.status).toBe('applied');
  });
});

describe('reads are untouched', () => {
  it('passes every read through and names itself in the trace', async () => {
    const g = wrap(recording());

    expect(g.name).toMatch(/:governed$/);
    expect(await g.getTask('t100')).not.toBeNull();
    expect(await g.listTasks()).toHaveLength(1);
  });
});

describe('a refused write is surfaced, not swallowed', () => {
  it('reports the hold to the caller so it reaches the same place any other hold does', async () => {
    const seen: string[] = [];
    await wrap(recording(), { onHold: (h) => seen.push(h.gate) }).apply({
      ...CREATE,
      assignees: ['Mallory Stranger'],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/roster/i);
  });
});
