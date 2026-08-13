/**
 * `npm run board` — read the configured tracker and print what the pipeline would see.
 *
 * **This is the observed effect behind `TRACKER`.** `ADAPTERS.md` documents `TRACKER=clickup` as
 * the switch that selects an adapter; until this file existed nothing read the variable, so the
 * documented control did nothing and a reader had no way to find that out except by reading the
 * source. Now there is a command that fails loudly on a bad credential and prints a real board on a
 * good one.
 *
 * **Read-only by construction.** It calls `listTasks` and the shared snapshot renderer, and holds no
 * code path that writes. Proving the adapter seam should never require writing to somebody's board.
 *
 * The scenario demo deliberately does NOT honour `TRACKER`: fixtures replay against the in-memory
 * board, and a user with `TRACKER=clickup` in their `.env` running `npm run demo` must never have
 * fixture content written to a real workspace.
 *
 *   npm run board                 # uses TRACKER from the environment
 *   npm run board -- --tracker linear
 */
import { TRACKER } from '../config';
import { makeTracker } from '../trackers/factory';
import { renderBoardSnapshot } from '../trackers/renderSnapshot';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--tracker');
  const name = flag >= 0 ? argv[flag + 1] : TRACKER;

  const tracker = makeTracker({ ...(name ? { tracker: name } : {}) });
  console.log(`tracker: ${name}\n`);

  const tasks = await tracker.listTasks();
  if (!tasks.length) {
    // Distinguished from a failure on purpose: an empty board is a legitimate answer, and printing
    // nothing at all would read as "the call did not happen".
    console.log('(no open tasks — the adapter answered, the board is empty)');
    return;
  }

  console.log(renderBoardSnapshot(tasks));
  console.log(`\n${tasks.length} task(s). Capabilities: ${JSON.stringify(tracker.capabilities)}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
