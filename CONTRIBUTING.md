# Contributing

This is a reference implementation, not a maintained product — see the README's second paragraph.
That shapes what "contributing" means here.

## What a PR is for

The architecture is the artifact. A PR is welcome when it makes the architecture more correct, more
tested, or more honestly documented:

- a bug in a gate, a parser, or the idempotency/locking layers
- a new `TrackerAdapter`, `ModelClient`, or `IngestSource` — the seams exist because there was a real
  second implementation to write; a third is evidence they hold
- a test that catches something the suite currently misses — mutation-check it: revert your fix and
  confirm the new test fails, not just that it passes
- a documentation correction where the prose and the code disagree

A PR is **not** the right shape for a feature request, a roadmap item, or "can you add support for
X" — there is no maintainer capacity behind this repo for that, and pretending otherwise would be a
worse answer than saying so here.

## Before you open one

Everything the CI runs, you can run first:

```bash
npm ci
npx tsc --noEmit      # tests included in typecheck
npm run lint
npm test
npm run demo -- --twice
npm run demo -- --provider anthropic
npm run demo -- --agents
npm run demo -- --agents --provider anthropic
npm run eval
```

If you touched a prompt, a parser, or anything the demo replays: run every mode above. A cassette
that silently stops matching its recording is exactly the failure class this repo's own commit
history is full of finding.

## What will get a PR declined

- A stub — code that exists to make a claim rather than to run. If a capability isn't built, it
  belongs in `LIMITATIONS.md`, not in a half-finished module.
- Anything that reads a tracker id where the pipeline should be speaking a canonical name — that
  boundary is load-bearing, see `ARCHITECTURE.md`.
- A test that passes against the bug it claims to catch. Revert your fix locally and confirm the new
  test actually fails first.

## Reporting a bug

Open an issue with the scenario or command that reproduces it, and what you expected instead. If
it's a question rather than a bug, use
[Discussions](https://github.com/agentloopr/Triage/discussions) — it's indexed and
searchable, an issue tracker isn't.

## Security

See [SECURITY.md](SECURITY.md).
