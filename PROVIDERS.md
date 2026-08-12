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

| Scenario | DeepSeek | Claude | |
|---|---|---|---|
| `01-meeting-mixed` | 6 items · 3 created | **8 items · 3 created**, 1 auto-skipped as not-a-task | differs |
| `02-meeting-duplicates` | 2 items · 0 created | 2 items · 0 created | identical |
| `03-meeting-noise` | 0 items | 0 items | identical |
| `04-channel-messages` | 4 items · 3 created | **3 items · 2 created** | differs |
| `05-corrections` | 1 item · 1 created | 1 item · 1 created | identical |

**Both divergences are at Pass 1 — the extraction — and nowhere else.** Given each provider's own
replies, every downstream layer behaved identically: same parsers, same gates, same plan, same
writes, same audit result. That is the portability claim, and it has a test
(`providerPortability.test.ts`) that asserts it directly while deliberately *not* asserting the two
providers agree.

The disagreement is not a bug in either model. Claude reads a meeting transcript more liberally
(8 items where DeepSeek found 6, one of which the gates then correctly auto-skipped as not a task)
and a channel log more conservatively (3 where DeepSeek found 4). Scenario 03 is the useful control:
on pure discussion with no commitments, **both extract nothing** — neither invents work to look busy.

Which is better is exactly the question this repo declines to answer, because answering it needs
hand-labelled ground truth that does not exist here. See `EVAL.md`.

## Cost

Measured over one full pass — all five scenarios, 46 model calls:

| | Claude Sonnet 5 | DeepSeek v4-pro |
|---|---|---|
| Input tokens | **190,200** (measured) | ~109,000 (*estimated*) |
| Output tokens | **9,986** (measured, includes thinking) | ~5,400 (*estimated, visible text only*) |
| Cost | **$0.48** | not computed |
| Cached input | **0** | n/a |

**The DeepSeek column is an estimate and is marked as one.** Its recordings were made before usage
capture was wired in, so those figures are derived from character counts at ~4 chars/token rather
than read from the API. They are here for rough scale, not for a cost ratio.

Two things in that table matter more than the totals:

**Token counts are not comparable across providers.** Claude reports 1.7× the input tokens for
byte-identical prompts — different tokenizer, not a bigger prompt. Any per-token price comparison
between vendors that skips this step is wrong by whatever the tokenizer ratio happens to be.

**`cached: 0` is a finding, not a footnote.** The Anthropic adapter sets a cache breakpoint on the
last system block, but the pipeline sends everything as a single user message and no system prompt —
so the breakpoint never fires and the board snapshot, taxonomy and worked examples are re-sent at
full price on all 46 calls. The caching code is currently decorative. Moving the stable prefix into
`system` is the single largest cost lever available here and has not been done, because it changes
the prompt and therefore needs a re-record.

## Provider differences worth knowing

| | DeepSeek | Anthropic |
|---|---|---|
| Determinism | `temperature` (0 for `strict`) | `output_config.effort` — the SDK rejects `temperature` outright |
| Thinking | none | adaptive by default; thinking tokens bill as output |
| Tool use | OpenAI-shaped `tools` / `tool_calls` | not implemented — the tool loop runs on DeepSeek |
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
