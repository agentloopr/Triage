/**
 * The two agent types, and the two guarantees that make them safe to point at a real board.
 *
 *   1. A role agent **cannot write**, however it is prompted — `readOnlyTracker` refuses, so there
 *      is no code path from an agent to a mutation.
 *   2. The board agent **cannot claim a write that did not happen** — the summary is deterministic
 *      code over `ExecuteResult`, not the model narrating its own work.
 *
 * (2) is the rule production learned expensively and states in its own board prompt: never claim a
 * task was created unless the tool result proves it. A model summarising its own run will describe
 * what it *meant* to do. So it is not asked.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DELEGATIONS, delegateToRoleAgents, selectForDelegation, summariseRun } from './boardAgent';
import { buildRoleAgentPrompt, parseRoleReply, roleOf, runRoleAgent } from './roleAgent';
import type { CategorizationItem } from '../pipeline/parsing/categorizationManifest';
import type { ExecuteResult } from '../pipeline/passes/execute';
import { type OpsRegistry, setOpsRegistryPath } from '../registry/opsRegistry';
import { setRolesDir } from '../registry/roleProfiles';
import { setRoleStateDir } from '../state/roleState';
import type { CompletionRequest, CompletionResult, ModelClient } from '../providers';
import { memoryTracker } from '../trackers/memory';

let dir: string;

const REGISTRY: OpsRegistry = {
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [
    { name: 'Avery Chen', externalIds: {}, email: 'avery@example.com', role: 'engineer', defaultProjects: ['backend'] },
    { name: 'Rowan Diaz', externalIds: {}, email: 'rowan@example.com', role: 'designer', defaultProjects: ['design'] },
  ],
  routes: [
    { key: 'backend', externalIds: {}, pattern: 'api|backend', defaultAssignee: 'Avery Chen', validAssignees: ['Avery Chen'], status: 'active' },
  ],
  log: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(join(dir, 'r.json'), JSON.stringify(REGISTRY), 'utf8');
  setOpsRegistryPath(join(dir, 'r.json'));
  setRolesDir(join(process.cwd(), 'config', 'roles'));
  setRoleStateDir(join(dir, 'state'));
});
afterEach(() => {
  setOpsRegistryPath(null);
  setRolesDir(null);
  setRoleStateDir(null);
  rmSync(dir, { recursive: true, force: true });
});

/** Replies in sequence; records every request so the loop's behaviour can be asserted. */
function scripted(turns: Array<Partial<CompletionResult>>): ModelClient & { seen: CompletionRequest[] } {
  const seen: CompletionRequest[] = [];
  let i = 0;
  return {
    name: 'scripted',
    seen,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      seen.push(req);
      const turn = turns[Math.min(i++, turns.length - 1)] ?? {};
      return { text: '', model: 'm', provider: 'scripted', ...turn };
    },
  };
}

const item = (over: Partial<CategorizationItem> = {}): CategorizationItem =>
  ({
    item: 1,
    title: 'Add rate limiting',
    category: 'NEW_TASK',
    assignee: 'Avery Chen',
    finalDesc: 'short',
    tier2Cited: false,
    ...over,
  }) as CategorizationItem;

// ── Role agents ──────────────────────────────────────────────────────────────

describe('a role agent is built from its profile and its state', () => {
  it('names the role, what it owns, and how it phrases an update', () => {
    const prompt = buildRoleAgentPrompt({ role: 'engineer', owner: 'Avery Chen', title: 'Add rate limiting', desc: 'short' });
    expect(prompt).toContain('Engineer');
    expect(prompt).toMatch(/WHAT YOUR ROLE OWNS:.*implementation/i);
    expect(prompt).toContain('HOW YOUR ROLE PHRASES AN UPDATE:');
  });

  it('is forbidden from revisiting the category, which the gates already decided', () => {
    const prompt = buildRoleAgentPrompt({ role: 'engineer', owner: 'Avery Chen', title: 't', desc: 'd' });
    expect(prompt).toMatch(/may NOT decide whether this is a new task, a duplicate/i);
  });
});

describe('the read-only guarantee, asserted through the agent', () => {
  /**
   * The point of the test: not that the wrapper refuses — that is tested at the wrapper — but that
   * an agent, given a real writable tracker and a model that asks to write, still cannot.
   */
  it('offers no write tool at all, whatever the model asks for', async () => {
    const model = scripted([
      { text: '', toolCalls: [{ id: 'c1', name: 'create_task', arguments: { title: 'sneaky' } }] },
      { text: 'NOTE: done\nDESC: KEEP\nOWNERSHIP: OK' },
    ]);
    const tracker = memoryTracker({ tasks: [] });

    await runRoleAgent({ role: 'engineer', owner: 'Avery Chen', title: 't', desc: 'd' }, { model, tracker });

    const offered = (model.seen[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toEqual(['get_task', 'get_task_comments', 'search_tasks']);
    // The board is untouched: no write tool exists to reach it.
    expect(await tracker.listTasks()).toHaveLength(0);
  });

  it('tells the model the tool does not exist rather than silently ignoring it', async () => {
    const model = scripted([
      { text: '', toolCalls: [{ id: 'c1', name: 'create_task', arguments: {} }] },
      { text: 'NOTE: could not\nDESC: KEEP\nOWNERSHIP: OK' },
    ]);
    await runRoleAgent({ role: 'engineer', owner: 'Avery Chen', title: 't', desc: 'd' }, { model, tracker: memoryTracker({ tasks: [] }) });

    const toolReply = model.seen[1]?.messages.find((m) => m.role === 'tool');
    expect(toolReply?.content).toMatch(/create_task/);
  });
});

describe('parsing a role reply', () => {
  it('reads NOTE, DESC and OWNERSHIP', () => {
    const out = parseRoleReply('NOTE: read t200\nDESC: A fuller description.\nOWNERSHIP: OK');
    expect(out).toEqual({ note: 'read t200', finalDesc: 'A fuller description.' });
  });

  it('treats KEEP as an explicit no-op, not as a new description', () => {
    expect(parseRoleReply('NOTE: fine\nDESC: KEEP\nOWNERSHIP: OK')?.finalDesc).toBeUndefined();
  });

  // A vague reply must never be able to blank the only text on a card.
  it('leaves the description alone when DESC is missing entirely', () => {
    expect(parseRoleReply('NOTE: fine\nOWNERSHIP: OK')?.finalDesc).toBeUndefined();
  });

  it('keeps a multi-line description whole', () => {
    const out = parseRoleReply('NOTE: n\nDESC: line one\nline two\nOWNERSHIP: OK');
    expect(out?.finalDesc).toBe('line one\nline two');
  });

  it('surfaces an ownership doubt, but only when it is not OK', () => {
    expect(parseRoleReply('NOTE: n\nDESC: KEEP\nOWNERSHIP: this is design work')?.ownershipDoubt).toBe('this is design work');
    expect(parseRoleReply('NOTE: n\nDESC: KEEP\nOWNERSHIP: OK')?.ownershipDoubt).toBeUndefined();
  });

  it('returns nothing when the contract was not followed, so the caller keeps what it had', () => {
    expect(parseRoleReply('Sure! I had a look and it seems fine.')).toBeUndefined();
  });
});

describe('a role agent fails open', () => {
  it('returns undefined when the model throws, rather than failing the run', async () => {
    const model: ModelClient = { name: 'boom', complete: async () => { throw new Error('provider down'); } };
    const out = await runRoleAgent({ role: 'engineer', owner: 'Avery Chen', title: 't', desc: 'd' }, { model, tracker: memoryTracker({ tasks: [] }) });
    expect(out).toBeUndefined();
  });
});

describe('roleOf', () => {
  it('maps a canonical name to its archetype, case-insensitively', () => {
    expect(roleOf('Avery Chen')).toBe('engineer');
    expect(roleOf('  avery chen ')).toBe('engineer');
  });
  it('returns undefined for someone not on the roster', () => {
    expect(roleOf('Nobody At All')).toBeUndefined();
  });
});

// ── Board agent ──────────────────────────────────────────────────────────────

describe('selecting what deserves an agent', () => {
  it('picks thin items with a known owner', () => {
    expect(selectForDelegation([item()])).toHaveLength(1);
  });

  it('skips an item whose owner is not on the roster — there is no role to speak for them', () => {
    expect(selectForDelegation([item({ assignee: 'Nobody At All' })])).toHaveLength(0);
  });

  it('skips a well-described new task, because there is nothing to look up', () => {
    expect(selectForDelegation([item({ finalDesc: 'x'.repeat(200) })])).toHaveLength(0);
  });

  it('picks a well-described item anyway when it touches an existing card', () => {
    expect(selectForDelegation([item({ finalDesc: 'x'.repeat(200), existingTaskId: 't200' })])).toHaveLength(1);
  });

  it('caps the number of delegations, because each one is a model call', () => {
    const many = Array.from({ length: MAX_DELEGATIONS + 5 }, (_, i) => item({ item: i + 1 }));
    expect(selectForDelegation(many)).toHaveLength(MAX_DELEGATIONS);
  });
});

describe('delegation merges field by field, never wholesale', () => {
  it('takes the improved description', async () => {
    const items = [item()];
    const model = scripted([{ text: 'NOTE: n\nDESC: A much fuller description of the work.\nOWNERSHIP: OK' }]);
    await delegateToRoleAgents(items, { model, tracker: memoryTracker({ tasks: [] }) });
    expect(items[0]!.finalDesc).toBe('A much fuller description of the work.');
  });

  /**
   * The containment test. An agent that could rewrite `category` would walk past every gate in the
   * repo by talking, so the merge must not be able to carry one even if the model emits it.
   */
  it('cannot change the category, the list, or the assignee', async () => {
    const items = [item({ category: 'NEW_TASK', list: 'backend', assignee: 'Avery Chen' })];
    const model = scripted([
      { text: 'NOTE: n\nCATEGORY: DUPLICATE\nLIST: design\nASSIGNEE: Rowan Diaz\nDESC: new text\nOWNERSHIP: OK' },
    ]);
    await delegateToRoleAgents(items, { model, tracker: memoryTracker({ tasks: [] }) });

    expect(items[0]!.category).toBe('NEW_TASK');
    expect(items[0]!.list).toBe('backend');
    expect(items[0]!.assignee).toBe('Avery Chen');
  });

  it('keeps the pipeline description when the agent fails', async () => {
    const items = [item({ finalDesc: 'original' })];
    const model: ModelClient = { name: 'boom', complete: async () => { throw new Error('down'); } };
    const out = await delegateToRoleAgents(items, { model, tracker: memoryTracker({ tasks: [] }) });
    expect(items[0]!.finalDesc).toBe('original');
    expect(out).toHaveLength(0);
  });
});

// ── The anti-fabrication rule ────────────────────────────────────────────────

const exec = (over: Partial<ExecuteResult> = {}): ExecuteResult => ({
  actions: [],
  created: 0,
  commented: 0,
  skipped: 0,
  refused: 0,
  failed: 0,
  unsupported: 0,
  ...over,
});

describe('the run summary reports the executor, never the intention', () => {
  it('does not claim a create the executor did not apply', () => {
    const out = summariseRun(
      exec({
        failed: 1,
        actions: [
          {
            item: 1,
            category: 'NEW_TASK',
            title: 'Add rate limiting',
            ops: [],
            outcome: 'planned',
            ok: false,
            results: [{ op: { kind: 'createTask', listKey: 'backend', title: 'Add rate limiting', assignees: [] }, outcome: { status: 'failed', detail: 'tracker 500' } }],
          },
        ],
      }),
      [],
      []
    );

    expect(out).not.toMatch(/created: Add rate limiting/);
    expect(out).toContain('1 failed');
  });

  it('names a create only when an operation actually applied', () => {
    const out = summariseRun(
      exec({
        created: 1,
        actions: [
          {
            item: 1,
            category: 'NEW_TASK',
            title: 'Add rate limiting',
            ops: [],
            outcome: 'planned',
            ok: true,
            results: [{ op: { kind: 'createTask', listKey: 'backend', title: 'Add rate limiting', assignees: [] }, outcome: { status: 'applied', resultId: 't1' } }],
          },
        ],
      }),
      [],
      []
    );
    expect(out).toContain('created: Add rate limiting');
  });

  it('reports a refusal as needing a human, never as a failure', () => {
    const out = summariseRun(
      exec({
        refused: 1,
        actions: [
          {
            item: 1,
            category: 'UPDATE',
            title: 'Move to done',
            ops: [],
            outcome: 'planned',
            ok: false,
            results: [{ op: { kind: 'setStatus', taskId: 't1', status: 'done' }, outcome: { status: 'refused', detail: 'card is in protected status "blocked"' } }],
          },
        ],
      }),
      [],
      []
    );
    expect(out).toMatch(/refused \(needs a human\).*protected status/);
    expect(out).toContain('0 failed');
  });

  it('carries held items and ownership doubts through to the summary', () => {
    const out = summariseRun(
      exec(),
      [{ item: 2, title: 'Something ambiguous', category: 'NEW_TASK', gate: 'possible missed duplicate', question: 'q' }],
      [{ item: 1, role: 'engineer', owner: 'Avery Chen', enrichment: { note: 'n', ownershipDoubt: 'looks like design work' } }]
    );
    expect(out).toMatch(/held for a human: Something ambiguous \(possible missed duplicate\)/);
    expect(out).toMatch(/ownership doubts raised: Avery Chen — looks like design work/);
  });
});
