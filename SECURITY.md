# Security

## Scope

This is a reference implementation, not a maintained service — see the README. There is no patch
SLA and no guarantee a report gets fixed on any timeline. What is guaranteed:

- every push to `main`, and every pull request, runs a full-history
  [gitleaks](https://github.com/gitleaks/gitleaks) scan and an internal-identifier guard in CI
  (`.github/workflows/ci.yml`, `secrets` job). `main` is protected and requires those checks. The
  `metrics` branch is written by a bot and is **not** covered by that job — it is constrained
  instead by an allowlist in `traffic.yml` that refuses to publish anything but aggregate counts

## What happens to untrusted text before it reaches a model

Every externally-authored input is screened at the prompt boundary — the source (transcript, channel
log, email thread, GitHub activity, Drive comments), the board snapshot, comment history, retrieved
documents, and every tool result:

- **Secrets are redacted unconditionally.** A key pasted into a Slack channel or a card description
  never leaves the process. This is not hypothetical for chat sources.
- **Injection patterns are detected and the text is framed as data**, not dropped — removing the
  matched line destroys the evidence the categorization pass needs to match a card.
- **The alert names the rule, the length and a digest — never the matched text.** A security log that
  copies the content it flagged is a second store of the thing worth protecting.

**This is not a sandbox.** The pattern list is regexes; a rephrased attack walks past it. What bounds
the damage is structural and downstream: the writer is deterministic, every write passes the gates,
and Pass 2b re-derives the categorization blind. A successful injection can mislead a
categorization. It cannot author a write.

## Which commands touch a live service

Eight, not the four an earlier version of this file claimed — that version predated
`scripts/`, and the count drifted again the moment those shipped without this table being updated.
Whatever this number says next, verify it against `package.json`'s `scripts` block rather than
trusting it on its own:

| command | network | credentials | writes? |
|---|---|---|---|
| `npm run board` | tracker | tracker token | no — read-only |
| `npm run pull` | source + model provider + tracker | source, model, tracker | **only with `--write`**; plans otherwise |
| `npm run answer` | tracker | tracker token | **yes** — `--approve` executes a held write |
| `npm run record` | model provider | model key | writes cassettes to disk, not to a tracker |
| `npm run record:regression` | model provider | model key | writes cassettes to disk, not to a tracker |
| `npm run cost:deepseek` | model provider (DeepSeek) | `DEEPSEEK_API_KEY` | no — tallies token usage only |
| `npm run smoke:tracker` | tracker | tracker token | no — read-only, `apply()` is never called |
| `npm run smoke:tracker:write` | tracker | tracker token, plus `--list`/`--team`/`--member` | **yes** — creates a real task/issue, exercises `setStatus`/`setAssignees`/`addComment`, then deletes what it created. Point it only at a workspace you know is disposable |

Everything else — `demo`, `test`, `eval`, `lint`, `typecheck` — runs with no network and no key. That
is enforced in CI rather than asserted here: the `build` job has no secrets in its environment and
still runs all five demo modes and the eval.

Grant the minimum scope each one needs; a tracker token that can only read is enough for
`npm run board` or `npm run smoke:tracker`, and `npm run smoke:tracker:write` should only ever hold a
token scoped to a disposable workspace, never a production one.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/agentloopr/Triage/security/advisories/new)
on this repo, or email **security@agentloopr.com**. Include the scenario or command that reproduces
it. Please don't open a public issue for something exploitable — everything else (a bug that isn't a
vulnerability) is fine as a normal issue.

## What's out of scope

- The agent layer's prompts producing an unwanted *category* or *proposal* — that's a quality
  question, not a security one. The structural guarantee (read-only tools, every proposal re-gated,
  never un-holds) is what's load-bearing; see [AGENTS.md](AGENTS.md).
- Findings that require a maintainer to have wired their own live credentials insecurely — the
  `.env.example` file and every doc that touches configuration says these are placeholders.
