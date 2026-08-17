/**
 * Opt-in, read-only smoke check against a REAL tracker workspace.
 *
 * Excluded from CI on purpose — a public repo's CI cannot hold private ClickUp/Linear credentials,
 * and even if it could, running this against someone else's workspace on every PR is the wrong
 * blast radius for a check that exists to catch endpoint/field drift, not to gate merges.
 *
 * This is the thing the 2026-08-13 audit asked for: "live-smoke claims are testimony, not
 * CI-reproducible... add optional credentialed smoke scripts excluded from CI." Before this, the
 * only evidence live adapters actually worked against a real tracker was a sentence in a doc with no
 * script behind it.
 *
 * Calls ONLY `listTasks` / `getTask` / `getComments` — never `apply()`. It cannot write to your
 * board. Confirms auth headers, endpoint paths, and field mapping actually match what the adapter
 * code assumes, against your own workspace, not a wire fake.
 *
 * Usage (against whichever tracker TRACKER selects in your .env):
 *   TRACKER=clickup  CLICKUP_API_TOKEN=... CLICKUP_TEAM_ID=... npx tsx scripts/smokeTracker.ts
 *   TRACKER=linear   LINEAR_API_KEY=...                        npx tsx scripts/smokeTracker.ts
 */
import { makeTracker } from '../src/trackers/factory';

async function main() {
  const tracker = makeTracker();
  if (tracker.name === 'memory') {
    console.error('TRACKER is unset or "memory" — set TRACKER=clickup or TRACKER=linear plus credentials.');
    process.exit(1);
  }

  console.log(`▶ smoke-testing "${tracker.name}" (read-only — this cannot write to your board)\n`);

  const tasks = await tracker.listTasks();
  console.log(`listTasks(): ${tasks.length} task(s)`);

  if (tasks.length > 0) {
    const first = tasks[0]!;
    console.log(`  sample: ${first.id} — "${first.title}" [${first.listKey}] status=${first.status}`);

    const fetched = await tracker.getTask(first.id);
    console.log(`getTask("${first.id}"): ${fetched ? 'found' : 'NOT FOUND — id round-trip is broken'}`);

    const comments = await tracker.getComments(first.id, 5);
    console.log(`getComments("${first.id}"): ${comments.length} comment(s)`);

    const snapshot = tracker.renderSnapshot(tasks.slice(0, 3));
    console.log(`renderSnapshot(): ${snapshot.length} chars`);
  } else {
    console.log('  (empty board — auth and endpoint reached the API, but nothing to sample fields from)');
  }

  console.log(`\n✓ ${tracker.name} reached, authenticated, and mapped fields without error.`);
}

main().catch((err) => {
  console.error('\n✗ smoke check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
