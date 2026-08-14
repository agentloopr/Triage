# Security

## Scope

This is a reference implementation, not a maintained service — see the README. There is no patch
SLA and no guarantee a report gets fixed on any timeline. What is guaranteed:

- every commit runs a full-history [gitleaks](https://github.com/gitleaks/gitleaks) scan and an
  internal-identifier guard in CI (`.github/workflows/ci.yml`, `secrets` job)
- the credential seam is narrow by design: only `npm run pull` and `npm run board` ever touch a
  live service, and both read a `TrackerAdapter`/`SourceClient` you configure yourself — nothing else
  in the repo needs a network or a key

## Reporting a vulnerability

Open a [private security advisory](https://github.com/agentloopr/ops-agent-reference/security/advisories/new)
on this repo, or email **security@agentloopr.com**. Include the scenario or command that reproduces
it. Please don't open a public issue for something exploitable — everything else (a bug that isn't a
vulnerability) is fine as a normal issue.

## What's out of scope

- The agent layer's prompts producing an unwanted *category* or *proposal* — that's a quality
  question, not a security one. The structural guarantee (read-only tools, every proposal re-gated,
  never un-holds) is what's load-bearing; see [AGENTS.md](AGENTS.md).
- Findings that require a maintainer to have wired their own live credentials insecurely — the
  `.env.example` file and every doc that touches configuration says these are placeholders.
