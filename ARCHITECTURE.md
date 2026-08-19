# Architecture

One entry point, `runPipeline(source, deps)`. Everything else is injected.

```
idempotency (event) → idempotency (source) → Pass 0 → idempotency (content)
  → Pass 1 → 1.5 → 1.7 → evidence prefetch → Pass 2a → 2b → 2c → 2d
```

**Reading a service and normalizing its payload**: [`src/sources/`](src/sources) reads GitHub, Gmail,
Drive and Slack, and [`src/ingest/`](src/ingest) turns five payload shapes into one `IngestedSource`.
The pipeline starts there, and at a `TrackerAdapter`.

**Transport** ships two reference wirings on top of that seam — a cron-able poller
(`npm run poll`, [`src/cli/poll.ts`](src/cli/poll.ts)) and a signature-verified webhook receiver
(`npm run serve`, [`src/cli/serve.ts`](src/cli/serve.ts) over
[`src/transport/webhook.ts`](src/transport/webhook.ts)) — but TLS termination, process supervision,
queue durability and horizontal scale are still yours; see LIMITATIONS.md for exactly what that
means.

## The passes

| Pass | Name | What it is *for* |
|---|---|---|
| **0** | cleanup | Repair transcription damage before anything reasons over it. Speaker labels, timestamps, obvious ASR mangling. |
| **1** | inventory | Extract what was actually asked for. The only pass that reads the source looking for work. |
| **1.5** | critic | Attack Pass 1's output. What did it invent, and what did it miss? |
| **1.7** | consolidator | Merge, dedupe, anchor. "Build it, then send it" is one deliverable, not two. |
| — | evidence prefetch | Fetch card history for the candidates 2a will need. Host-side, so 2a is a plain completion. |
| **2a** | categorization | `NEW_TASK` / `DUPLICATE` / `SUBTASK` / `UPDATE` / `RELATE`, against the live board. |
| **2b** | contract check | An independent **blind** re-derivation. Disagreement becomes a human hold. |
| **2c** | execute | The only writer. Deterministic — **no model in the write path.** |
| **2d** | audit | Did the board end up how 2c said it would? |

Passes 0–1.7 read; 2a–2b decide; 2c writes; 2d verifies. A model never touches the write itself — 2c
takes a plan and applies it, which is why a wrong write requires a wrong *plan*, not a stray token.

## Pass 2b is blind, and that is the headline claim

The verification prompt is built from the **Pass-1 inventory item only**. It never sees 2a's
category, list, assignee, or matched card. Two independent reads that agree are evidence; a second
read shown the first answer is a rubber stamp.

This is the kind of property that decays quietly — someone passes the manifest item in to "give it
more context" and every test still passes, because the outputs get *more* agreeable, not less. So it
has [`blindness.test.ts`](src/pipeline/blindness.test.ts), which regex-asserts the rendered 2b prompt
excludes every 2a-derived field, and fails loudly when it does not.

When the two reads would produce a genuinely different **write** — not merely a different category
label — the item is **held for a human** rather than resolved by picking a winner. `writeDispute()`
(`src/pipeline/gates/contractGates.ts`) compares each read's action (create / comment / create-child /
nothing / link) and, when both name one, its target card: `UPDATE card-A` vs `UPDATE card-B` is a
dispute (same action, different target), `UPDATE card-A` vs `DUPLICATE card-A` is a dispute (comment
vs nothing), and `DUPLICATE card-A` vs `DUPLICATE card-B` is not (both write nothing). This replaced an
earlier rule that only compared which side of the new-versus-existing-card boundary each label fell
on, and trusted 2a on anything that stayed on the same side — which meant a 2a=DUPLICATE read that a
blind re-derivation would have written *something* for was silently trusted and skipped, never held.

An optional `disputeArbiter.ts` can settle some of these disputes against live tracker state instead of
holding — a cited card that no longer exists, or a comment that already covers the disputed work —
before falling back to a human. It is **off by default** (`DISPUTE_ARBITER_ENABLED=false`), so out of
the box every detected dispute still holds, just more of them are detected than before. Its mechanical
first step (does each cited card still exist?) resolves on card-missing only, not card-archived —
`BoardTask` carries no `archived` field in this repo, unlike the production tracker it was ported from.

## The four seams

Each exists because there was a real second implementation to write, not because an interface looked
tidy.

| Seam | Implementations | Why it is a seam |
|---|---|---|
| [`ModelClient`](src/providers/index.ts) | `deepseek`, `anthropic`, `cassette` | The cassette impl is what makes the demo run offline. See [PROVIDERS.md](PROVIDERS.md). |
| [`TrackerAdapter`](src/trackers/index.ts) | `memory`, `clickup`, `linear` | Three adapters, one contract suite. See [ADAPTERS.md](ADAPTERS.md). |
| [`IdempotencyStore`](src/idempotency/index.ts) | `memory`, `jsonFile` | Three layers, below. |
| [`IngestSource`](src/ingest/index.ts) | `transcript`, `channel`, `github`, `gmail`, `drive` | Five payload shapes, one 1 → 2d chain, and no pass that branches on which. |
| [`SourceClient`](src/sources/index.ts) | `github`, `gmail`, `drive`, `slack` | Reads a live service. The interface has **no write method**, so read-only is a type, not a policy. |
| [`Retriever`](src/pipeline/retrieval/index.ts) | `null` (default), `local` | An external knowledge layer, wired into passes 2a/2b. Neither implementation is the live vector substrate production runs — see LIMITATIONS.md. |

`localRetriever` is opt-in via `RETRIEVAL_DIR`; unset, `deps.retrieval` is omitted entirely, so no
retrieval happens at all: no call, no block, and a prompt byte-identical to one built before the
interface existed. A test asserts that byte-identity, because it is what keeps every recorded
cassette replaying.

### The rule that makes the tracker seam real

> **The pipeline speaks canonical member names and list keys; only the adapter ever sees a tracker
> id.** Every gate, prompt, parser and the entire categorization taxonomy is tracker-blind because
> of it.

Without that rule an "abstraction" leaks ids into prompts and gates, and swapping trackers means
rewriting the taxonomy. With it, the Linear adapter was written from scratch against an unchanged
pipeline.

## Three-layer idempotency

Not redundancy — each layer catches a different real failure:

| Layer | Catches | Fires |
|---|---|---|
| `event` | the same webhook delivered twice (platforms retry on a slow ack) | before anything |
| `source` | the same meeting re-processed after a restart or manual re-trigger | **before any model call** |
| `content` | the same content arriving under a *different* id | after Pass 0 |

The **ordering is the part worth copying.** The source check runs before the source text is read and
before the first token is spent, so a redelivery costs zero — not a full run thrown away at the end.
The content check sits after cleanup, where it can see what no id-based check can.

One method, `checkAndMark`, not `has` + `mark`. The natural-looking `if (await store.has(k)) return;
await store.mark(k)` is a check-then-act whose race window is exactly as wide as the work between the
two calls, and two concurrent deliveries of the same event both pass it.

```bash
npm run demo -- --twice   # proves it: second run, zero model calls, $0.00
```

**And the test-and-set is atomic across processes, which it was not for most of this repo's life.**
The persistent store held an in-process lock — correct-looking, and the wrong primitive for a file
whose entire reason to be on disk is that the next reader is a different process. Measured with 20
workers racing one key: 2–4 accepted it as new against an empty file, and **20 of 20** against a
75,000-record one, because the read-modify-write window scales with parse time. Every test in the
suite passed throughout, because every test ran in one process, where the two locks are
indistinguishable. `src/state/crossProcess.test.ts` starts real processes; it is the only test here
that can see the difference.

Two things came out of that, not one. The fix is a single lock — `withExclusiveFileLock` — now used
by every file this repo writes: holds, idempotency, corrections, role memory, the roster. The second
is that **`prune` was implemented, exported, unit-tested and called by nothing**, so expired records
outlived the deployment and the race window grew with the file. It runs at startup now, in
`buildLiveDeps`, under the same lock.

## Fail-open and fail-closed

The asymmetry is deliberate, and it is the design. **Degrade toward doing less; never toward writing
more.**

| Component | On failure | Why |
|---|---|---|
| Pass 0 cleanup | **open** — raw source used | Worse input beats no run |
| Pass 1.5 critic | **open** — Pass 1's inventory kept | Same |
| Pass 1.7 consolidator | **open** — the 1 + 1.5 inventory kept | Same |
| Pass 1 inventory | **returns null** | Nothing earlier to fall back to; the caller decides |
| Evidence prefetch | **open** — `probeOk: false`, never throws | Missing evidence is a weaker decision, not a wrong one |
| **Pass 2b blind read** | **CLOSED — the deterministic gates run, then the item is held** | An item written without its second read was the only place this system degraded toward writing *more*. A thrown error and a reply carrying none of the contract's fields take the same path: both mean no independent read happened |
| Role profiles | **open** — prompt loses context, warns | A badly-edited markdown file must not kill a run |
| Observability | **open** — always | A tracing backend must never take down the thing it traces |
| **Ops registry degraded** | **CLOSED — holds the entire batch** | An empty roster means every assignee resolves to nobody. Writing against it would put real work on no one's board and report success. |

**Two fail-closed paths, and they close differently.** The registry holds *all* items, not the ones
that happen to look affected — a registry that cannot be trusted cannot be trusted per-item either.
The blind read holds only the items whose own verification failed, because that failure is per-item
and a partial outage should not stop the work it did not touch.

**Pass 2b used to fail open**, on the argument that a flaky call must not silently block well-formed
work. That argument is real and it lost to a simpler one: an item written without its second read was
indistinguishable in the output from one that had it, so *every automatic write has passed two
independent model reads* was true except when it quietly was not. Holding costs a batch of questions
during a provider outage; failing open cost the repo's headline claim.

**Two details that are easy to get wrong, and were.** The deterministic gates run *before* the
verification hold is raised — the first fail-closed version skipped them, so an item with an unknown
list key was held as "verification unavailable" carrying the ungated manifest item, and approving it
wrote work the gates would have refused. And an *empty* reply is a failure, not agreement: every
optional field on the verdict defaults to permissive, so a 200 with no body disagreed with nothing
and the item was written on one read. Closing the throw and leaving the silence fixed the visible
half of one bug.

The row was missing from this table entirely until an outside audit went looking — the most
consequential fail-open in the system, absent from the document that exists to enumerate them.

**A truncated reply is a failure, not a shorter success.** This is the subtle one: a long *partial*
parses cleanly and silently ships half an inventory. `CompletionResult.truncated` exists so callers
must decide, rather than a `finish_reason` reaching a log and nothing else.

## `OpOutcome` — a write is not a boolean

```ts
| { status: 'applied' }      // it changed
| { status: 'unchanged' }    // already in that state
| { status: 'refused' }      // a guard said no; retrying will not help
| { status: 'unsupported' }  // this tracker cannot express the operation at all
| { status: 'failed' }
```

In the system this was extracted from, the tracker path returned success for `applied`, `unchanged`
**and** the protected-status refusal — collapsing the one case that needed a human into the two that
did not.

**`unsupported` ≠ `failed` is load-bearing.** ClickUp v2 has no move-list endpoint; that is a fact
about the tracker, not an error in the run. Reporting it as a failure would send someone debugging a
working system, and would make the audit in 2d report a problem that no retry can fix.

## Human holds

A hold is a question, and questions outlive processes. Held items are persisted through
[`PendingHumanStore`](src/state/pendingHuman.ts) **before** the hold is announced — a lost
notification is recoverable, a lost question is not.

### What actually decides a hold

Worth stating precisely, because "the gates hold it" hides three different kinds of decision, and
only one of them involves a model at the moment of blocking.

| | Gates | Decided by |
|---|---|---|
| **Pure code over structured data** | unknown list key · assignee not in team roster · assignee not valid for list · referenced/parent/RELATE task id not on the board · subtask list ≠ parent list · RELATE self-link · evidence not cited · uncertain field(s) · vague update — card not confirmed · update — card match not confident · possible missed duplicate · registry degraded · **critical — credentials / client PII / production deploy / client-facing send** |  The board, the registry, and a literal read of the manifest. No model is consulted. |
| **A code rule over a model's stated verdict** | legitimacy — may not be a trackable task | `legitimacyHolds()` combines Pass 2b's legitimacy verdict with 2a's confidence and the source's ASR provenance — but its `not_a_task` branch fires on the verdict alone, no other input required. Genuinely a model decision, not a softened one. |
| **Two independent model reads disagreeing** | category dispute | A different *shape* of model decision — a disagreement between two reads, not a threshold on one — but not the only gate a live model verdict can decide. |

**This is the opposite of what the design anticipated.** The system this was extracted from expected
deterministic blocking to be the rare case and model judgement the norm; here thirteen of fifteen
gates never ask a model anything. That is not an accident of porting — it is what happens when the
model's job is narrowed to producing a *manifest* and every structural claim in that manifest is
checked against data the pipeline already holds.

The practical consequence: **most holds are reproducible.** Feed the same manifest and board twice
and the twelve gates in the first row above — everything except `critical`, covered in its own
section next — fire identically. `category dispute` is the one **documented** to move between two
runs of the same fixture: three consecutive re-recordings gave three different answers (see
[EXTRACTION.md](EXTRACTION.md)). `legitimacy` is built the same way — a plain function of Pass 2b's
own live verdict, not of anything 2a decided — so it can move too, on a borderline item; it just
never has, because no current scenario's recording lands close enough to that boundary to show it.

Two scenario goldens *do* now assert a `category dispute` hold — `01-meeting-mixed` (item 5, a
SUBTASK-vs-UPDATE read) and `08-drive-activity` (item 4, a DUPLICATE-vs-something-else read that the
old boundary rule would have let through as a silent duplicate skip). That is new since the dispute
rule widened from the boundary check to the write-equivalence check above, which catches disputes the
old rule was blind to. It does not make the gate reproducible in the way the other eleven are: which
item, if any, trips it is still whatever the current recording's blind read happens to say, and a
future re-recording could see 2b agree with 2a on either item and go clean again — the same volatility
the prior paragraph describes, just now visible on fixture data instead of only asserted in
`contractGates.test.ts` and `run.test.ts`. `legitimacy` remains unpinned by any golden for the same
reason. See [LIMITATIONS.md](LIMITATIONS.md#what-the-test-suite-covers).

### The one hold that does not mean "I am unsure"

Every gate above fires because something is missing or two reads disagree. **`critical` fires when
the pipeline is completely confident and the write is high-stakes anyway** — a credential rotation,
a production deploy, client PII, a client-facing send. Nothing about those items is ambiguous, which
is exactly why every other gate waves them through.

It is a different question, so it is asked first: ordering does not decide whether the item is
written — every gate holds — it decides which question a human sees. "This touches credentials,
confirm" has to beat "I need an assignee for this", or a high-stakes write gets filed as a routine
one.

**The patterns are compiled constants, and that is the security property.** No environment variable,
correction, registry entry, prompt or model output can widen, narrow or disable them; only a boolean
turns the gate off. Upstream of this gate an agent proposes fields and, in any deployment ingesting
email or public issues, the source text is attacker-controlled. A review step its own input can talk
out of reviewing is not a review step. The guarantee is not *"these patterns are complete"* — it is
**whatever they catch, no input stops them catching it**, and
[`criticalGate.test.ts`](src/pipeline/gates/criticalGate.test.ts) asserts that directly.

Coverage is deliberately narrow, because a gate that fires on a tenth of an ordinary week teaches
people to approve without reading. **Porting it found two live defects in the original rule table**,
both caught by writing down what the gate must *not* catch: `deploy(ing)? (to )?prod` required the
verb to sit beside the target, so "Deploy the billing service to production" — the commonest
phrasing of the riskiest item in the table — was missed; and `card number` matched "card number of
items in the backlog", because English reuses "number of X" for quantity.

None of the eight scenarios trips it, so it ships proven by test rather than by fixture. That is
stated here rather than left for a reader to notice.

**Answering a hold has three outcomes, not two**, because an item can plan several operations — an
UPDATE emits a comment and then any of setStatus, setDueDate, setPriority, setAssignees, moveList,
and `moveList` is `unsupported` on ClickUp by design.

| What landed | The hold | Why |
|---|---|---|
| nothing | **stays open** | Safe to retry. A queue entry is cheap; a lost human decision is not |
| some of it | **closes** | A retry would re-apply what already worked — a second comment on the card. The remainder is reported and left to a human |
| all of it | **closes** | Done |

Three earlier versions of this got it wrong, each in a way the next one introduced:

- It deleted the hold and *then* executed, so a tracker outage destroyed the human's decision.
- It read `failed === 0` as success. `refused` and `unsupported` also mean nothing changed — and a
  refusal reported as an approved write is the quiet one, because it looks finished.
- It ran the Pass 2d audit *before* closing the hold. The audit re-reads the tracker, so a read
  timeout threw past the close, leaving a written card **and** an open hold — and the retry wrote a
  second card. A post-hoc check must never be able to undo the record of what already happened.

**Approving is exclusive.** The hold carries a claim token with a five-minute TTL, so two concurrent
`npm run answer -- <id> --approve` do not both execute; measured before the claim existed, they put
two cards on the board from one decision. The TTL matters as much as the claim: a process that dies
mid-write must not lock the item forever, which is a worse failure than the double write. The claim
is released when nothing landed, so a retry is immediate rather than waiting out the TTL.

The claim is taken under a **cross-process lock** — `openSync(..., 'wx')`, which creates or throws
`EEXIST` in one atomic syscall — because `npm run answer` is a CLI and two operators are two
processes. An in-process lock cannot see the other one at all. The lock is broken after 30s as stale,
for the same reason the claim expires: a queue nobody can ever answer again is worse than the race it
prevents.

It is the **only** lock here. There used to be a second, in-process one, and its existence was the
problem: three stores held it, it read as protection in every review, and none of them were protected.
A codebase with a cheap lock and an expensive one invites reaching for the cheap one.

**Writing the ownership token is part of acquiring the lock, not a best effort afterwards.** Two
rules that are each correct — a holder deletes only a lock it can identify as its own, and an empty
lock is treated as fresh rather than stale, because a file created microseconds ago cannot be dead —
combined into a permanent one if the token never landed. Nobody was entitled to remove it: not the
holder, which could not recognise it, and not a passer-by, which saw an empty holder. One transient
`ENOSPC` was enough to wedge a state file until a human deleted the lock by hand.

Both halves are fixed, because they fail differently. A token write that **throws** unlinks and
rethrows, and the callback does not run. A process **killed** between the two syscalls runs no
cleanup at all, so the second rule had to give: an empty lock is judged by age like any other, and
30 seconds between two adjacent syscalls is not a live process. That is the same inference already
made about a stamped lock whose holder went quiet — an exemption removed, not an assumption added.

**A live claim blocks either decision, not just another approve.** It once guarded approvals only, so
a skip walked past an in-flight approval and deleted the hold — measured as one card written *and*
the same hold reported skipped. Two confirmations, opposite meanings, one decision.

**Approving a DUPLICATE resolves it.** A DUPLICATE plans zero operations, because deciding not to
write is the correct outcome. Counting applied operations alone read that as "nothing landed", so
approving a held duplicate answered "not written" forever and `--skip` was the only exit — and skip
means *drop this*, not *yes, it really is a duplicate*.

**Approved work goes through the same tail as pipeline-written work** — `finalizeWrite`: role memory,
then a Pass 2d audit against a fresh board read. It used to go through neither, which made the one
item a human personally signed off the only item in the system nobody verified afterwards.

**Persistence is an injection, not a default.** Pass `pendingHuman` to `runPipeline` (or
`pendingHumanPath` to `runScenario`) and holds survive a restart; omit it and a hold exists only in
the returned result and the `items:held` event. The demo omits it deliberately — a fixture replay has
nobody to answer — so *out of the box, holds are announced and not stored*. That is stated here
rather than left for you to discover, because the ordering guarantee above is worth nothing if the
store is absent.

Answering replays the *stored decision* through `planOperations` → `executeOperations` with **no
model call**. A second inference would mean the human approved one thing and something else was
written. Approving a hold that has no per-item decision behind it (the registry-degraded batch hold)
is **refused rather than invented**.

```bash
npm run answer                      # every open hold, and why each is held
npm run answer -- <id> --approve    # replay the stored decision
npm run answer -- <id> --skip
```

That command was missing until `reachable.test.ts` was written. `resumeHold` existed, was tested and
was correct, and **nothing could call it** — so the repo could raise a question and had no way to
answer one. "Human-in-the-loop" named a loop that did not close, behind a green suite. It is the
fourth defect of that exact shape here, and the reason there is now a test for the shape itself.

## What running this at production scale actually looks like

The system this was extracted from runs as **two processes on one host**, and the split is worth
knowing before anyone plans a deployment from this repo.

| | Production | Here |
|---|---|---|
| Pipeline | an Express app | `runPipeline()`, a function |
| Agents | a separate per-agent runtime | `roleAgent.ts`, in-process |
| Agent context | a workspace directory per agent, outside version control | `config/roles/*.md` + `config/roles/state/*.json`, in the repo |
| Agent credentials | injected per agent from a per-agent directory | none — role agents are read-only |
| Isolation | one sandboxed process per agent, its own API port | none needed; nothing spawns |
| Bounds | a turn cap and a wall-clock budget per run | `TOOL_LOOP_MAX_ITERATIONS`, `AGENT_MAX_DELEGATIONS` |

The shape is the same on both sides — an agent with a profile, read-only tools, and a hard bound on
how long it may think. What the second process buys is **isolation and per-agent secrets**, which
matter when twelve agents run for twelve real people against live credentials, and matter not at all
for a reference that ships no secrets and delegates at most eight items.

**The runtime is not here and could not be.** It is a separate product in its own repository, and
its prompts load an agent's profile and routing rules from a workspace by filename — two of which
are exactly what this repo's CI identifier guard rejects. Publishing the supervisor without the
thing it supervises would ship a launcher for a binary nobody can obtain.

So the honest framing: **this repo publishes what the agents are, not the machine that runs them.**
If you need per-agent isolation, that is a deployment decision you make on your own infrastructure,
and the seam it hangs from is `ModelClient` — swap the in-process client for one that calls out to
whatever runs your agents, and nothing above it changes.

## What is deliberately not here

Retrieval has no live-evaluated implementation, and ingestion *transport* is only a reference wiring —
a poller and a signature-verified webhook receiver ship; TLS termination, process supervision, queue
durability, horizontal scale and OAuth token refresh do not. Passes 2a and 2b are plain completions
with evidence pre-fetched host-side; an optional agent layer sits above them, off by default and
unable to write — see [AGENTS.md](AGENTS.md). See [LIMITATIONS.md](LIMITATIONS.md) for
what each of those costs, and [EXTRACTION.md](EXTRACTION.md) for how the production system differs.
