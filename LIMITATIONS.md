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

**A prompt edit that makes the model itself reason worse will not fail this suite.** Every test will
stay green while the model quietly gets worse at the judgement the prompt asks for. Detecting that
needs a re-record and an eval diff, which is the workflow [EVAL.md](EVAL.md) prescribes. Do not read
a green run as "that prompt change was safe."

**Two cross-item flags compute and never block.** The pipeline raises `over_subtask` (more than two
subtasks proposed under one parent) and `near_dup_pair` (two near-identical `NEW_TASK`s on the same
list in one run) as *flags* — they are emitted as events and printed by the runner, and they stop
nothing. Only `missed_dup` was promoted to a hold that actually drops the item. So a run can print a
near-duplicate warning and create both cards anyway. This is named here because the alternative is
finding it on your own board: a flag that reaches a log and not a human is the failure mode the
`missed_dup` fix exists to correct, and two siblings still have it.

**No scenario asserts a human hold.** Whether two independent reads disagree about one genuinely
ambiguous item varies run to run — three consecutive re-recordings of one identical fixture gave
three different answers. That variance is *why* the disagreement is worth surfacing to a human in
the first place, and it means no cassette can pin it. The gates that produce holds are proven
separately and deterministically, with scripted replies, in `contractGates.test.ts` and
`run.test.ts`.

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

**Neither smoke is reproducible from this repo, and that is the one claim here you cannot check.**
Both were run by hand against throwaway accounts and both deleted their own test objects; no script or
log is tracked, because a committed smoke would need credentials to mean anything. Everything else in
this repo can be re-run by a reader — treat these two paragraphs as testimony rather than evidence.

**Both adapters are now live-verified.** What remains unmeasured is everything a short smoke cannot
reach: sustained load, rate-limit behaviour under real traffic, and every edge case the vendor's API
has that a handful of manual calls does not exercise. See [ADAPTERS.md](ADAPTERS.md).

**The corrections loop closes through a CLI, not through the pipeline.** The pipeline *reads*
corrections — they reach both the 2a and 2b prompts, and the cross-item gate consults the
not-duplicate pairs. Nothing in the pipeline *writes* one: a human does, with `npm run correct`.
There is no Slack button and no approval UI here, because the surface that captures a correction is
product, and every team's is different.

**Ingestion is out of scope entirely.** No webhooks, no polling, no auth, no retry logic. The
pipeline starts at `runPipeline(source, deps)` with a normalized source. Getting a meeting into that
shape is your problem.

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

That is why `AGENTS_ENABLED` defaults to **false**. Turning it on changes no disposition: agents may
improve how an item reads and may raise an ownership doubt, and they cannot change a category, a
list, an assignee, or write anything at all. See [AGENTS.md](AGENTS.md).

## Scale

Nothing here has been run against a large board. Two things scale with board size and neither has a
measured ceiling:

- The whole-board duplicate backstop is a Jaccard scan of **every open card for every `NEW_TASK`** —
  O(items × cards) per run.
- The board snapshot puts **every card** in the prompt. Descriptions are capped (500 chars by
  default, `DEFAULT_DESC_MAX_CHARS`); the number of cards is not capped at all.

Both are fine at fixture scale. Neither has been profiled, so the honest statement is that no ceiling
is documented — not that none exists.
