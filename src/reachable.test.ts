/**
 * Every module must be reachable from something a user can run.
 *
 * **This test exists because the same defect shipped four times.** Each was real code with real
 * tests that nothing in production imported, and each was found by a human reading the repo rather
 * than by anything automated:
 *
 *   1. the observability seam — traced nothing, because nothing constructed it;
 *   2. `makeToolLoopRunner` — a working agent loop with zero call sites;
 *   3. `src/sources/` — three read clients, a contract suite, and no way to reach any of them;
 *   4. `pipeline/resume.ts` — the repo could *create* a human hold and had no way to answer one,
 *      which made "human-in-the-loop" a loop that did not close.
 *
 * A green test suite cannot see this. Tests import the module directly, so the module is exercised
 * and unreachable at the same time, and the coverage report looks fine. That is the whole trap:
 * **being tested and being reachable are different properties**, and only one of them was ever
 * checked.
 *
 * The rule is module-level rather than symbol-level, deliberately. A symbol-level version flags 54
 * of 175 exports here, almost all of them helpers exported so a unit test can reach them — which is
 * good practice, not a defect. Exporting a helper for a test is fine. Shipping a *file* that only a
 * test ever imports is not: it means no user can get to it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const isTest = (f: string): boolean => f.endsWith('.test.ts');

/** Relative imports only — a package import cannot make a local file reachable. */
function localImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/from '(\.[^']+)'/g)) {
    const base = resolve(dirname(file), m[1]!);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

/**
 * What a user can actually invoke: every CLI in `package.json`'s scripts, plus the package entry
 * point if one exists. Deriving the list from `src/cli/*.ts` instead would let an orphaned CLI —
 * a file nothing runs — vouch for everything it imports.
 */
function entryPoints(): string[] {
  const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
    main?: string;
  };
  const entries = new Set<string>();

  for (const cmd of Object.values(pkg.scripts ?? {})) {
    for (const m of cmd.matchAll(/(src\/[\w./-]+\.ts)/g)) {
      const p = resolve(SRC, '..', m[1]!);
      if (existsSync(p)) entries.add(p);
    }
  }
  const index = join(SRC, 'index.ts');
  if (existsSync(index)) entries.add(index);

  return [...entries];
}

describe('every module is reachable from something a user can run', () => {
  it('has no file that only a test imports', () => {
    const all = walk(SRC).filter((f) => !isTest(f));
    const entries = entryPoints();
    expect(entries.length, 'no entry points found — the walk below would pass vacuously').toBeGreaterThan(0);

    // Transitive closure from the entry points. A module is reachable if a user can invoke
    // something that (eventually) imports it.
    const reached = new Set<string>();
    const queue = [...entries];
    while (queue.length) {
      const f = queue.pop()!;
      if (reached.has(f)) continue;
      reached.add(f);
      queue.push(...localImports(f).filter((d) => !reached.has(d)));
    }

    const orphans = all
      .filter((f) => !reached.has(f))
      .map((f) => f.slice(SRC.length + 1))
      .sort();

    expect(
      orphans,
      'These modules are imported by tests and by nothing a user can run, which means the ' +
        'behaviour they contain is unreachable however green the suite looks:\n' +
        orphans.map((o) => `  ${o}`).join('\n') +
        '\n\nEither wire it to a CLI or delete it. Do not add an allowlist — an allowlist is how ' +
        'this defect hid four times.'
    ).toEqual([]);
  });
});
