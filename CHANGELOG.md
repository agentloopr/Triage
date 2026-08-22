# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). This repo does not promise
semantic-versioning stability — see the README — but tags mark points the demo, the tests and the
docs were all verified together.

## Unreleased

- Renamed the repository from `ops-agent-reference` to `Triage`. GitHub redirects the old URL.
- Widened Pass 2b's category-dispute gate from a new-vs-existing-boundary check to a write-equivalence
  check: `writeDispute()` (renamed from `categoryDisputeHolds`, `src/pipeline/gates/contractGates.ts`)
  now compares what each read would actually WRITE — create / comment / create-child / nothing / link,
  and the target card where both reads name one — instead of which side of the new-versus-existing
  boundary the category label falls on. A `DUPLICATE` read the old rule trusted outright whenever the
  blind read also stayed on the "existing card" side is now correctly caught when the blind read would
  have written something. Two scenario fixtures moved as a result: `01-meeting-mixed` now holds on
  item 5 (SUBTASK vs UPDATE) instead of trusting Pass 2a silently, and `08-drive-activity` now holds
  on item 4 — previously a silent duplicate-skip the old rule never surfaced, now correctly caught as
  a dispute. Added `disputeArbiter.ts`, an optional resolver that checks a dispute against live
  tracker state (a cited card that's gone settles it for free) and, failing that, asks a model to
  resolve only at high confidence with a cited live-board fact — off by default
  (`DISPUTE_ARBITER_ENABLED=false`), so out of the box every detected dispute still holds for a human,
  just more of them are detected than before.
- `over_subtask` and `near_dup_pair` promoted from flag-only to hold, the same fix `missed_dup`
  already had — a signal that reaches only a log is a signal a human never sees, and the item got
  created anyway either way.
- Added a Slack read client (`makeSlackClient`, `src/sources/slack.ts`) — fetches `conversations.history`
  and `users.list`, normalizes through the existing `channelSource`. No sixth `IngestSource` kind: a
  Slack channel log still *is* the `channel` source. Fake-tested only; not live-verified.
- Added `localRetriever` (`src/pipeline/retrieval/local.ts`), opt-in via `RETRIEVAL_DIR`: ranks a flat
  directory of `.md`/`.txt` files by the same Jaccard title-overlap the cross-item gates use.
  `nullRetriever` stays the default; the seam is omitted entirely when unset, so the default prompt
  stays byte-identical and every cassette keeps replaying.
- Role profile filenames are no longer locked to `ROLE_ARCHETYPES`: `loadRoleProfiles()` now scans
  every `*.md` in the roles directory and reads an optional `## Archetype` section (defaulting to the
  filename stem) to learn which of the eight typed slots a file fills. Two files claiming the same
  slot warn and the second is dropped, not silently overwritten.
- Added a cron-able poller (`npm run poll`, `src/cli/poll.ts`) and a signature-verified webhook
  receiver (`npm run serve`, `src/cli/serve.ts` over `src/transport/webhook.ts`) for GitHub and Slack —
  HMAC over the raw body, a ±5-minute replay window on Slack's. A verified delivery is a trigger, not a
  payload to parse: it re-pulls the named repo/channel through the same tested `SourceClient`s rather
  than parsing a webhook shape this repo has never made a live call against. Reference wiring, not a
  production ingress — no TLS termination, process supervision, queue durability or OAuth refresh.
- `scripts/measureDeepSeekCost.ts` generalized into `scripts/measureCost.ts --provider <deepseek|anthropic>`
  (`npm run cost:claude` alongside `cost:deepseek`), so both providers' cost tables in PROVIDERS.md are
  taken the same way. Doing so surfaced a real bug: the shared cache-miss formula was correct for
  DeepSeek's total-basis `prompt_tokens` and silently produced a negative token count against
  Anthropic's already-miss-only `input_tokens`; separately, `cache_creation_input_tokens` (cache
  writes, billed at a 1.25× premium) was never tracked anywhere in this codebase's usage type. Both
  fixed — `measureCost.ts` computes cache-miss tokens per provider, and `cacheCreationInputTokens` is
  now a real field on `CompletionUsage`, mapped in both of `anthropic.ts`'s streaming and
  non-streaming paths.
- CodeQL now pins action SHAs (`.github/workflows/codeql.yml`), matching `ci.yml`'s existing convention.

## [0.1.0] — 2026-08-14

First public release. Extracted from a production ops-agent pipeline; the architecture is identical
to what runs internally, the tuned few-shot examples are replaced with generic ones (see
[EXTRACTION.md](EXTRACTION.md)).

**Pipeline.** Eight passes, 0 through 2d: cleanup, inventory, critic, consolidator, categorization,
a **blind** contract check that never sees the categorization answer, the only writer, and a
post-write audit. Eight offline scenarios replay real recorded model responses through the real
prompts, parsers and gates — `npm run demo`.

**Human-in-the-loop.** Holds persist across a restart, claimed and finalized under a cross-process
file lock so two operators answering the same queue can't both write. `npm run answer` lists and
resolves them. Pass 2b fails **closed**: a provider outage that breaks the blind read produces a
hold, not a silent pass-through — closing a gap where an unusable verdict used to read as agreement
with nothing.

**The critical-write gate.** A hold that fires because a write is high-stakes, independent of whether
the pipeline is otherwise certain — credentials, client PII, a production deploy, a client-facing
send. Patterns are compiled constants reachable by no env var, correction, prompt or model output.

**Cross-process locking.** Every file this repo writes — holds, idempotency, corrections, role
memory, the roster — shares one lock (`withExclusiveFileLock`), replacing an in-process lock that
hundreds of single-process tests could not tell apart from the real thing. Found by starting real processes:
20 workers racing one delivery key against a grown state file all 20 accepted it as new. Five defects
in the lock itself, each an interaction between two individually correct rules, are recorded in
`ARCHITECTURE.md`.

**Two providers, two adapters.** `deepseek` and `anthropic` model clients, `clickup` and `linear`
tracker adapters, all live-verified — not mocked-and-assumed. Five source clients (`transcript`,
`channel`, `github`, `gmail`, `drive`) feed the identical pass chain; `npm run pull` joins reading a
live source to running the pipeline over it, planning by default, writing only with `--write`.

**An optional agent layer**, off by default: a board agent delegating to eight read-only role agents.
It may propose a different category, list, assignee or description; every proposal is re-run through
the same gates, so a proposal the gates refuse becomes a hold, never a write.

**No accuracy claimed.** Volume and hold rate are reported from 711 real items across 49 production
runs; precision and recall are not, because the only alternative to a hand-labelled ground truth that
doesn't exist is a model grading a model. See [LIMITATIONS.md](LIMITATIONS.md).
