/**
 * `npm run correct` — the write half of the human-correction loop.
 *
 * **Why this file had to exist.** The read half was always wired: `learnedFactsBlock()` reaches both
 * the 2a and 2b prompts, and `isKnownNotDuplicate()` is consulted by the cross-item gate. But
 * `recordCorrection` and `recordNotDuplicate` had **zero non-test call sites**, so nothing in the
 * repo could capture a correction. Scenario `05-corrections` passed only because its
 * `corrections.json` ships hand-authored. PRD §11 P1 asks for a loop; half a loop was shipping.
 *
 * These functions were already written, already atomic and already tested — what was missing was a
 * way to reach them. That is the whole of this file.
 *
 *   npm run correct -- note "Pricing work goes to the growth list until Q3" --scope pricing
 *   npm run correct -- assignee --list backend --name "Avery Chen"
 *   npm run correct -- list-alias --from "the api board" --to backend
 *   npm run correct -- name-alias --from "av" --to "Avery Chen"
 *   npm run correct -- not-duplicate --title "Add export endpoint" --existing t-a1b2
 *   npm run correct -- show
 *
 * `--by` names the human making the call and defaults to `$USER`. It is stored with every entry
 * because a correction with no author is impossible to question later.
 */
import { CORRECTIONS_PATH } from '../config';
import { loadCorrections, recordCorrection, recordNotDuplicate } from '../state/corrections';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Fail on a missing value rather than writing a correction with `undefined` in it. */
function required(argv: string[], name: string): string {
  const v = arg(argv, name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

const USAGE = `usage: npm run correct -- <command> [options]

  note <text> [--scope <listKey>]        a fact the pipeline should carry into later prompts
  assignee --list <key> --name <member>  allow a member to own work on that list
  unassignee --list <key> --name <member>
  list-alias --from <alias> --to <key>   what people call a list vs its canonical key
  name-alias --from <alias> --to <name>
  not-duplicate --title <t> --existing <id>   two items that look alike and are not
  show                                   print the current corrections store

  --by <who>   who is making the call (default: $USER)`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const by = arg(argv, 'by') ?? process.env.USER ?? 'unknown';

  switch (cmd) {
    case 'note': {
      // Positional, because the text is the point and quoting it twice is a papercut.
      const text = argv[1];
      if (!text || text.startsWith('--')) throw new Error('note needs text: npm run correct -- note "…"');
      const scope = arg(argv, 'scope');
      await recordCorrection({ kind: 'note', text, ...(scope ? { scope } : {}) }, by);
      console.log(`✓ noted${scope ? ` (scope: ${scope})` : ''}`);
      break;
    }
    case 'assignee':
      await recordCorrection(
        { kind: 'valid_assignee', listKey: required(argv, 'list'), assigneeName: required(argv, 'name') },
        by
      );
      console.log('✓ assignee allowed');
      break;
    case 'unassignee':
      await recordCorrection(
        { kind: 'remove_valid_assignee', listKey: required(argv, 'list'), assigneeName: required(argv, 'name') },
        by
      );
      console.log('✓ assignee removed');
      break;
    case 'list-alias':
      await recordCorrection({ kind: 'list_alias', alias: required(argv, 'from'), canonical: required(argv, 'to') }, by);
      console.log('✓ list alias recorded');
      break;
    case 'name-alias':
      await recordCorrection({ kind: 'name_alias', alias: required(argv, 'from'), canonical: required(argv, 'to') }, by);
      console.log('✓ name alias recorded');
      break;
    case 'not-duplicate':
      await recordNotDuplicate(required(argv, 'title'), required(argv, 'existing'), by);
      console.log('✓ pair recorded as NOT duplicates — the cross-item gate will stop holding it');
      break;
    case 'show': {
      const s = loadCorrections();
      console.log(`${CORRECTIONS_PATH}\n`);
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }

  if (cmd !== 'show') console.log(`  → ${CORRECTIONS_PATH} (read into the next run's prompts)`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  console.error(USAGE);
  process.exit(1);
});
