# Evaluation

```bash
npm run eval
```

Scores the shipped fixture runs on six dimensions. Runs offline against cassettes, so it costs
nothing and gives the same answer every time.

## What is measured

| Dimension | Question |
|---|---|
| **Task creation** | When something should become a task, did one get created — with enough detail to act on? |
| **Routing** | Did it reach the right person *and* the right list? |
| **Status updates** | When real-world status changed, did the card change to match? |
| **Information capture** | Did the full detail land in the description or comment — not truncated? |
| **Catch / miss rate** | Did it surface what should be tracked, and not silently drop anything? |
| **False alarms** | Did it avoid raising already-done work or non-issues? |

The last two matter most and are the least symmetric. A false alarm is visible and annoying; a miss
is invisible and expensive. People stop reading output that cries wolf, and never notice output that
quietly drops things.

## What this does NOT claim

**No precision or recall figures.** They would be easy to print and would not mean anything.

Scoring accuracy needs a hand-labelled corpus — a human deciding, independently, what each item
*should* have been. Without one, the only available option is to have a model grade the model, which
is a system agreeing with itself. The number would look authoritative and carry no information.

So: volume, disposition and hold rate are honest here. Accuracy is not, and is not reported.

**`miss_rate` is never scored from events.** A dropped item leaves no event, so there is nothing in
the trace to score — scoring it from the trace would be measuring a blind spot with the blind spot.
It appears in the report as *not scored*, deliberately, rather than as a passing grade.

## How scoring works

**Objective code-checks first.** Everything answerable by inspection is answered that way:

- did a card that was supposed to exist end up existing?
- does an item that creates work have both a list and an owner?
- did an update actually carry its detail, or a 6-character stub?
- did a duplicate/update/subtask decision cite the evidence it is required to cite?

Reproducible, free, and not arguable. A judge model can be layered on for the dimensions code cannot
reach, but **a code result always wins the merge** — an opinion never overrides something checkable.

A hold scores **partial**, not fail. Asking a human is a valid outcome; the system is designed to do
it. Only a silent wrong write, or work that vanished, is a failure.

## Strict is the default

There is deliberately **no `--strict` flag**. Passing one is a hard error.

That is not pedantry. The version this harness was extracted from returned an empty array on three
separate paths — unreadable file, missing step, blocks matching no items — and skipped null parses
silently. A prompt edit that changed the manifest's shape produced an eval reporting **zero events
and no error**, which at a glance is indistinguishable from a clean run. `--strict` existed, was
accepted, and did nothing, so every habit and document that passed it was claiming a guarantee that
was never delivered.

Now every one of those paths throws `TraceParseError` naming the file, and the report always states
how many events were parsed — so even a `--lenient` run is visibly wrong rather than quietly empty.

```bash
npm run eval -- --lenient           # warn instead of throw (messy real traces)
npm run eval -- --traces ./traces   # score recorded runs instead of fixtures
```

## Using it during prompt changes

The intended workflow when editing a prompt:

1. `npm run eval` before, and keep the output.
2. Make the edit.
3. `npm run record -- --scenario <name> --provider deepseek` to re-record.
4. `npm run eval` after, and diff the six numbers.

**A dimension moving by more than one item is stop-and-inspect.** The point is not that the number
went down — it is that a change you believed was cosmetic moved behaviour at all.

Two things make this trustworthy rather than theatre: cassettes carry a `.sha` of the prompt they
were recorded against, so a stale one warns loudly by name; and the four locked regression cases in
`fixtures/regression/` fail outright if a previously-fixed mistake returns.
