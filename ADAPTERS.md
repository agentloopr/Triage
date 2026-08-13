# Tracker adapters

Three ship: `memory` (in-process, the reference implementation), `clickup` (REST v2), `linear`
(GraphQL). One contract suite runs against all three.

```bash
TRACKER=memory   # default; no credentials, no network
TRACKER=clickup  # CLICKUP_API_TOKEN + CLICKUP_TEAM_ID
TRACKER=linear   # LINEAR_API_KEY

npm run board                  # read the configured tracker and print what the pipeline would see
npm run board -- --tracker linear
```

`npm run board` exists so that switch has an **observed effect** you can run rather than a claim you
have to trust. It calls `listTasks` through [`makeTracker()`](src/trackers/factory.ts) and the shared
snapshot renderer, and holds no code path that writes — proving the seam should never require writing
to somebody's board. A missing credential is a loud error, never a silent fallback to `memory`.

**The scenario demo deliberately ignores `TRACKER`** and always replays against the in-memory board.
Fixtures must not reach a real workspace because a developer left `TRACKER=clickup` in their `.env`.
Embedders pick their adapter with `makeTracker()` and pass it to `runPipeline`.

## The rule

> **The pipeline speaks canonical member names and list keys. Only the adapter ever sees a tracker
> id.**

This is what makes the seam real rather than ceremonial. Every gate, prompt, parser and the entire
categorization taxonomy is tracker-blind because of it — which is why the Linear adapter was written
from scratch against a completely unchanged pipeline, and why the contract suite can assert
`renderSnapshot` output contains member names and no raw ids.

Break this rule and you have an interface, not an abstraction: ids leak into prompts and gates, and
swapping trackers means rewriting the taxonomy.

## The interface

[`src/trackers/index.ts`](src/trackers/index.ts) — six methods:

```ts
getTask(id)                    // null if absent; must NOT throw
getComments(id, limit?)
listTasks({ listKeys?, includeClosed? })
renderSnapshot(tasks)          // the prompt-facing board text
apply(op): Promise<OpOutcome>
capabilities                   // what this tracker can express at all
```

`renderSnapshot` is adapter-owned but delegates to one shared renderer, so the prompt-facing format
is defined in exactly one place and **nothing ever parses it back**. In production each adapter
rendered its own text and the pipeline regex-parsed it into structure — two parsers and a whole
class of drift.

## `OpOutcome`: five values, and `unsupported` ≠ `failed`

```ts
'applied' | 'unchanged' | 'refused' | 'unsupported' | 'failed'
```

A write is not a boolean. Returning `failed` for something the tracker simply cannot express sends
someone debugging a working system, and makes the post-write audit report a problem no retry can
fix. See [ARCHITECTURE.md](ARCHITECTURE.md#opoutcome--a-write-is-not-a-boolean).

## Capabilities

**The pipeline does not read these; the adapter answers with them.** `planOperations` emits a
`moveList` unconditionally and the adapter replies `unsupported` — that is what keeps the pipeline
tracker-blind, and it is why `unsupported` is a distinct `OpOutcome` rather than a failure. The
contract suite asserts the difference between adapters is real, so the matrix below is checked rather
than asserted.

| | memory | clickup | linear |
|---|---|---|---|
| `moveList` | ✅ | ❌ **v2 has no endpoint** | ✅ *(an issue can change team)* |
| `linkTasks` | ✅ | ✅ | ✅ |
| `subtasks` | ✅ | ✅ | ✅ |
| `priority` | ✅ | ✅ | ✅ |
| `dueDate` | ✅ | ✅ | ✅ |
| `protectedStatusGuard` | ✅ | ✅ | ✅ |

The ClickUp/Linear `moveList` split is the entire reason two real adapters exist rather than one. A
capability matrix where every row is identical proves nothing about the abstraction.

## The contract suite is the acceptance test

[`adapter.contract.test.ts`](src/trackers/adapter.contract.test.ts) — **one suite × three adapters**,
plus a pair of tests asserting the capability differences are real. ClickUp and Linear run against
hand-written fakes that speak each vendor's documented wire format, replayed through a `fetch` stub,
so CI needs no credentials.

Eleven behaviours, every adapter, no exceptions:

- create → `getTask` round-trips
- an absent task returns `null` rather than throwing
- **`setAssignees` REPLACES, it does not append**
- an already-correct value reports `unchanged`, not `applied`
- a status outside the list's vocabulary → `failed`, **naming the valid vocabulary**
- a card in a protected status → `refused`
- an unavailable capability → `unsupported`, **never** `failed`
- a self-link is refused
- comments round-trip
- `renderSnapshot` renders every task it lists, with id, title, list and assignee
- `renderSnapshot` speaks member names and list keys, never tracker ids

### Three that are easy to get wrong

**`setAssignees` replaces.** ClickUp's wire format only speaks `add`/`rem`, so the obvious
implementation — send the desired set as `add` — *appends*. It quietly leaves the previous owner on
every card the pipeline touches, with no error anywhere and no failing request. The adapter computes
add/rem against the current assignees.

**Status vocabulary is per list, and casing is load-bearing.** ClickUp rejects a status whose
spelling does not match that list's own vocabulary. The adapter reads the vocabulary and sends back
the tracker's exact casing, with the fallback chain `not started` → `to do` → `todo` → first
`type=="open"`. A status that does not exist **fails loudly**, rather than leaving the card where it
was and reporting success.

**Auth headers differ and neither is guessable.** ClickUp takes the raw token with **no `Bearer`
prefix**. The ClickUp fake rejects a `Bearer ` prefix specifically, so an adapter that adds one fails
the suite rather than failing in production.

## Writing a fourth adapter

1. Implement `TrackerAdapter`. Map your tracker's vocabulary to member **names** and list **keys** at
   the boundary — never let an id past it.
2. Set `capabilities` honestly. Anything false must return `unsupported` from `apply`, not `failed`.
3. Add your adapter to the `ADAPTERS` array in `adapter.contract.test.ts` and write a wire fake.
4. Green suite = the pipeline can drive it.

## What the suite cannot prove

The fakes were written **from the same reading of the vendor docs as the adapters they test**. A
shared misreading passes both.

So the suite proves an adapter's own logic — replace-versus-append, refusals, vocabulary resolution,
pagination, capability mapping, error handling — and **cannot prove an endpoint path, a field name,
or an auth header**. Only a live call settles those.

**Both have had one, 2026-08-12**, against real throwaway accounts.

**ClickUp:** create, get, setStatus, an unknown status rejected by name, setAssignees, addComment,
the protected-status refusal against a real card in a real status, `moveList` reporting `unsupported`
rather than `failed`, and a snapshot carrying the member name with no raw ClickUp id. Eighteen
checks, all passed, the test card deleted itself afterward.

**Linear:** the same shape, plus the check that only Linear can make — **two assignees on one issue
correctly report `unsupported` rather than silently keeping the first**, which is the exact failure
this repo's `OpOutcome` design exists to name. Seventeen checks, all passed, the test issue deleted
itself afterward.

Both smokes ran through the ops registry and the adapter, the same code path the pipeline uses — not
a curl script standing in for the adapter.
