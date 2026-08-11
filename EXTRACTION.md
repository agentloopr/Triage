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
stated here so it does not have to be discovered, and it belongs in LIMITATIONS.md when it is written.

**Re-recording found something no test could have.** One scenario's expectation turned out to rest on
a coin toss: Pass 2b's blind read of a marginal item landed on NEW_TASK twice and UPDATE once across
three identical runs, and only one of those produced the hold the golden asserted. A cassette freezes
whichever reply was recorded, so the fixture had looked stable — and would have failed for whoever
re-recorded next, at the exact moment a failure is hardest to distinguish from a real regression. The
source line was rewritten until the outcome no longer depended on which way the model leaned. **A
fixture should be over-determined by its input**; if the intended behaviour needs the model to make a
close call, the fixture is testing the weather.

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
