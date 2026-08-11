# ops-agent-reference

> **Status: in construction (Phases 1–3 of 5 complete).** The full pipeline runs end to end offline,
> the test wall is up, and the prompts carry no internal content — [EXTRACTION.md](EXTRACTION.md)
> records what was checked and what could not be. Still to come: roles, tracker adapters and the
> second provider (4), then docs and publish (5). This README is a placeholder; the real one is
> written in Phase 5.

A production ops-agent pipeline: meeting transcripts and channel logs in, governed tracker writes
out, with human-in-the-loop gates on everything it is not sure about.

It is extracted from a system that has been running in production — see [EXTRACTION.md](EXTRACTION.md)
for exactly what was changed on the way out and why.

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

Pass 2b never sees Pass 2a's answer. That is the headline claim, and it has a test that fails loudly
if someone "helpfully" passes the manifest item in.

## Running it

Nothing here needs an API key. The demo replays recorded model responses through the real prompts,
the real parsers and the real gates:

```bash
npm ci
npm run demo              # all five scenarios, offline, ~20ms
npm run demo -- --twice   # proves a redelivery costs zero tokens
```

```
▶ 01-meeting-mixed — A normal standup exercising all five categories, plus a held disagreement between the two reads.
  ✓ 0-cleanup  ✓ 1-inventory  ✓ 1.5-critic  ✓ 1.7-consolidator  ✓ evidence
  ✓ 2a-categorization  ✓ 2b-contract-check
  ⏸ 1 held for a human:
      #5 [category dispute] Investigate noisy nightly build alerts and report back Wednesday
  → 3 created · 1 commented · 1 skipped · 0 failed
  ✓ audit: 5 passed, 0 mismatched
  ✓ 6 items · 3 created · 1 held · 0 skipped — matches expected.json
  ✓ re-run: skipped at layer 'source' — 0 model calls, $0.00
```

The replayed replies are real: recorded from `deepseek-v4-pro` against these exact prompts. A missing
cassette is a loud error, never an empty reply — an empty reply is indistinguishable from a pass that
legitimately found nothing, which would make the demo go green having done nothing at all.

## Development

```bash
npm test
npx tsc --noEmit      # tests included in typecheck
npm run lint
```

## License

Apache-2.0.
