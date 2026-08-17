# Limitations

What this repo cannot tell you, and what you should not infer from a green test run.

These limits are real and none of them is a bug. They are collected here because otherwise you meet
them by accident, scattered across four other documents — and a limit you discover late is worth
much less than one you were handed up front.

> **This page is *what you cannot rely on*.** For *why it is that way and what happened*, see
> [EXTRACTION.md](EXTRACTION.md), which carries the narrative.

## Measurement

**No precision or recall figures, anywhere.** Scoring accuracy needs a hand-labelled corpus — a
human deciding, independently and unseen, what each item *should* have been. There isn't one. The
only alternative is a model grading a model, which is a system agreeing with itself; the number
would look authoritative and carry no information.

What ships instead is hand-verified `expected.json` goldens — dispositions checked item by item.
That is enough to pin behaviour and **not** enough to claim accuracy. Volume, disposition and hold
rate are honest here; accuracy is not reported. See [EVAL.md](EVAL.md).

**`miss_rate` reports *not scored*, never a pass.** A dropped item leaves no event, so there is
nothing in the trace to score — scoring it from the trace would be measuring a blind spot with the
blind spot. It appears as *not scored* deliberately, rather than as a silent zero that reads like
success.

## What the test suite covers

The test suite covers the **deterministic layers**: prompt construction, parsers, gates, the
plan, the writes, the audit, the idempotency layers. Cassettes freeze the model's replies, which is
what makes CI free and reproducible — and is exactly why:

**A number can be measured and still be wrong.** The model-call counter behind
[PROVIDERS.md](PROVIDERS.md)'s cost table sat at one call site rather than on the seam, so the agent
layer — which holds the client directly — was never counted. Agents on and agents off both reported
16 calls for scenario 01 while the agent recording held 21 replies. The figure looked measured, was
reproducible, and under-reported paid calls by a fifth. Fixed by counting at the seam; worth
remembering because a wrong number is more persuasive than no number.

**Being tested and being reachable are different properties, and only one used to be checked.** Four
times this repo shipped a module with real code and real tests that nothing in production imported —
the observability seam, `makeToolLoopRunner`, `src/sources/`, and the hold-resume path. A test suite
cannot see this: the test imports the module directly, so it is exercised and unreachable at once,
and coverage reads as fine. `reachable.test.ts` now fails on any module only a test imports. It found
the fourth one.

**A prompt edit that makes the model itself reason worse will not fail this suite.** Every test will
stay green while the model quietly gets worse at the judgement the prompt asks for. Detecting that
needs a re-record and an eval diff, which is the workflow [EVAL.md](EVAL.md) prescribes. Do not read
a green run as "that prompt change was safe."

**Two cross-item flags compute and never block.** The pipeline raises `over_subtask` (more than two
subtasks proposed under one parent) and `near_dup_pair` (two near-identical `NEW_TASK`s on the same
list in one run) as *flags* — emitted as events, printed by the runner, stopping nothing. Only
`missed_dup` was promoted to a hold that actually drops the item. So a run can print a near-duplicate
warning and create both cards anyway.

These are named here because the alternative is finding them on your own board: a signal that reaches
a log and not a human is the failure mode the `missed_dup` fix exists to correct, and two siblings
still have it.

*A third used to be on this list.* A role agent's `ownershipDoubt` — "this is not that person's
work" — reached the run summary and stopped nothing, so a card landed on the wrong person unless a
human happened to read the log. It now becomes an uncertain field on `assignee`, which holds the item
and asks the human the agent's own reason. Worth recording as the shape of the fix rather than
deleting silently: the signal was already there and already correct, and what was missing was a path
from it to a gate.

**No scenario asserts a *model-disagreement* hold**, and the qualifier is the whole sentence. This
paragraph read "no scenario asserts a human hold" until an outside audit pointed out that
`06-github-activity` pins two — which it does, and should.

The distinction is which kind of hold can be pinned at all:

- A hold resting on a **judgement** — two independent reads disagreeing about a genuinely ambiguous
  item — varies run to run. Three consecutive re-recordings of one identical fixture gave three
  different answers. That variance is *why* the disagreement goes to a human, and it means no
  cassette can pin it.
- A hold resting on a **missing or uncertain field** does not vary that way. `06-github-activity`
  asserts two, because a code feed says who wrote a change and never who owns the follow-up.

The gates themselves are proven separately and deterministically, with scripted replies, in
`contractGates.test.ts` and `run.test.ts`.

**The de-tuning A/B never ran, and never can.** The strongest available guard on replacing tuned
prompts with generic ones is to record each prompt before and after and diff the eval dimensions.
That needs a tuned baseline *in this repo*, and there has never been one — the public prompts were
authored generic from the start. So nothing here can tell you whether a generic worked example makes
the model reason worse than a tuned one. It is the single largest unmeasured risk in the extraction.

## Integrations

Both adapters pass the shared contract suite against hand-written fakes that speak each vendor's
documented wire format. That proves the adapters' own logic — replace-versus-append, the
protected-status refusal, vocabulary resolution, pagination, capability mapping, error handling. It
cannot prove **an endpoint path, a field name, or an auth header**, because the fake was written from
the same reading of the docs as the adapter it tests — a shared misreading passes both. Only a live
call settles those.

**ClickUp: live-verified, 2026-08-12.** A full smoke — create, get, setStatus, an unknown-status
rejection, setAssignees, addComment, the protected-status refusal against a real card, `moveList`
reporting `unsupported`, and the snapshot carrying the member name and never the raw ClickUp user id —
ran against a real workspace and passed on every check, then deleted its own test card.

**Linear: live-verified, 2026-08-12.** The same smoke, run against a real team — create, get,
setStatus, an unknown-status rejection, a single assignee, **two assignees correctly reporting
`unsupported` rather than silently keeping one**, addComment, the protected-status refusal against a
real issue, and a snapshot carrying the member name and never the raw Linear user id. Seventeen
checks, all passed, then deleted its own test issue.

**The write half of both smokes — create, setStatus, setAssignees, addComment, the protected-status
refusal — is not reproducible from this repo, and that is the one claim here you cannot check.** Both
were run by hand against throwaway accounts and both deleted their own test objects; no script or log
for the write path is tracked, because committing one would mean shipping something that creates and
deletes objects in whatever workspace a reader points it at — the wrong thing to hand out by default.

**Part of the read half already was: `npm run board`** reaches a real tracker read-only via
`listTasks`, and ADAPTERS.md has pointed there all along. It doesn't touch `getTask` or `getComments`,
so `scripts/smokeTracker.ts` (`npm run smoke:tracker`) extends the same read-only path to those two —
still never `apply()`, still cannot write to your board. Together they re-verify the part of the
2026-08-12 claim a read-only script can safely check: auth headers, endpoint paths, and field mapping
against the real API, not a wire fake. Excluded from CI for the same reason as always — a public
repo's CI cannot hold your workspace's credentials.

**Both adapters are now live-verified.** What remains unmeasured is everything a short smoke cannot
reach: sustained load, rate-limit behaviour under real traffic, and every edge case the vendor's API
has that a handful of manual calls does not exercise. See [ADAPTERS.md](ADAPTERS.md).

**The corrections loop closes through a CLI, not through the pipeline.** The pipeline *reads*
corrections — they reach both the 2a and 2b prompts, and the cross-item gate consults the
not-duplicate pairs. Nothing in the pipeline *writes* one: a human does, with `npm run correct`.
There is no Slack button and no approval UI here, because the surface that captures a correction is
product, and every team's is different.

**Ingestion transport is out of scope; reads and normalization are not.** No webhooks, no polling
schedules, no cron, no OAuth refresh, and no queue — those are product surface. What does ship is
[`src/sources/`](src/sources) (GitHub, Gmail and Drive read clients) and [`src/ingest/`](src/ingest)
(five payload shapes → one `IngestedSource`). Scheduling a read and handing the result to
`runPipeline` is your problem.

This distinction is narrower than an earlier version of this file drew it. "Ingestion is out of scope
entirely" was written once and then cited as though it were a requirement, and the repo shipped two
sources on the strength of it — which is how a source-agnostic pipeline came to look like a meeting
pipeline with a second entry point.

**All three source clients were verified live by hand** (not by any test — see the table below).
The GitHub client made real reads on
2026-08-13, including one against a busy public repo that returned **85 pull requests, 15 issues and
9 commits** — which is the only way to exercise the mapping that matters, since the `/issues`
endpoint returns PRs and issues in one stream and this repo's own history contains neither. See
[ADAPTERS.md](ADAPTERS.md#the-source-clients-all-three-verified-live).

**Gmail is live-verified too**, on a real six-message thread: every sender resolved, every timestamp
ISO and none epoch-zero (so `internalDate` was really present), and all six bodies extracted through
the multipart walk and base64url decode.

**Drive is live-verified**, against a sheet holding four conversation nodes — two comments, each with
a reply, one thread resolved. The client returned two events: the open comment and its reply, the
resolved pair dropped. One count, two properties: the resolved-thread filter, and reply flattening
carrying the reply's **own** author rather than its parent's.

That smoke also corrected this client's own docstring. It claimed that omitting the `fields`
parameter returned a stripped projection behind a 200 — the silent failure this repo keeps naming.
Drive actually returns `400 — The 'fields' parameter is required for this method`. It fails loudly,
and the comment described a trap that does not exist.

**Rate-limit handling is tested against fakes and has never been observed live.** No smoke hit a real
429, and provoking one would mean hammering a third party's API to test their throttle rather than
our handling of it. The tests cover the wait itself, both of GitHub's signals, and the 403 that must
*not* be retried.

Worth recording how the first version of those tests failed. They asserted only that a retry
happened, and passed against a client that ignored `Retry-After` entirely and waited a blind five
seconds instead of the one the header asked for. Nothing failed — the retry did occur. The only
symptom was one test reporting 5003ms where its siblings reported 1002ms. **A rate-limit test that
does not measure the wait is a test that a loop exists**, and the assertions now measure it.

`npm run pull` is the command that settles it — client → normalizer → pipeline, needing only a
read-scoped credential. It exists because without it the clients had **zero call sites outside their
own tests**, which is this repo's recurring failure shape and not something to ship a third time.
Point it at a repo you can read and the GitHub half of this section is reproducible on your own
credential; the Gmail and Drive halves are waiting for someone to do the same.

**All three normalizers now run end-to-end** — `06-github-activity`, `07-email-thread` and
`08-drive-activity` each go through the full 1 → 2d chain offline, so "the pipeline does not care
which source produced it" is demonstrated for all five kinds rather than argued for three of them.
That covers the *normalizers*. The **clients** are a separate question, and this document used to
answer it twice, incompatibly — "all three are live-verified" above, "still fake-tested only" here.
Both sentences were reaching for a real distinction and neither stated it. Once, precisely:

| | |
|---|---|
| **Automated tests** | fakes only. Every scenario replays a recorded payload; **no test has ever called GitHub, Gmail or Drive** |
| **Live verification** | performed by hand on 2026-08-13 against real accounts, described above |
| **Reproducible from this repo** | **no** — the smokes left no committed script or log, so treat them as testimony |

The way to settle it on your own credential is `npm run pull`. See
[ADAPTERS.md](ADAPTERS.md#the-source-clients-have-had-no-live-call-at-all).

**Both providers now have all eight scenarios**, and the three source ones diverge more than the five
meeting ones — Claude extracts fewer items from a feed that states no commitments out loud. See
[PROVIDERS.md](PROVIDERS.md). The gates cannot correct for an item that was never extracted, which is
the `miss_rate` blind spot above, so a source that reads like a log rather than a conversation
amplifies whatever extraction bias your model already has.

*(`npm run demo -- --provider anthropic` still names any scenario it has no recording for rather than
replaying it into an empty result, because an absence reported as a divergence is worse than one
reported as an absence. There are none at present.)*

**Retrieval is a null interface.** [`Retriever`](src/pipeline/retrieval/index.ts) is declared and
wired into passes 2a/2b, and the only implementation that ships returns **no documents, ever**. The
production system runs a live vector substrate, but its retrieval quality has never been measured, so
any claim made here would be unfalsifiable. Better an obvious hole than a number nobody checked.

So: **nothing in this repo demonstrates that retrieval helps.** The interface exists to show the
architecture accommodates a knowledge layer, and that is the entire claim — swapping in a real
retriever is a change nobody here has evaluated the output of. Retrieved text also never satisfies
the evidence-citation gate: that gate wants card comment history, and a document is not one.

## Model behaviour

**Prompt caching fires, but only on the repeated half.** Passes 2a and 2b split their prompt into a
cacheable `system` prefix and a per-item `user` tail; measured hit rate on a full scenario is **87.6%
of prompt tokens**, up from zero. What it does *not* do: cache entries are ephemeral, so a cold run
still pays full price for the first call of each pass, and passes 0–1.7 are one call each so there is
no prefix for them to share. **DeepSeek reports no hit rate at all** — its caching is server-side and
automatic, so the figure above is an Anthropic number and does not generalize. See
[PROVIDERS.md](PROVIDERS.md).

**Token counts are not comparable between providers.** Claude reports **1.7×** the input tokens for
byte-identical prompts — a tokenizer difference, not a bigger prompt. Any per-token cost comparison
across vendors that skips this step is wrong by whatever the tokenizer ratio happens to be.

**The two providers disagree about what counts as an action item** — on one of five scenarios in the
current recordings, and which scenarios differ moves whenever anything is re-recorded. Every
downstream layer behaves identically given each provider's own replies — the pipeline is portable.
Extraction is not, and this repo has no ground truth to say which model is right. See
[PROVIDERS.md](PROVIDERS.md).

**Passes 2a and 2b are plain completions**, with evidence pre-fetched host-side, where production
uses tool-using agents that fetch extra card history on demand. The cost is real: worse duplicate
recall on semantically-worded matches, where the phrasing differs enough that the candidate selector
never surfaces the card. The whole-board Jaccard backstop and the evidence-citation gate catch the
fallout — but as **human holds**, not as silent correct answers.

The agent layer (below) recovers some of that, and is off by default.

### The agent layer has no production history

**This is the one part of the repo that was built rather than extracted, and it is the caveat that
matters most** — because everything else here rests on the opposite claim.

Production's agent loop lives in a separate runtime that this repo does not ship and could not
extract: the pipeline is a *client* of it, and its prompts are wired to internal workspace files. So
the board agent and the eight role agents in `src/agents/` were written **for this repo**. They are
tested — the read-only guarantee and the anti-fabrication rule both have tests — but tested is not
the same as *has governed a real board for months*, which is what is true of everything around them.

That is why `AGENTS_ENABLED` defaults to **false**. What turning it on can and cannot do:

- It **can** propose a description, a category, a list or an assignee, and raise an ownership doubt.
- Every proposal is re-run through `applyGates` — the same gates Pass 2b uses, not a copy — so one
  the gates refuse becomes a human hold rather than a write.
- It **cannot** write anything, and **cannot un-hold**: agents only ever see items that already
  passed the gates, so there is no path from an agent to an item a gate stopped.

Measured across both recordings and all eight scenarios, **no proposal has changed a final
category** — `agentReplay.test.ts` compares each item's final category against Pass 2a's and fails
if one does. (This paragraph previously said agents "cannot change a category, a list, an assignee".
That was true before Part B and stopped being true when the re-gate shipped; an outside audit found
it still standing here.) See [AGENTS.md](AGENTS.md).

## What a provider outage costs you

`Pass 2b` holds when its blind read cannot run, so an outage produces **a batch of questions rather
than a batch of unverified writes**. That is the intended trade and it has a cost worth knowing
before you point this at a busy queue: a sustained provider failure can hold an entire run, and every
one of those holds says the same thing — `independent verification unavailable` — which is a gate
about the pipeline, not about the item.

`npm run answer -- <id> --approve` writes such an item on the first read alone, deliberately: the
decision, the evidence and the gates are all intact, and only the disconfirming check is missing.
Approving is a considered choice to accept one read, which is exactly what the earlier fail-open
behaviour did **without asking**.

## What production has and this does not

The PRD this repo was built to never asked for any of the four below, and their absence is a
decision rather than an oversight. They are listed because a reader comparing this to a description
of the production system should not have to discover the difference themselves — and because one of
them sits directly under the claim that human-in-the-loop is this system's strongest coverage.

### The approval surface is a CLI, not a chat app

**The gates that decide to hold are here in full.** All fifteen of them, with the ordering, the
questions, and the persistence. What is not here is production's asking-and-answering surface: ten
Block Kit modules — clarify, duplicate-resolution, critical approval, task rating — with modals,
per-actor authorisation so the wrong person cannot resolve someone else's question, and TTLs on
pending slots. Roughly 4,600 lines.

Here, a hold is announced on the `items:held` event and answered with
[`npm run answer`](src/cli/answer.ts). **The seam is real, not aspirational**: the event carries
`notifyAssignee`, and `PendingHumanStore.resolve` is the same call the CLI makes, so a Slack or
email surface is a consumer of two existing interfaces rather than a fork of the pipeline. That is
transport, and this repo's position on transport has not changed.

Be precise about what this costs: **nothing about which items hold, everything about how quickly a
human sees them.** A CLI nobody runs is a queue that grows.

### Files and attachments are absent entirely

Production ingests a file from Slack or Drive, has the agent classify intent — answer a question,
attach it to a task, or ask the human — with **no caption regex**, extracts text (directly, from an
office format, or through a vision model), then resolves *which* task by overlap scoring followed by
a semantic pick. Roughly 1,650 lines across six modules.

None of it is here. It needs a vision model, two more OAuth scopes and a file store, and the PRD
never asked for it. A source that arrives as a document rather than as text is out of scope.

### The correction loop is closed; the doorbell is missing

This one is usually stated backwards, so: **the substance ships.** A typed routing fact —
`npm run correct -- assignee --list backend --name "Avery Chen"` — is stored, merged into the
effective roster at [`identity.ts`](src/registry/identity.ts), and enforced by the deterministic
assignee gate on every later run. Not-duplicate pairs, list aliases, name aliases and free-form
notes work the same way, and `05-corrections` demonstrates the whole path.

What is missing is only the conversational front door. In production a teammate DMs their agent
*"Remember that Taylor is on the platform team"*, the agent emits a structured fact line, and it
lands in the same store. Here you type it. The loop is closed either way; the doorbell is a Slack
app.

### Per-agent isolation is a deployment concern

Covered in [ARCHITECTURE.md](ARCHITECTURE.md) — production runs the agents in a separate runtime
with a sandbox and per-agent credentials; here they run in-process and read-only. The seam to hang
your own on is `ModelClient`.

## Scale

Nothing here has been run against a large board. Two things scale with board size and neither has a
measured ceiling:

- The whole-board duplicate backstop is a Jaccard scan of **every open card for every `NEW_TASK`** —
  O(items × cards) per run.
- The board snapshot puts **every card** in the prompt. Descriptions are capped (500 chars by
  default, `DEFAULT_DESC_MAX_CHARS`); the number of cards is not capped at all.

Both are fine at fixture scale. Neither has been profiled, so the honest statement is that no ceiling
is documented — not that none exists.

### Concurrent writers: safe on the state, unproven on the throughput

Every file this repo writes — holds, idempotency, corrections, role memory, the roster — is mutated
under one cross-process lock, and `src/state/crossProcess.test.ts` asserts that by starting sixteen
real processes. That is what makes two operators or two workers safe **against each other's state**.

It is worth saying how that was found, because it is the failure mode this whole document exists for:
three of those stores held an *in-process* lock, every test in the suite passed, and every test ran
in one process — where an in-process lock and a cross-process one are indistinguishable. An outside
audit spawned processes and measured twenty of twenty workers accepting the same delivery as new.
Nothing in the suite could have caught it, and nothing in the suite was failing.

What is *not* claimed is that this is service-grade synchronization:

- The lock is a **bounded spin on a lock file**, with a 5s acquisition timeout and a 30s staleness
  threshold. It suits a CLI holding it for a few file operations. It is not a queue, it has no
  fairness guarantee, and a worker pool large enough to keep it permanently contended will start
  seeing timeouts rather than waiting politely.
- Breaking a stale lock re-reads the holder's identity before unlinking it, but **the re-read and the
  unlink are not one atomic step**. The window is microseconds against a 30-second threshold; closing
  it properly needs an OS-level advisory lock, which is right for a service and disproportionate here.
- No throughput figure is published, because none has been measured.

So: concurrent CLI processes will not lose each other's writes. A high-concurrency long-running
service is a different engineering problem, and this repo has not solved it.
