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
| Tools | none by default; the read tools **plus writes** under `BOARD_AGENT_WRITES` | `get_task`, `get_task_comments`, `search_tasks` |
| Can write | **no** by default · **yes, through the gates** under `BOARD_AGENT_WRITES` | **no**, in every configuration |
| Built from | `boardAgent.ts` | the loop + its profile + its state |

A role agent is the existing tool loop given three things that already existed: its **profile**
(`config/roles/<role>.md`) as instructions, its **state** (`config/roles/state/<role>.json`) as
memory, and `readOnlyTracker` as its tools. See [ROLES.md](ROLES.md).

## Where it sits

```
default                 … 2a → 2b → [ AGENT LAYER ] → 2c execute ───────────→ 2d audit
BOARD_AGENT_WRITES=1    … 2a → 2b → [ AGENT LAYER ] → board agent writes ──→ 2d audit
```

**After every gate, before the writer.** Both halves of that matter:

- *After the gates*, so an agent cannot talk its way past one. By the time an agent sees an item, the
  category, the routing and the holds are already decided.
- *Before the writer*, so anything it improves is what actually lands on the board.

## Two guarantees, both structural

### 1. A role agent cannot write

Not because the prompt asks it not to — because `readOnlyTracker` wraps the adapter and refuses every
`apply()`, and no write tool is offered in the first place. Prompt text is a request; a wrapper is a
guarantee. A model that has been jailbroken, confused, or fed a malicious transcript still has no
code path to a mutation. This holds in every configuration; there is no flag that gives a role agent
a write tool.

**By default, Pass 2c is the only writer and it has no model in it.** The agent decides;
deterministic code executes.

**`BOARD_AGENT_WRITES` changes who performs the write, and only for the board agent.** On, the board
agent is handed the already-gated plan plus write tools, and writes it through `governedTracker` —
which re-runs every deterministic gate over anything it originates, so a write the gates refuse
becomes a hold rather than a card. That is the shape PRD §5 describes and the shape production runs.
Off — the default — none of that code is in the process at all. The guarantee in each mode is stated
exactly in `SECURITY.md`, including how the second one is smaller than the first.

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

**Say this plainly, since the mechanism above can read as more than it is: a proposal gets
deterministic gates, not a second blind model read.** [Pass 2b's blind re-derivation](ARCHITECTURE.md#pass-2b-is-blind-and-that-is-the-headline-claim)
happens once, before any agent sees the item. A proposed category/list/assignee change afterward is
checked against the board and the roster, the same way a hand-typed correction would be — never
independently re-derived by a second model call the way 2a's own answer is. Widening that would mean
either a second blind model pass just for agent proposals, or narrowing what proposals may touch;
neither is built, and this repo would rather say that than let the word "gate" imply more rigor than
three deterministic checks actually provide.

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

**The same is true of the board-write recordings, and for a reason worth recording.** Across all eight
scenarios on both providers, `--board-writes` produces **zero refused writes**. Every write the board
agent originates passes the gates.

The first recorded attempt was not like that: it produced five refusals in a single scenario, all of
them `unresolvable field(s): FINAL_DESC`. That was not the model failing the gate — `create_task`
listed `description` as optional while the gate requires it, so the tool was lying about what a valid
write looks like and the model believed it. Fixing the schema took the refusals to zero.

Which leaves the same honest position as above: the governed write path is wired and exercised end to
end, and **no shipped recording shows a gate refusing a write.** What proves it does is
`governedTracker.test.ts` with scripted replies — an off-roster assignee, an unknown list key, a
credential-touching title, a subtask whose parent history was never read, and an operation with no
manifest form at all. Each is refused, and the inner adapter is asserted never to have seen it.

### This is what "authority to write" means

The internal spec this repo was built from describes the Board agent as *"the orchestrator above the
role agents, holding board state and authority to write."* (That spec is private and not shipped
here — the quote is given in full so the argument stands without it.)

**Production means that literally.** Its board agent runs a create command, and a guard layer decides
whether the command lands: the protected-status guard, the duplicate check, read-only mode. The agent
performs the write; the guards govern it. An earlier version of this file claimed production's board
agent only *proposed* and never performed writes. That was wrong, and it mattered — it was used here
to argue that a read-only board agent was the faithful port when it was actually the divergent one.

`BOARD_AGENT_WRITES` is that shape, ported. On, the board agent writes through `governedTracker`,
which is this repo's equivalent of that guard layer: every write it originates is rebuilt into a
manifest item and re-run through the same gates the pipeline's own answer faced.

**The default is still off, and that is a deliberate smaller claim rather than the faithful one.**
Nothing here has governed a real board for months, the way the pipeline has. Defaulting a model into
the write path of a repo people clone and point at their own tracker is not a claim this repo has
earned. Off, no model reaches the tracker at all and the README's headline property is literal; on,
it is the production shape and `SECURITY.md` states precisely what narrows.

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
