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
