# Providers

The pipeline reaches a model through one interface, `ModelClient`. Three implementations ship:
**deepseek**, **anthropic**, and **cassette** (recorded replies, which is what makes the demo run
offline). Selection is `MODEL_PROVIDER`; the model itself is `DEEPSEEK_MODEL` / `ANTHROPIC_MODEL`.

Both live providers have been run against the same five scenarios, and both recordings ship:

```bash
npm run demo                        # replays the DeepSeek recording — this one gates CI
npm run demo -- --provider anthropic  # replays the Claude recording — informational
```

## What the two providers actually did

Same fixtures, same prompts, same gates. Recorded 2026-08-12 against `deepseek-v4-pro` and
`claude-sonnet-5`.

Every row below is what `npm run demo` prints today, not what it printed when the paragraph was
written. Re-derive it with `npm run demo` and `npm run demo -- --provider anthropic`.

| Scenario | DeepSeek | Claude | |
|---|---|---|---|
| `01-meeting-mixed` | 6 items · 4 created | 6 items · **3 created** (UPDATE 2 / SUBTASK 1 vs 1 / 2) | differs |
| `02-meeting-duplicates` | 2 items · 0 created | 2 items · 0 created | identical |
| `03-meeting-noise` | 0 items | 0 items | identical |
| `04-channel-messages` | 4 items · 3 created | **3 items · 2 created** | differs |
| `05-corrections` | 1 item · 1 created | 1 item · 1 created | identical |
| `06-github-activity` | 4 items · 0 created · 2 held | **not recorded** | — |
| `07-email-thread` | 2 items · 1 created | **not recorded** | — |
| `08-drive-activity` | 4 items · 2 created | **not recorded** | — |

**The comparison covers five of the eight scenarios.** The three source scenarios were added after
the Claude credential for this project stopped working. Listing them as zeros would report an
*absence* as a divergence — the one thing this table exists to measure — so they are marked instead,
and `npm run demo -- --provider anthropic` skips them by name rather than replaying them empty.
Recording each is one command once a key is available:
`npm run record -- --scenario <name> --provider anthropic`.

**Both divergences are at Pass 1 — the extraction — and nowhere else.** Given each provider's own
replies, every downstream layer behaved identically: same parsers, same gates, same plan, same
writes, same audit result. That is the portability claim, and it has a test
(`providerPortability.test.ts`) that asserts it directly while deliberately *not* asserting the two
providers agree.

The disagreement is not a bug in either model. On `01` the two extract the *same* six items and
categorize one differently — Claude reads it as an UPDATE where DeepSeek reads a SUBTASK, which is
one fewer card created. On `04` Claude reads a channel log more conservatively (3 where DeepSeek
found 4). Which scenarios differ moves whenever anything is re-recorded; that instability is the
finding, not a footnote to it. Scenario 03 is the useful control:
on pure discussion with no commitments, **both extract nothing** — neither invents work to look busy.

Which is better is exactly the question this repo declines to answer, because answering it needs
hand-labelled ground truth that does not exist here. See `EVAL.md`.

## Cost

Measured over one full pass — all five scenarios, 44 DeepSeek / 42 Claude model calls:

| | Claude Sonnet 5 | DeepSeek v4-pro |
|---|---|---|
| Input tokens | **190,200** (measured) | ~109,000 (*estimated*) |
| Output tokens | **9,986** (measured, includes thinking) | ~5,400 (*estimated, visible text only*) |
| Cost | **$0.48** | not computed |
| Cached input | **0** | n/a |

Those figures predate the system/user split described below, and are kept as the *before* they are
compared against. They were taken on the pre-split prompt, so they are a baseline, not current cost.

**The DeepSeek column is an estimate and is marked as one.** Its recordings were made before usage
capture was wired in, so those figures are derived from character counts at ~4 chars/token rather
than read from the API. They are here for rough scale, not for a cost ratio.

Two things in that table matter more than the totals:

**Token counts are not comparable across providers.** Claude reports 1.7× the input tokens for
byte-identical prompts — different tokenizer, not a bigger prompt. Any per-token price comparison
between vendors that skips this step is wrong by whatever the tokenizer ratio happens to be.

**Prompt caching now fires, and that took a prompt change rather than new caching code.** The
Anthropic adapter always set a cache breakpoint on the last system block; the pipeline always sent
everything as a single user message and no system prompt, so the breakpoint had nothing to sit on.
Measured cache-hit rate across a full run: **zero**. The caching code was decorative.

Passes 2a and 2b now split their prompt at the line where it stops being the same for every item —
the taxonomy, the rules, the roster, the board snapshot and the source text go in `system`; the item
and its evidence stay in `user`. That is **97.9%** of the 2a prompt in the cacheable half.

Measured on `01-meeting-mixed`, 18 calls:

| | before | after |
|---|---|---|
| Prompt tokens served from cache | **0** | **73,290 of 83,710 — 87.6%** |
| Calls with a cache hit | 0 of 18 | **12 of 18** |

The six misses are correct rather than missed opportunities: passes 0–1.7 are one call each, so
there is no prefix to share, and the first 2a and first 2b call each *write* the cache the rest read.

```
2a/item-01   in 420  cached     0     ← writes the prefix
2a/item-02   in 193  cached 6,339     ← reads it
2b/item-01   in 416  cached     0     ← a different prefix, writes
2b/item-02   in 189  cached 5,873     ← reads it
```

**The split is behaviourally neutral, and that was checked rather than assumed.** The same 2a prompt
sent split versus joined returned the same verdict on three consecutive paired runs. Where a fixture
did move, the cause was located instead of accepted: Pass 1's prompt fingerprint is byte-identical
across the change (`ced7582a8aee` on both sides) while its reply differed, which is the model, not
the edit.

Two things the split does not fix. Cache entries are ephemeral, so a cold run still pays full price
for the first call of each pass. And **DeepSeek is unaffected** — it takes the system block happily,
but its caching is server-side and automatic, so there is no breakpoint to place and no hit rate to
report here.

## What the agent layer costs

Turning agents on adds calls; it does not change what the gates decide. Measured over the same five
scenarios:

| | calls, agents off | calls, agents on |
|---|---|---|
| DeepSeek | 44 | **65** (+48%) |
| Claude | 42 | **53** (+26%) |

**The two models delegate very differently**, and that gap is the interesting number. Both were
offered the same items and the same read-only tools; DeepSeek went and looked far more often. Neither
is wrong — a model that reads more card history is buying recall with tokens — but it means an agent
budget is not portable between providers even when the prompts are byte-identical.

Agent cost is bounded by two caps rather than by hope: `AGENT_MAX_DELEGATIONS` (default 8) and
`TOOL_LOOP_MAX_ITERATIONS` (default 6).

**The agent layer changed no disposition it is capable of changing.** Observed today: DeepSeek with
agents matches four of five goldens and diverges on `04-channel-messages` (5 items · 4 created vs the
golden's 4 · 3). Claude with agents diverges on `01` (7 items) and `04` (3 items · 2 created).

Every one of those is an **inventory count**, and **the agent layer runs after every gate, so it
cannot change an inventory count** — the divergences trace to Pass 1 and Pass 1.5 in a separately
recorded set, exactly the re-record variance `EXTRACTION.md` documents. What agents provably do not
move is category, list, assignee, or the decision to write, and that has a test
(`agents.test.ts`) rather than a sentence.

## Provider differences worth knowing

| | DeepSeek | Anthropic |
|---|---|---|
| Determinism | `temperature` (0 for `strict`) | `output_config.effort` — the SDK rejects `temperature` outright |
| Thinking | none | adaptive by default; thinking tokens bill as output |
| Tool use | OpenAI-shaped `tools` / `tool_calls` | `tool_use` content blocks, no `tool` role — results go in a user turn |
| Truncation | `finish_reason: "length"` | `stop_reason: "max_tokens"` (streaming and non-streaming) |
| Streaming | not used | automatic above 16K max output tokens |

`determinism` is a portable enum rather than a number for exactly this reason: a shared
`temperature: 0` field would be unimplementable by one of the two providers.

## Reproducing this

```bash
ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-5 npm run record -- --all --provider anthropic
```

Recording is the only step that needs a key. Everything published here — the dispositions, the
divergences, the portability tests — replays from the committed cassettes with no network access.
