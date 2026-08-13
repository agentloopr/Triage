/**
 * Tracker selection, the counterpart to `providers/factory.ts`.
 *
 * **Why this file had to exist.** `ADAPTERS.md` opened with `TRACKER=memory|clickup|linear` and
 * `.env.example` carried the key, but nothing in the codebase read it: both real adapters were
 * constructed only inside the contract suite, so setting `TRACKER=clickup` with a valid token gave
 * you the in-memory board and no error at all. That is the exact failure this repo documents as its
 * own lesson — *"Four separate controls in that review looked correctly configured while doing
 * nothing at all. Configuration is a claim; only an observed effect is evidence."*
 *
 * **Defaults to `memory`**, so a clone with no `.env` still runs the demo with no credentials.
 *
 * **A missing credential is a loud error, never a silent fallback to `memory`.** Falling back would
 * reproduce the original bug in a new place: the run would appear to work while writing to a board
 * that evaporates when the process exits.
 */
import { CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, LINEAR_API_KEY, TRACKER } from '../config';
import type { BoardTask, TrackerAdapter } from './index';
import { clickupTracker } from './clickup';
import { linearTracker } from './linear';
import { memoryTracker } from './memory';

export type TrackerName = 'memory' | 'clickup' | 'linear';

export interface TrackerFactoryOptions {
  tracker?: TrackerName | string;
  /** Seed board for the in-memory tracker. Ignored by the live adapters, which read the real board. */
  tasks?: BoardTask[];
  protectedStatuses?: string[];
}

export function makeTracker(opts: TrackerFactoryOptions = {}): TrackerAdapter {
  const name = (opts.tracker ?? TRACKER) as TrackerName;
  const protectedStatuses = opts.protectedStatuses;

  switch (name) {
    case 'memory':
      return memoryTracker({
        ...(opts.tasks ? { tasks: opts.tasks } : {}),
        ...(protectedStatuses ? { protectedStatuses } : {}),
      });

    case 'clickup':
      // Named individually rather than as "credentials missing": a token without a team id is the
      // more common mistake and the message should say which half is absent.
      if (!CLICKUP_API_TOKEN) throw new Error('TRACKER=clickup needs CLICKUP_API_TOKEN');
      if (!CLICKUP_TEAM_ID) throw new Error('TRACKER=clickup needs CLICKUP_TEAM_ID');
      return clickupTracker({ ...(protectedStatuses ? { protectedStatuses } : {}) });

    case 'linear':
      if (!LINEAR_API_KEY) throw new Error('TRACKER=linear needs LINEAR_API_KEY');
      return linearTracker({ ...(protectedStatuses ? { protectedStatuses } : {}) });

    default:
      throw new Error(`unknown TRACKER "${name}" — expected memory | clickup | linear`);
  }
}
