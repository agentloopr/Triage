# Architecture

One entry point, `runPipeline(source, deps)`. Everything else is injected.

```
idempotency (event) → idempotency (source) → Pass 0 → idempotency (content)
  → Pass 1 → 1.5 → 1.7 → evidence prefetch → Pass 2a → 2b → 2c → 2d
```

Ingestion is out of scope — webhooks, polling, auth and retries are product surface, and every
team's are different. The pipeline starts at a normalized `IngestedSource` and a `TrackerAdapter`.

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

When the two reads disagree across the new↔existing boundary, the item is **held for a human** rather
than resolved by picking a winner.

## The four seams

Each exists because there was a real second implementation to write, not because an interface looked
tidy.

| Seam | Implementations | Why it is a seam |
|---|---|---|
| [`ModelClient`](src/providers/index.ts) | `deepseek`, `anthropic`, `cassette` | The cassette impl is what makes the demo run offline. See [PROVIDERS.md](PROVIDERS.md). |
| [`TrackerAdapter`](src/trackers/index.ts) | `memory`, `clickup`, `linear` | Three adapters, one contract suite. See [ADAPTERS.md](ADAPTERS.md). |
| [`IdempotencyStore`](src/idempotency/index.ts) | `memory`, `jsonFile` | Three layers, below. |
| [`IngestedSource`](src/ingest/index.ts) | `transcript`, `channel` | A meeting and a channel log run the identical 1 → 2d chain. |

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
| Role profiles | **open** — prompt loses context, warns | A badly-edited markdown file must not kill a run |
| Observability | **open** — always | A tracing backend must never take down the thing it traces |
| **Ops registry degraded** | **CLOSED — holds the entire batch** | An empty roster means every assignee resolves to nobody. Writing against it would put real work on no one's board and report success. |

That last row is the only fail-closed path, and it holds *all* items, not the ones that happen to
look affected — a registry that cannot be trusted cannot be trusted per-item either.

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

Answering replays the *stored decision* through `planOperations` → `executeOperations` with **no
model call**. A second inference would mean the human approved one thing and something else was
written. Approving a hold that has no per-item decision behind it (the registry-degraded batch hold)
is **refused rather than invented**.

## What is deliberately not here

Retrieval is a null interface, ingestion is out of scope, and there is no agent runtime — 2a and 2b
are plain completions with evidence pre-fetched host-side. See [LIMITATIONS.md](LIMITATIONS.md) for
what each of those costs, and [EXTRACTION.md](EXTRACTION.md) for how the production system differs.
