# Extraction provenance

This repo is a hybrid extraction from a production system, not a rebuild and not a sanitized copy.
The architecture is the one that runs; the tuned few-shot examples are replaced with generic ones.

**Ported from:** the internal production repo, commit `8a5c75e801d21c18fd3eed4049a1abed662681a6`
(2026-08-11) — the commit immediately after a six-commit reliability and security review.

Recording the source commit matters because the two repos diverge from here. When a fix lands in one,
this line is how you work out whether the other already has it.

## What is deliberately different from production

| | Production | Here | Why |
|---|---|---|---|
| Passes 2a/2b | Tool-using agents that can fetch extra card history on demand | Plain completions; all evidence pre-fetched host-side | No agent runtime in a library. Costs duplicate recall on semantically-worded matches; the whole-board Jaccard backstop and the evidence-citation hold gate catch the fallout as human holds, not silent creates. |
| Read-only enforcement | Structural, via a wrapper script that refuses write subcommands | Enforced at the adapter | Same guarantee, fewer moving parts. |
| Ingestion | 8 webhooks, 14 cron routes, an Express app | Out of scope entirely | Ingestion is your problem; this repo starts at `runPipeline(source, boardSnapshot)`. |
| Per-person agents | 12 live agent runtimes with their own state and tool access | Role *profiles* that shape routing and prompt context | Shipping "8 role agents" would be the one claim a technical reader could puncture. |
| Per-role state | A `STATE.md` and journal per agent, rewritten on a schedule | One JSON file per archetype: what that role currently has open, plus human-maintained context | Same idea, scoped to what a pipeline can honestly maintain. Production's version is an agent's working memory; here it is a memo the pipeline writes after each run and reads back into the next one's prompt. No journal — nothing here would read one. |
| Read-only enforcement in agent passes | An environment variable read by a shell script | A wrapper around the adapter whose `apply()` refuses | Same intent, fewer moving parts, and the guarantee sits next to the thing it guards. |
| Tracker client | A 2,034-line bash script shelling out from TypeScript | Typed HTTP adapters for ClickUp and Linear | Most of that script was `jq` shaping. Three pieces were real logic and were carried across; see below. |
| Retrieval | A live vector substrate | A null retrieval interface | Retrieval quality has never been measured, so no claim about it would be falsifiable. |

## What was de-tuned, and how that was checked

The production prompts are tuned on real people, real clients, real card ids and a transcriber's
particular mistakes. None of that could ship. The plan for this repo assumed the tuned prompts would
be ported verbatim and stripped afterwards, in one deliberate high-risk pass; in practice the prompt
files were authored generic from the start.

That is a better outcome and a worse audit trail — nothing about "generic from the start" leaves
evidence. So each target was grepped for afterwards, and the verdicts are recorded here rather than
assumed.

| Tuned in production | Here | Checked by |
|---|---|---|
| A term/ASR glossary, and `LEARN_FACT:` examples naming a real person and project | Absent. Pass 0 carries a general "fix it only if you are confident" rule; taught facts are data, injected from a corrections file that ships empty | Prompt text; `state/corrections.ts` |
| A second glossary inside the transcript-reconcile prompt | Not ported — there is no reconcile pass here | — |
| ~28 worked example lines in the inventory prompt, one of them bilingual | Absent. **Pass 1 has no worked examples at all** — see below | `prompts/inventory.ts` |
| Container scaffolding, a hardcoded fallback list key, and a rule naming two real products | Generic. List keys come from the registry (`listKeys.join`); the rule is now "topic/keyword/product overlap is NOT containment" | `prompts/categorization.ts` |
| The category taxonomy — which had to **survive**, not be replaced | Intact, verbatim | `scaffolding.test.ts` pins seven fragments including the containment test and the evidence-citation requirement |
| Six worked verification cases carrying real card ids and a real client name | Six cases, fixture personas, invented client, synthetic ids | `scaffolding.test.ts` allowlists every id; CI greps for identifier shapes |
| Role-profile text, a GTM routing cheatsheet, a dated production incident, three real product names | Absent. Routing and roster come from the registry | Repo-wide grep |
| Fixtures, cassettes, docs | Clean | Repo-wide grep for internal product and person names, and for tracker-id shapes |

**One real leak was found this way**, and it is worth naming because of how it hid: a worked example
used `t-c3n8`'s predecessor — four characters lifted from a production ClickUp id, wearing the same
`t-` prefix as the fixtures. It matched no secret pattern, because a task id is not a secret, and it
matched no id-shape pattern, because it had been truncated. Only an allowlist of ids-we-invented
could catch it, so that is what now guards the prompts.

**Pass 1 has no few-shot examples**, unlike production. This is a deliberate difference rather than an
omission: its behaviour is pinned by locked regression cases instead — F2 and F3 both failed on first
record here, because the freshly-written prompt had dropped production's exclusions for ongoing norms
and for people-management asides. The prompt was corrected until they passed.

**The before/after A/B did not happen, and could not have.** The plan's strongest de-tuning guard was
to record each prompt live before and after the edit and diff the eval dimensions. That needs a tuned
baseline in this repo, and there has never been one. What exists instead: the frozen manifest grammar,
the fail-loud eval, the locked regression cases, the scaffolding lint, and every scenario golden
re-verified against a fresh live recording. Those cover the deterministic layers. **None of them can
tell you whether a generic example makes the model reason worse than a tuned one.** That limit is
stated here so it does not have to be discovered, and is carried in
[LIMITATIONS.md](LIMITATIONS.md#what-the-test-suite-covers) alongside every other thing this repo
cannot measure.

**Re-recording found something no test could have.** One scenario's expectation turned out to rest on
a coin toss: Pass 2b's blind read of a marginal item landed on NEW_TASK twice and UPDATE once across
three identical runs, and only one of those produced the hold the golden asserted. A cassette freezes
whichever reply was recorded, so the fixture had looked stable — and would have failed for whoever
re-recorded next, at the exact moment a failure is hardest to distinguish from a real regression. The
source line was rewritten until the outcome no longer depended on which way the model leaned. **A
fixture should be over-determined by its input**; if the intended behaviour needs the model to make a
close call, the fixture is testing the weather.

**The same thing happened again, and the second time it generalized.** A later prompt change moved the
one remaining category-dispute hold, and three consecutive re-recordings of the identical fixture gave
three different answers. The conclusion is not that those fixtures were badly written — it is that
**no cassette can pin a model judgement.** Whether two independent reads disagree about one genuinely
ambiguous item is exactly the kind of thing that varies run to run, which is *why* the disagreement is
worth surfacing to a human in the first place. So no scenario asserts a hold any more. Scenarios pin
what deterministic code does with a given reply — parsers, gates, plan, writes, audit, idempotency —
and every gate, including the ones that produce holds, is proven separately with scripted replies in
`contractGates.test.ts` and `run.test.ts`. The alternative was re-recording until a hold appeared,
which is not evidence of anything except patience.

**Two prompt bugs surfaced the same way, both the same shape:** the prompt under-specified something a
deterministic gate strictly required, so a reworded-but-correct reply was held.

- An unstated due date was flagged as an *uncertain field*, holding the card to ask a human a question
  nobody could answer. `ASSIGNEE` already said "if nobody is named, leave it out"; `DUE_DATE` did not.
- The evidence-citation gate matches the literal string `task-comments`, but the prompt only ever
  showed that inside an "e.g." — so a rationale that genuinely cited the evidence in different words
  was held for not citing it.

Both are now stated as requirements rather than examples, and both are pinned by
`scaffolding.test.ts`. Worth looking for a third: any field where deterministic code greps for a
literal that the prompt merely illustrates is the same bug waiting.

## Carried forward deliberately

Findings from the review that immediately preceded this extraction, each of which cost real debugging
time to discover and would be easy to drop during a port:

- **Truncated output is a failure, not a short success.** `finish_reason=length` was log-only in
  production, and a long *partial* shipped as a valid result. `CompletionResult.truncated` exists so
  callers must decide.
- **Retry budgets are wall-clock, not per-attempt.** Three attempts each granted the full timeout,
  plus backoffs, turned a "600s" call into a potential 30-minute hang.
- **Corrupt state fails loud.** Silently starting from `{}` loses the state *and* the signal, then
  persists the emptiness as the new truth on the next write.
- **Atomic writes everywhere.** A kill mid-write once corrupted a registry into `{}` and triggered a
  full re-push.
- **Test behaviour, not configuration.** Four separate controls in that review looked correctly
  configured while doing nothing at all. Configuration is a claim; only an observed effect is
  evidence. This is why CI runs the demo rather than asserting the demo exists.
- **Status vocabulary is per list, and casing is load-bearing.** ClickUp rejects a status whose
  spelling does not match that list's own vocabulary, so the adapter reads the vocabulary and sends
  back the tracker's exact casing. A status that does not exist fails loudly rather than leaving the
  card where it was and reporting success.
- **`setAssignees` replaces.** The ClickUp wire format only speaks `add`/`rem`, so an adapter that
  sends the desired set as `add` appends — and quietly leaves the previous owner on every card the
  pipeline touches, with no error anywhere.

## Both providers have now run live

The Anthropic provider was written in the first phase and did not execute once until the key existed.
It now has: auth, model id, `output_config.effort` on the beta namespace, text extraction, truncation
mapping and usage all confirmed against the real API, plus a full parallel recording of every
scenario. `PROVIDERS.md` has the measured comparison.

The finding worth carrying: **the pipeline is portable, extraction is not.** Given each provider's
own replies, every deterministic layer behaved identically — same parsers, gates, plan, writes and
audit. What the two models disagree about is what counts as an action item in the first place, on two
of five scenarios. Neither is wrong, and this repo has no ground truth to say otherwise, so the
recordings ship side by side and the portability test asserts the layers match while explicitly
tolerating the extraction difference.

One thing that comparison exposed: the Anthropic adapter sets a prompt-cache breakpoint on the last
system block, and the pipeline sends no system block at all — so it never fires, and every call
re-sends the whole board snapshot at full price. Cache-hit rate across 46 calls was zero. The caching
code is decorative until the stable prefix moves into `system`.

## What the adapters have NOT been proven against

The ClickUp and Linear adapters pass the shared contract suite against hand-written fakes that speak
each vendor's documented wire format. **That is not recorded live traffic, and the distinction is
real.** The fakes prove the adapter's own logic — replace-versus-append, the protected-status refusal,
vocabulary resolution, pagination, capability mapping, error handling. They cannot prove an endpoint
path, a field name or an auth header, because the fake was written from the same reading of the docs
as the adapter it tests. Only a live call settles those, and no account exists for either tracker yet.
