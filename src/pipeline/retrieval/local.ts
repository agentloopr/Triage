/**
 * A local-filesystem `Retriever` — the "local" half of the interface's own doc comment, which
 * shipped with only the "null" half implemented. Reads every `.md`/`.txt` file under one directory
 * once, and ranks them against a query by the same Jaccard token overlap the cross-item gates already
 * use for title similarity (`contractGates.ts`) — one scoring function, one floor to tune, instead of
 * a second one invented just for this.
 *
 * **Still not a claim that retrieval helps.** Nothing here has been evaluated against real
 * production output — see `LIMITATIONS.md`. What this closes is only "the interface said local-or-
 * null and only null shipped"; a flat-file ranker is the smallest thing that plugs into the seam
 * without inventing a vector store this repo has no way to evaluate.
 *
 * **Off by default, same discipline as everything else in this seam.** `RETRIEVAL_DIR` unset means
 * `deps.retrieval` stays omitted entirely — not `localRetriever` pointed at nothing — so the default
 * prompt stays byte-identical and every cassette keeps replaying.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jaccard } from '../evidence/tier2Prefetch';
import type { RetrievedDocument, Retriever } from './index';

const DOC_RE = /\.(md|txt)$/i;

// Below this, an overlap is a shared common word or two, not a real match — the same reasoning as
// the candidate selector's own floor (`selectCandidateIds`, tier2Prefetch.ts), just looser: a whole
// document naturally shares less of its token set with a short item title than two titles share
// with each other.
const MATCH_FLOOR = 0.15;

export function localRetriever(dir: string): Retriever {
  let docs: RetrievedDocument[] | null = null;

  function load(): RetrievedDocument[] {
    if (docs) return docs;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => DOC_RE.test(f));
    } catch {
      // A missing or unreadable directory is a configuration mistake worth surfacing in logs, not a
      // crash — the same posture `roleProfiles.ts` takes on a missing role file.
      console.warn(`[retrieval] RETRIEVAL_DIR "${dir}" is not readable — retrieval will return nothing.`);
      docs = [];
      return docs;
    }
    docs = files.map((f) => ({ id: f, text: readFileSync(join(dir, f), 'utf8'), source: dir }));
    return docs;
  }

  return {
    name: 'local',
    async retrieve({ text, k }) {
      return load()
        .map((d) => ({ ...d, score: jaccard(text, d.text) }))
        .filter((d) => d.score! >= MATCH_FLOOR)
        .sort((a, b) => b.score! - a.score!)
        .slice(0, k);
    },
  };
}
