/**
 * Every environment variable `config.ts` reads must appear in `.env.example`.
 *
 * README calls `.env.example` "the configuration". A live knob missing from it is a control nobody
 * can find without reading the source — and one of the nine this test was written for was
 * `REGISTRY_FAIL_CLOSED`, which silently disables the system's only fail-closed guard.
 *
 * This is a *drift* test, not a style test. The keys were correct once; they went stale because
 * nothing checked. A pre-publish audit is a fine way to find that, but it happens once.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

/** Keys read via the `str`/`int`/`num`/`bool` helpers — the first argument is the env var name. */
function keysReadByConfig(): string[] {
  const src = readFileSync(join(root, 'src/config.ts'), 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/\b(?:str|int|num|bool)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(m[1]!);
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1]!);
  return [...found].sort();
}

function keysDocumented(): string[] {
  const src = readFileSync(join(root, '.env.example'), 'utf8');
  return src
    .split('\n')
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l.trim())?.[1])
    .filter((k): k is string => !!k)
    .sort();
}

describe('.env.example is the configuration, and stays that way', () => {
  it('documents every variable config.ts reads', () => {
    const documented = new Set(keysDocumented());
    const undocumented = keysReadByConfig().filter((k) => !documented.has(k));

    expect(
      undocumented,
      `config.ts reads these but .env.example does not list them:\n  ${undocumented.join('\n  ')}\n` +
        'Add them with a comment saying what they do. A knob nobody can find is a knob nobody audits.'
    ).toEqual([]);
  });

  it('does not document variables nothing reads', () => {
    // The reverse drift: a key survives in the example file after the code stopped reading it, and
    // a reader sets it expecting an effect. `TRACKER` was exactly this until it gained a factory.
    const read = new Set(keysReadByConfig());
    const orphaned = keysDocumented().filter((k) => !read.has(k));
    expect(orphaned, `.env.example lists these but config.ts reads none of them: ${orphaned.join(', ')}`).toEqual([]);
  });
});
