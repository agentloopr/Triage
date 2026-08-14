---
name: Bug report
about: Something in the pipeline, a gate, or a demo scenario behaves incorrectly
title: ''
labels: bug
---

**What command or scenario reproduces it**
e.g. `npm run demo -- --agents` — scenario `06-github-activity`

**What you expected**

**What actually happened**
Paste the relevant output. If it's a test failure, paste `npm test` output for that file.

**Environment**
- Node version:
- OS:

**Have you run the repo's own verification?**
```bash
npx tsc --noEmit && npm run lint && npm test
```
If any of these fail on a clean checkout (no local changes), say so — that's a different bug than
one only your own changes trigger.
