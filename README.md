# ops-agent-reference

A production ops-agent pipeline: meeting transcripts and channel logs in, governed tracker writes
out, with human-in-the-loop gates on everything it is not sure about.

From real trace data across 40 meeting runs: **14.2 items per meeting, 68% auto-created clean, 29%
held for a human, 3% confidently skipped.** Company context: 14 people, 13 client workstreams,
founder coordination time down to roughly 4 hours a day.

**That 29% is the number to look at.** A pipeline that writes to a real board is only useful if it
knows what it does not know, and nearly a third of everything it sees goes to a human instead of to
the board. The gates that decide which third are the substance of this repo.

**No precision or recall is claimed, here or anywhere.** That needs a hand-labelled ground truth that
does not exist, and the only alternative — a model grading a model — is a system agreeing with
itself. Volume and hold rate are honest; accuracy is not reported. See
[LIMITATIONS.md](LIMITATIONS.md).

It is extracted from a system that has been running in production. **The architecture is identical to
what we run; the tuned few-shot examples are replaced with generic ones.**
[EXTRACTION.md](EXTRACTION.md) records exactly what changed on the way out and why.

## The shape

```
source (transcript | channel log)
  └─ Pass 0    cleanup
     Pass 1    inventory        ─ what was actually asked for
     Pass 1.5  critic           ─ what the inventory got wrong
     Pass 1.7  consolidator     ─ merge, dedupe, anchor
     Pass 2a   categorization   ─ NEW_TASK | DUPLICATE | SUBTASK | UPDATE, against the live board
     Pass 2b   contract check   ─ a BLIND re-derivation; disagreement becomes a human hold
     Pass 2c   execute          ─ the only writer. Deterministic. No model in the write path.
     Pass 2d   audit            ─ did the board end up how 2c said it would?
```

**Pass 2b never sees Pass 2a's answer.** That is the headline claim, and it has a test that fails
loudly if someone "helpfully" passes the manifest item in. Two independent reads that agree are
evidence; a second read shown the first answer is a rubber stamp.

## Running it

Nothing here needs an API key. The demo replays recorded model responses through the real prompts,
the real parsers and the real gates:

```bash
npm ci
npm run demo                           # all five scenarios, offline, ~30ms
npm run demo -- --twice                # proves a redelivery costs zero tokens
npm run demo -- --provider anthropic   # the same scenarios, replayed from a Claude recording
npm run demo -- --agents               # with the agent layer on (PRD §5), also offline
```

```
▶ 01-meeting-mixed — A normal standup: four categories exercised, four cards created, one duplicate
  skipped, and a post-write audit that confirms the board matches the plan.
  ✓ 0-cleanup            1ms
  ✓ 1-inventory          1ms
  ✓ 1.5-critic           0ms
  ✓ 1.7-consolidator     1ms
  ✓ evidence             2ms
  ✓ 2a-categorization    10ms
[pass2b] item 5: existing-card dispute (2a=SUBTASK vs blind=UPDATE) — trusting 2a, not holding
  ✓ 2b-contract-check    8ms
  ✓ 2c-execute           1ms
  → 4 created · 1 commented · 1 skipped · 0 failed
  ✓ 2d-audit             1ms
  ✓ audit: 6 passed, 0 mismatched
  ✓ 6 items · 4 created · 0 held · 0 skipped — matches expected.json
```

The replayed replies are real: recorded from `deepseek-v4-pro` against these exact prompts. A missing
cassette is a loud error, never an empty reply — an empty reply is indistinguishable from a pass that
legitimately found nothing, which would make the demo go green having done nothing at all.

Both providers have been run live against the same fixtures and both recordings ship — see
[PROVIDERS.md](PROVIDERS.md) for the measured cost and where the two models disagree.

## The five scenarios

| | What it demonstrates |
|---|---|
| `01-meeting-mixed` | A normal standup. Four categories exercised, four cards created, one duplicate skipped. |
| `02-meeting-duplicates` | Both deliverables already on the board under different wording. **The run writes nothing at all.** |
| `03-meeting-noise` | Pure discussion. Nothing is extracted — the pipeline does not invent work to look useful. |
| `04-channel-messages` | A channel log through the identical 1 → 2d chain. The pipeline is source-agnostic. |
| `05-corrections` | A recorded human correction changes a later run — no duplicate hold on work a human already said is separate. |

**What they do and do not pin.** They pin what deterministic code does with a given set of replies:
the parsers, the gates, the plan, the writes, the audit, the idempotency layers. They cannot pin
*which* reply a model returns. Held items are the clearest case — whether two independent reads
disagree about one ambiguous item varies between recordings of the identical fixture, so no scenario
asserts a hold. The gates that produce holds are proven separately and deterministically, with
scripted replies, in `contractGates.test.ts` and `run.test.ts`.

## The four seams

Everything is injected. Each seam exists because there was a real second implementation to write.

| Seam | Ships | |
|---|---|---|
| `ModelClient` | `deepseek` · `anthropic` · `cassette` | [PROVIDERS.md](PROVIDERS.md) |
| `TrackerAdapter` | `memory` · `clickup` · `linear` | [ADAPTERS.md](ADAPTERS.md) |
| `IdempotencyStore` | `memory` · `jsonFile` | three layers: event, source, content |
| `IngestedSource` | `transcript` · `channel` | ingestion itself is out of scope |

**An optional agent layer** (PRD §5) sits between the gates and the writer: a board agent that
delegates to eight role agents with **read-only** tools. It is off by default, it cannot write, and
it cannot change what an item is — only how it reads. See [AGENTS.md](AGENTS.md).

**The rule that makes the tracker seam real:** the pipeline speaks canonical member names and list
keys; only an adapter ever sees a tracker id. Every gate, prompt, parser and the whole categorization
taxonomy is tracker-blind because of it.

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The passes, the seams, idempotency, fail-open vs fail-closed |
| [LIMITATIONS.md](LIMITATIONS.md) | **What this cannot tell you.** Read before trusting a green run |
| [EXTRACTION.md](EXTRACTION.md) | What differs from production, what was de-tuned, and how it was checked |
| [ADAPTERS.md](ADAPTERS.md) | The tracker contract, the capability matrix, writing a fourth |
| [PROVIDERS.md](PROVIDERS.md) | Measured cost, and where DeepSeek and Claude disagree |
| [ROLES.md](ROLES.md) | The eight role archetypes and how they reach the prompt |
| [AGENTS.md](AGENTS.md) | The optional agent layer — what it may touch, and the two structural guarantees |
| [EVAL.md](EVAL.md) | Six dimensions, and why no accuracy figures are published |

## Development

```bash
npm test              # 651 tests
npx tsc --noEmit      # tests included in typecheck
npm run lint
npm run eval          # score the shipped runs on six dimensions, offline
```

Configuration is [`.env.example`](.env.example); every value in it is a placeholder and none is
required to run the demo.

## License

Apache-2.0. See [LICENSE](LICENSE).
