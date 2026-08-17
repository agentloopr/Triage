# Providers

The pipeline reaches a model through one interface, `ModelClient`. Three implementations ship:
**deepseek**, **anthropic**, and **cassette** (recorded replies, which is what makes the demo run
offline). Selection is `MODEL_PROVIDER`; the model itself is `DEEPSEEK_MODEL` / `ANTHROPIC_MODEL`.

Both live providers have been run against the same eight scenarios, and both recordings ship:

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
| `06-github-activity` | 4 items · 0 created · 2 held | 4 items · **1 created · 1 held** | differs |
| `07-email-thread` | 2 items · 1 created | **1 item** · 1 created | differs |
| `08-drive-activity` | 4 items · 2 created | **1 item · 0 created** | differs |

**All eight scenarios, both providers.** The three source scenarios diverge more sharply than the
five meeting ones, and in a consistent direction: **Claude extracts fewer items from a non-conversational
feed.** Four events of GitHub activity and seven of document activity became one item each under
Claude where DeepSeek found four.

That is worth reading as a finding rather than a defect. A transcript states commitments out loud
("I'll ship it Friday"); a commit log and an edit history state that *something happened* and leave
the deliverable implicit. Deciding whether a merged PR implies remaining work is a judgement call,
and the two models make it differently — Claude conservatively, DeepSeek expansively. Neither is
wrong, and this repo has no ground truth to say otherwise, which is the whole reason both recordings
ship side by side and the portability test asserts only that the *layers* agree.

The practical consequence for anyone porting this: **a source that does not speak in commitments will
amplify whatever extraction bias your model has.** The gates cannot correct for an item that was never
extracted — that is the `miss_rate` blind spot [EVAL.md](EVAL.md) declines to score.

**Every divergence is at Pass 1 — the extraction — and nowhere else.** Given each provider's own
replies, every downstream layer behaved identically: same parsers, same gates, same plan, same
writes, same audit result. That is the portability claim, and it has a test
(`providerPortability.test.ts`) that asserts it directly while deliberately *not* asserting the two
providers agree.

**Five of eight scenarios now differ, where two of five did before.** That is not a regression — the
three new ones are all non-conversational sources, which is precisely where the two models disagree
most. Reading it the other way round is the useful version: on meeting transcripts and chat, the two
providers agreed on three of five; on activity feeds, on none of three.

The disagreement is not a bug in either model. On `01` the two extract the *same* six items and
categorize one differently — Claude reads it as an UPDATE where DeepSeek reads a SUBTASK, which is
one fewer card created. On `04` Claude reads a channel log more conservatively (3 where DeepSeek
found 4). Which scenarios differ moves whenever anything is re-recorded; that instability is the
finding, not a footnote to it. Scenario 03 is the useful control:
on pure discussion with no commitments, **both extract nothing** — neither invents work to look busy.

Which is better is exactly the question this repo declines to answer, because answering it needs
hand-labelled ground truth that does not exist here. See `EVAL.md`.

## Cost

### DeepSeek — measured, 2026-08-17

`scripts/measureDeepSeekCost.ts` runs a live pass over all eight current scenarios and tallies real
API usage. It never touches `fixtures/cassettes` — the metered client wraps the live provider purely
to sum tokens, so this carries none of the cassette-drift risk a re-record would. Re-run it yourself
with `DEEPSEEK_API_KEY=... npm run cost:deepseek`.

80 calls, current post-split prompts:

| | Tokens | Rate (peak / off-peak, per 1M) | Cost (peak) | Cost (off-peak) |
|---|---|---|---|---|
| Input, cache miss | 133,065 | $1.32 / $0.66 | $0.176 | $0.088 |
| Input, cache hit | 86,528 | $0.44 / $0.22 | $0.038 | $0.019 |
| Output | 187,678 | $3.96 / $1.98 | $0.743 | $0.372 |
| **Total** | | | **$0.96** | **$0.48** |

Rates from api-docs.deepseek.com, effective 2026-08-16; peak hours are 01:00–04:00 and 06:00–10:00 UTC.
This run landed entirely inside a peak window. Output token count is larger than input — deepseek-v4-pro
is a reasoning model and `completion_tokens` includes reasoning tokens, not just visible text, the same
caveat the Claude figure below already carries.

### Claude — measured, stale baseline

| | Claude Sonnet 5 |
|---|---|
| Input tokens | **190,200** |
| Output tokens | **9,986** (includes thinking) |
| Cost | **$0.48** |
| Cached input | **0** |
| Scope | 5 scenarios, 42 calls, pre-split prompt |

This predates the system/user split described below and is kept as the *before* those numbers are
compared against — a baseline, not current cost. **It is not directly comparable to the DeepSeek
table above**: different scenario count (5 vs. 8) and a prompt shape from before caching existed. A
fresh 8-scenario Claude measurement, taken the same way as the DeepSeek one, would make the two
comparable; it has not been taken.

**The apparent agreement between DeepSeek's off-peak total ($0.48) and this Claude figure ($0.48) is
coincidence** — different token counts, different rates, different scenario sets producing the same
rounded number. Do not read it as the two providers costing the same; re-measure both on equal
footing before drawing that conclusion.

**Token counts are still not comparable across providers**, so any per-token price comparison that
skips the tokenizer ratio is wrong by whatever that ratio happens to be — regardless of which dollar
figures are current.

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

Turning agents on adds calls; it does not change what the gates decide. Measured over all eight
scenarios:

| | calls, agents off | calls, agents on |
|---|---|---|
| DeepSeek | 76 | **93** (+22%) |
| Claude | 66 | **78** (+18%) |

*Measured across all eight scenarios. An earlier version of this table read 44 → 65 and 42 → 53, from
five scenarios and — more importantly — from a counter that **did not count the agent layer at all**.
Role agents hold the model client directly and call it themselves, so their turns bypassed the
wrapper doing the counting: scenario 01 reported 16 calls with agents on and 16 with them off, while
its agent recording held 21 replies. Five paid calls were invisible to the number this page publishes
as cost. The counter now sits on the seam rather than at one call site, so anything wired in later is
counted too.*

**The two models delegate differently**, and that gap is the interesting number. Both were
offered the same items and the same read-only tools; DeepSeek went and looked more often. Neither
is wrong — a model that reads more card history is buying recall with tokens — but it means an agent
budget is not portable between providers even when the prompts are byte-identical.

Agent cost is bounded by two caps rather than by hope: `AGENT_MAX_DELEGATIONS` (default 8) and
`TOOL_LOOP_MAX_ITERATIONS` (default 6).

**The agent layer changed no category on any recording.** DeepSeek with agents matches five of eight
goldens and diverges on `04`, `06` and `08`; Claude with agents diverges on `01`, `04`, `06`, `07`
and `08`.

Those divergences are **inventory counts**, and the agent layer runs after every gate, so it cannot
change one — they trace to Pass 1 and Pass 1.5 in a separately recorded set, exactly the re-record
variance `EXTRACTION.md` documents.

What agents *can* do, since Part B, is propose a category, list, assignee or description. Every
proposal is re-run through `applyGates`, so a refused one becomes a human hold rather than a write —
and measured across both recordings and all eight scenarios, **no proposal has changed a final
category**. `agentReplay.test.ts` compares each item's final category against Pass 2a's and fails if
one does.

*An earlier version of this paragraph said agents "provably do not move category, list, assignee".
That was true before the re-gate shipped and stopped being true then; it cited `agents.test.ts`,
whose containment test had by then been replaced. An outside audit found it still here.*

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
