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

## What an agent may propose — and what decides it

An agent proposes; the gates decide. Nothing below is applied as stated.

| Field | Proposes |
|---|---|
| `DESC` | a fuller description, or `KEEP` |
| `CATEGORY` | a different one of `NEW_TASK` / `DUPLICATE` / `SUBTASK` / `UPDATE` / `RELATE` |
| `LIST` | a different list key |
| `ASSIGNEE` | a different owner |
| `OWNERSHIP` | "not this person's work, and I cannot name who" |

Every one of those is copied **by name** onto a *copy* of the item, and then the whole deterministic
gate set — the same `applyGates` Pass 2b runs, not a second copy of it — is re-run over the result:

```
agent proposes → applyProposals (named fields, onto a copy) → applyGates → clean | held
```

**A proposal the gates refuse becomes a human hold, never a write.** Propose an unknown list key and
the routing gate holds the item. Propose an assignee who is not on the roster, or not valid for that
list, and it holds. Raise an ownership doubt without naming a successor and it becomes an uncertain
field on `assignee`, which holds and asks the human your own reason.

**The description is re-gated too, and that is the case worth stating.** Rewriting prose cannot
change routing, so skipping `applyGates` for description-only proposals looks like a free
optimisation — and it would let an agent turn "tidy the onboarding docs" into "rotate the api key
that leaked in the onboarding docs" and have that written unreviewed. The `critical` gate reads the
description, so it fires on the re-gate exactly as it would have on the first pass.
`agents.test.ts` pins that case directly.

This is why the merge is by named field rather than `{...item, ...reply}`. A wholesale merge would
also let a reply set `tier2Cited` — the flag the evidence gate reads — and an agent that can set its
own evidence flag walks past the evidence gate by talking. There is a test that smuggles `tier2Cited`
into an enrichment and asserts it does not land.

### What the shipped recordings actually show

Worth stating before you read a green `--agents` run as evidence the mechanism does something.

Across all eight recorded scenarios the role agents produced **three proposals, and all three agreed
with what Pass 2a had already decided** — each proposed `CATEGORY: UPDATE` on an item 2a had already
marked `UPDATE`. Every other field came back `KEEP`. **Zero proposals were refused by the gates,
because none of them contradicted anything.**

So the re-gate path is wired and exercised, and no recording demonstrates it *changing* an outcome.
What proves it works is `run.test.ts`, with scripted replies rather than recordings: a proposed
unknown list key holds, an off-roster assignee holds, an ownership doubt holds and carries the
agent's own reason into the question, a surviving proposal reaches the writer, and an agent is never
handed an item the gates already held.

That split is deliberate and is the repo's usual standard. A recording can only show what one model
happened to say on one day; if the feature needed a model to disagree in order to be demonstrated,
the demonstration would be the weather. But it does mean the honest claim is **"the path is proven by
test, not by recording"** — and a reader who wants to see it fire should run the tests, not the demo.

### This is what §5's "authority to write" means

PRD §5 describes the Board agent as *"the orchestrator above the role agents, holding board state and
authority to write."* Read literally that sounds like a write handle, and building it that way would
put a model in the write path and cost the guarantee the README leads with.

**Production does not work that way either.** Its board agent proposes, and one script enforces the
protected-status guard, the duplicate check and read-only mode. "Authority to write" there means *its
decisions result in writes* — not that it performs them. Pass 2c is this repo's equivalent of that
script. Proposing into the gates is the faithful port: the agent genuinely decides, and something
deterministic and auditable is still the only thing that writes.

An earlier version of this layer could change one prose field. That was safe, and it was not
orchestration.

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
