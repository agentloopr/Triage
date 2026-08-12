# The agent layer

Two agent types sit above the pipeline, off by default:

```bash
AGENTS_ENABLED=true          # or:
npm run demo -- --agents     # replays the agent recording, offline
```

> **This is the one part of the repo that was built rather than extracted.** Everything else came out
> of a system that has governed a real board for months. The agent loop did not — production's loop
> lives in a separate runtime this repo does not ship. It is off by default for that reason. See
> [LIMITATIONS.md](LIMITATIONS.md#the-agent-layer-has-no-production-history).

## The two types

| | Board agent | Role agents (8) |
|---|---|---|
| How many | one per run | one per archetype |
| Decides | which items need a closer look | how an item reads to its owner |
| Tools | none — it orchestrates | `get_task`, `get_task_comments`, `search_tasks` |
| Can write | **no** | **no** |
| Built from | `boardAgent.ts` | the loop + its profile + its state |

A role agent is the existing tool loop given three things that already existed: its **profile**
(`config/roles/<role>.md`) as instructions, its **state** (`config/roles/state/<role>.json`) as
memory, and `readOnlyTracker` as its tools. See [ROLES.md](ROLES.md).

## Where it sits

```
… 2a categorization → 2b contract check → [ AGENT LAYER ] → 2c execute → 2d audit
```

**After every gate, before the writer.** Both halves of that matter:

- *After the gates*, so an agent cannot talk its way past one. By the time an agent sees an item, the
  category, the routing and the holds are already decided.
- *Before the writer*, so anything it improves is what actually lands on the board.

## Two guarantees, both structural

### 1. An agent cannot write

Not because the prompt asks it not to — because `readOnlyTracker` wraps the adapter and refuses every
`apply()`, and no write tool is offered in the first place. Prompt text is a request; a wrapper is a
guarantee. A model that has been jailbroken, confused, or fed a malicious transcript still has no
code path to a mutation.

**Pass 2c remains the only writer, and it has no model in it.** The agent decides; deterministic code
executes. That is also what production does: its board agent *proposes*, and a script enforces the
protected-status guard, the duplicate check and read-only mode.

### 2. An agent cannot claim a write that did not happen

Production's board prompt carries this warning verbatim, because it was learned expensively:

> You MUST NOT claim a task was created — no fake success lines, no URLs — unless you actually ran
> create-task and the result is a full task object with a new id.

A model summarising its own work narrates what it *intended* to do. So it is not asked. `summariseRun`
is deterministic code over `ExecuteResult`: an item is reported as created only when an operation
returned `applied`. The rule is enforced by construction, not by instruction — the same reasoning as
the read-only wrapper.

## What an agent may change

Exactly two fields, both prose, merged **field by field**:

| Field | Effect |
|---|---|
| `DESC` | a fuller description, or `KEEP` to leave it alone |
| `OWNERSHIP` | `OK`, or a doubt that surfaces in the summary — **advisory only** |

It may **not** change the category, the list, or the assignee. Merging the reply wholesale would hand
an agent the ability to rewrite a category and walk past every gate in the repo by talking, so the
merge copies named fields and ignores everything else. There is a test that emits `CATEGORY:
DUPLICATE` from an agent and asserts nothing moved.

## Failure behaviour: open, at every level

| What fails | What happens |
|---|---|
| One role agent errors or times out | that item keeps the pipeline's own answer |
| A reply does not follow the output contract | same — no `NOTE:` line means no enrichment |
| The whole agent layer throws | an `alert` event, and the run continues unchanged |
| The loop hits its turn cap | one final call that forces an answer, so the parser never sees an empty string |

Enrichment is a nicety. Nothing downstream depends on it, and turning agents off changes no
disposition.

## Cost

One model call per delegated item, plus a turn for each tool the agent chooses to use. Delegation is
capped at `AGENT_MAX_DELEGATIONS` (default 8) and turns at `TOOL_LOOP_MAX_ITERATIONS` (default 6), so
a bad batch cannot run away.

Which items get delegated is decided by **code, not by a model** — an item qualifies when it has an
owner on the roster and either a thin description or an existing card whose history is worth reading.
Asking a model which items need attention would spend a call to save calls.

## Recording and replay

The agent path has its own recordings, one per provider, because an agent run makes strictly more
calls than a deterministic one:

```bash
npm run demo -- --agents                        # DeepSeek recording, offline
npm run demo -- --agents --provider anthropic   # Claude recording, offline
npm run record -- --all --agents                # re-record (needs a key)
```

Cassettes are keyed per turn (`role/engineer/item-…/turn-2`) and a turn that used tools is stored as
`.json` carrying the tool calls. The format used to keep only the reply text, which meant a replayed
agent turn came back with no tool calls and the loop exited immediately — an agent path that could
not have run offline at all.
