/**
 * `npm run answer` — the other half of a human hold.
 *
 * **Why this file had to exist.** The pipeline could raise a hold, persist it before announcing it,
 * and store the exact decision needed to finish the item. `resumeHold` was written, tested and
 * correct. Nothing could call it: **zero non-test call sites, and no command anywhere that answered
 * a question.** So "human-in-the-loop" named a loop that did not close — the repo's headline claim,
 * half-built, behind a green test suite.
 *
 * That is the fourth time this repo shipped exactly this shape, which is why `reachable.test.ts`
 * now fails on any module only a test imports. This CLI is what that test found.
 *
 *   npm run answer                       list every open hold, and why each is held
 *   npm run answer -- <id> --approve     replay the stored decision; writes the card
 *   npm run answer -- <id> --skip        drop it; nothing is written
 *
 * **No model runs here, and that is the point.** Approving replays the decision Pass 2a/2b already
 * made and stored, through the same `planOperations` → `executeOperations` chain the clean items
 * took. A second inference on resume would mean the human approved one thing and something else got
 * written — and the divergence would be invisible, because both outputs look like the model's work.
 */
import { join } from 'node:path';
import { STATE_DIR, TRACKER } from '../config';
import { resumeHold } from '../pipeline/resume';
import { pendingHumanStore } from '../state/pendingHuman';
import { makeTracker } from '../trackers/factory';

/** Where a hold lives between the run that raised it and the human who answers it. */
const HOLDS_PATH = join(STATE_DIR, 'pending-human.json');

const USAGE = `usage: npm run answer [-- <id> --approve|--skip]

  npm run answer                     list every open hold
  npm run answer -- <id> --approve   replay the stored decision and write the card
  npm run answer -- <id> --skip      drop it; nothing is written

Holds are read from ${HOLDS_PATH} (STATE_DIR).
A run only writes holds there if it was given a pending-human store — see ARCHITECTURE.md.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const store = pendingHumanStore(HOLDS_PATH);
  const id = argv.find((a) => !a.startsWith('--'));

  if (!id) {
    const open = store.list();
    if (!open.length) {
      console.log(`\nNo open holds in ${HOLDS_PATH}.\n`);
      return;
    }
    console.log(`\n${open.length} open hold(s) — ${HOLDS_PATH}\n`);
    for (const h of open) {
      // `originalItem` is what makes a hold answerable. Its absence is shown here rather than
      // discovered on approval: the registry-degraded gate holds a whole batch without a per-item
      // decision, and approving one would mean inventing the write.
      const resumable = h.originalItem ? '' : '   ⚠ not answerable — held without a per-item decision';
      console.log(`  ${h.id}`);
      console.log(`    ${h.title}`);
      console.log(`    gate: ${h.gate}${h.notifyAssignee ? ` · for: ${h.notifyAssignee}` : ''}`);
      console.log(`    ${h.question.split('\n')[0]}`);
      if (resumable) console.log(resumable);
      console.log('');
    }
    console.log('Answer one with:  npm run answer -- <id> --approve\n');
    return;
  }

  const approve = argv.includes('--approve');
  const skip = argv.includes('--skip');
  if (approve === skip) {
    // Both or neither. Defaulting either way decides on someone's behalf, which is the one thing a
    // hold exists to avoid.
    throw new Error('pass exactly one of --approve or --skip');
  }

  const outcome = await resumeHold(store, id, approve ? 'approve' : 'skip', { tracker: makeTracker() });

  switch (outcome.status) {
    case 'executed': {
      const e = outcome.exec;
      console.log(`\n✓ ${id} approved — ${e.created} created · ${e.commented} commented · ${e.failed} failed (tracker: ${TRACKER})\n`);
      // The write is reported from the executor's result, never from the fact that we asked for it.
      if (e.failed > 0) process.exit(1);
      break;
    }
    case 'skipped':
      console.log(`\n✓ ${id} skipped — nothing written\n`);
      break;
    case 'unknown':
      throw new Error(`no open hold with id "${id}" — run 'npm run answer' to list them`);
    case 'not_resumable':
      throw new Error(outcome.reason);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  console.error(USAGE);
  process.exit(1);
});
