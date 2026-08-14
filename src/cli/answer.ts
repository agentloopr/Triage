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
import { PENDING_HUMAN_PATH, TRACKER } from '../config';
import { resumeHold } from '../pipeline/resume';
import { pendingHumanStore } from '../state/pendingHuman';
import { fileRoleStateStore } from '../state/roleState';
import { makeTracker } from '../trackers/factory';

/**
 * Where a hold lives between the run that raised it and the human who answers it.
 *
 * Imported rather than rebuilt: this file and `pull.ts` each computing `STATE_DIR/pending-human.json`
 * separately is how `pull` came to supply no store at all while this one read an always-empty file.
 */
const HOLDS_PATH = PENDING_HUMAN_PATH;

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

  const outcome = await resumeHold(store, id, approve ? 'approve' : 'skip', {
    tracker: makeTracker(),
    // Approved work reaches role memory the same way pipeline-written work does. Without this the
    // one item a human personally signed off is the one the next run has no memory of.
    roleState: fileRoleStateStore(),
    alert: (detail) => console.error(`  ! ${detail}`),
  });

  switch (outcome.status) {
    case 'executed': {
      const e = outcome.exec;
      console.log(`\n✓ ${id} approved — ${e.created} created · ${e.commented} commented (tracker: ${TRACKER})`);
      if (outcome.audit) {
        console.log(`  audit: ${outcome.audit.passed} passed, ${outcome.audit.mismatched} mismatched\n`);
        if (outcome.audit.mismatched > 0) process.exit(1);
      } else {
        // The write landed; only the verification of it did not. Say which, rather than printing a
        // reassuring "0 mismatched" that was never actually checked.
        console.log(`  ⚠ the write landed but could not be audited: ${outcome.auditError}\n`);
      }
      if (outcome.staleClaim) {
        console.error(`  ! ${outcome.staleClaim}\n`);
        process.exit(1);
      }
      break;
    }
    case 'partially_written':
      // The board already changed, so the hold is closed — re-running would duplicate what worked.
      console.error(`\n⚠ ${id} was PARTIALLY written — ${outcome.reason}`);
      // The audit runs on a partial write and used to be computed and thrown away. It is the only
      // statement of what the board actually looks like now, which is the thing a human is about to
      // go and fix by hand.
      if (outcome.audit) console.error(`  audit: ${outcome.audit.passed} passed, ${outcome.audit.mismatched} mismatched`);
      else if (outcome.auditError) console.error(`  audit could not read the board: ${outcome.auditError}`);
      if (outcome.staleClaim) console.error(`  ! ${outcome.staleClaim}`);
      console.error(`  Some operations landed, so this is not retryable: re-running would repeat them.`);
      console.error(`  The hold is closed. Finish the remainder on the board by hand.\n`);
      process.exit(1);
      break;
    case 'write_failed':
      // The hold is still open. Saying so is the whole point: the alternative was reporting an
      // approval that changed nothing, with the queue entry already deleted.
      console.error(`\n✗ ${id} was NOT written — ${outcome.reason}`);
      console.error(`  Nothing reached the board, so the hold is still open. Fix the cause and`);
      console.error(`  re-run, or drop it with --skip.\n`);
      process.exit(1);
      break;
    case 'in_progress':
      throw new Error(
        `${id} is already being approved elsewhere (claimed ${outcome.since}). Nothing was written here. ` +
          'Wait for that run to finish, or retry once its claim expires.'
      );
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
