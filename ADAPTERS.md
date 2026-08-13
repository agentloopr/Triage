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

**Notion and Jira are the plausible next two.** Both express the concepts this interface needs — a
task with a title, a status vocabulary, an assignee, a parent — so neither would need the interface
widened, and Jira's transition model is the interesting one to get right because a status change is a
*transition id* rather than a name, which is precisely what `capabilities` and `unsupported` exist to
express.

**This is not a promise to connect anything.** Two adapters ship, a third is a documented exercise,
and a maintenance commitment to an open-ended list is not something this repo is making. If your
tracker cannot express an operation, the honest result is `unsupported` — not a widened interface
that pretends every tracker is the same.

## Reading a source is a different seam

Adapters *write*. [`src/sources/`](src/sources) *reads* — GitHub, Gmail and Drive — and it is a
deliberately separate interface with **no write method on it at all**. That is the same guarantee
`readOnlyTracker` gives the agent layer, moved one level earlier and enforced by the type rather than
by a wrapper that has to remember to refuse.

Those clients are held to the standard below just as the adapters are: proven against hand-written
wire fakes first, then smoked live. **All three are verified live** — see the last
section, and
[LIMITATIONS.md](LIMITATIONS.md#integrations).

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

**Neither is reproducible from this repo**, and it is the only claim here you cannot check. No script
or log is tracked, because a committed smoke needs credentials to mean anything. Treat the counts
above as testimony rather than evidence. What you *can* run is `npm run board`, which reaches a real
tracker through the same adapter — read-only.

### The source clients: all three verified live

**GitHub: live-verified, 2026-08-13.** Two reads through the real client, no script standing in for
it. Against `agentloopr/ops-agent-reference`: 11 commits, every author resolved, every timestamp ISO,
merged chronologically. Against `vitest-dev/vitest` over one day: **109 events — 85 pull requests, 15
issues and 9 commits.**

That second read is the one that mattered. The `/issues` endpoint returns pull requests *and* issues
in one stream, distinguishable only by a `pull_request` key on the payload, and the repo's own
activity contains neither — so the riskiest mapping in the client was reachable only against a busy
public repo. It separated all 100 correctly, and distinguished `merged` from `closed` (both arrive as
`state: closed`) via `pull_request.merged_at`. Also confirmed: the auth header shape, server-side
`since` filtering on both endpoints, short-read pagination, and no field falling back to `unknown`.

**Rate limiting is tested, not observed.** Six tests cover the branch that only runs on a bad day:
the `Retry-After` wait, the fallback to `x-ratelimit-reset` when that header is absent, GitHub's
secondary-limit 403 being retried, a **permissions** 403 not being retried, and a 404 not being
retried. They assert the *delay*, not just that a retry happened — see below for why that distinction
found a bug. **No smoke has hit a real 429**, and provoking one would mean hammering a third party's
API thousands of times to test their throttle rather than our handling of it. So what a fake cannot
settle stands: whether GitHub really signals a secondary limit the way this client assumes.

**Gmail: live-verified, 2026-08-13.** A real thread, six messages. Every `from` resolved, every
timestamp ISO and none of them epoch-zero — which is the check that matters, because it proves
`internalDate` was present and parsed rather than silently defaulting. **All six bodies extracted**,
which exercises the multipart walk and the base64url decode against mail a person actually sent
rather than a fixture built to be walkable.

**Drive: live-verified, 2026-08-13**, against a sheet carrying two comments — one open, one resolved,
with a reply on the resolved one. File metadata, revisions and comments all confirmed: the name
resolves, revisions carry an author and an ISO `modifiedTime`, and the comment came back with author,
content and timestamp intact.

**Filtering and flattening were proven together, by counting.** The file held **four conversation
nodes** — two comments, each with one reply, one thread resolved. The client returned **two events**:
the open comment and its reply, each as its own event. The resolved comment *and its reply* were both
dropped.

That single count settles two things at once. Dropping a resolved thread is the point — turning a
closed conversation into a card reopens by robot what a human decided was finished. And the reply
arrived carrying **its own author**, not the parent's, which is the whole of what flattening has to
get right: the reply came from a different account, and the event says so.

**One thing the smoke corrected: `fields` is required, not merely advisable.** This client's own
comment used to claim that omitting it returned a *stripped* projection — comments with no author,
content or timestamp behind a 200, the silent failure this repo keeps naming. Drive actually answers
`400 — The 'fields' parameter is required for this method.` It fails loudly. The comment described a
trap that does not exist and dressed a required argument as a defence against it. Corrected.

**None of this is reproducible from the repo**, for the same reason the tracker smokes are not: it
needs a credential to mean anything. Treat it as testimony. What you *can* run is
`npm run pull -- --source github --repo <any repo you can read>`, which is the same code path.
