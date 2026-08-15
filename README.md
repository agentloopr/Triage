# traffic

Weekly snapshots of GitHub Insights → Traffic (views, clones, referrers, top paths) plus a star
count, appended by `.github/workflows/traffic.yml` on `main`. Insights only retains 14 days;
this branch is the archive.

Not a place for pull requests — it is written by CI only.

## What is deliberately not here

Raw `popular/referrers` and `popular/paths` responses. Those are privileged — GitHub shows them only
to accounts with push access — and this branch is public. Today's values are benign; a future
referrer can be an internal hostname, an unreleased campaign URL, or a private workspace that linked
here, and a weekly job that publishes them would disclose it before anyone noticed.

The export keeps the aggregates (how many distinct referrers, totals) and drops the names. The names
remain readable in the repository's Insights tab by anyone entitled to see them.
