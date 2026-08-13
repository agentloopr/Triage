/**
 * Fixture loading for the offline demo and the recorder.
 *
 * A scenario is a directory holding everything one run needs: the source, the board it runs against,
 * the registry that governs routing, and the expected outcome. Keeping them together means a
 * scenario can be read, understood and changed by one person without touching code.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IngestSource, IngestedSource } from './ingest';
import { channelSource } from './ingest/channel';
import { driveSource } from './ingest/drive';
import { githubSource } from './ingest/github';
import { gmailSource } from './ingest/gmail';
import { transcriptSource } from './ingest/transcript';
import type { BoardTask } from './trackers';

export const FIXTURES_ROOT = resolve('./fixtures/scenarios');

/** The outcome a scenario asserts — the golden file. */
export type ExpectedOutcome = {
  description: string;
  inventoryCount: number;
  categories: Record<string, number>;
  cleanCount: number;
  heldCount: number;
  skippedNotTaskCount: number;
  createdCount: number;
  /** Gate names expected to fire, in no particular order. */
  heldGates?: string[];
};

export type Scenario = {
  name: string;
  dir: string;
  source: IngestedSource;
  board: BoardTask[];
  registryPath: string;
  correctionsPath?: string;
  expected: ExpectedOutcome;
};

export function listScenarios(root = FIXTURES_ROOT): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/**
 * Which filename in a scenario directory means which source. A table rather than a chain of
 * `else if`, so adding a source is one row — and so that "the pipeline does not care which source
 * produced it" stays true of the *loader* too, which was the one place still enumerating them by
 * hand. First match wins; a scenario carries exactly one source file.
 */
const SOURCE_FILES: ReadonlyArray<readonly [string, IngestSource<never>]> = [
  ['transcript.json', transcriptSource as IngestSource<never>],
  ['channel.json', channelSource as IngestSource<never>],
  ['github.json', githubSource as IngestSource<never>],
  ['gmail.json', gmailSource as IngestSource<never>],
  ['drive.json', driveSource as IngestSource<never>],
];

export function loadScenario(name: string, root = FIXTURES_ROOT): Scenario {
  const dir = join(root, name);
  if (!existsSync(dir)) {
    throw new Error(`no such scenario "${name}" — available: ${listScenarios(root).join(', ') || '(none)'}`);
  }

  const found = SOURCE_FILES.find(([file]) => existsSync(join(dir, file)));
  if (!found) {
    throw new Error(`scenario "${name}" has none of: ${SOURCE_FILES.map(([f]) => f).join(', ')}`);
  }
  const [file, ingest] = found;
  const source: IngestedSource = ingest.normalize(readJson(join(dir, file)));

  const correctionsPath = join(dir, 'corrections.json');

  return {
    name,
    dir,
    source,
    board: readJson<BoardTask[]>(join(dir, 'board.json')),
    registryPath: join(dir, 'ops-registry.json'),
    expected: readJson<ExpectedOutcome>(join(dir, 'expected.json')),
    ...(existsSync(correctionsPath) ? { correctionsPath } : {}),
  };
}

/** Compare a run against the golden file. Returns the mismatches, empty when it matches. */
export function diffExpected(
  expected: ExpectedOutcome,
  actual: {
    inventoryCount: number;
    categories: Record<string, number>;
    cleanCount: number;
    heldCount: number;
    skippedNotTaskCount: number;
    createdCount: number;
    heldGates: string[];
  }
): string[] {
  const out: string[] = [];
  const cmp = (label: string, want: number, got: number): void => {
    if (want !== got) out.push(`${label}: expected ${want}, got ${got}`);
  };

  cmp('inventory', expected.inventoryCount, actual.inventoryCount);
  cmp('clean', expected.cleanCount, actual.cleanCount);
  cmp('held', expected.heldCount, actual.heldCount);
  cmp('skipped (not a task)', expected.skippedNotTaskCount, actual.skippedNotTaskCount);
  cmp('created', expected.createdCount, actual.createdCount);

  for (const [category, want] of Object.entries(expected.categories)) {
    cmp(`category ${category}`, want, actual.categories[category] ?? 0);
  }
  for (const category of Object.keys(actual.categories)) {
    if (!(category in expected.categories)) out.push(`category ${category}: unexpected (${actual.categories[category]})`);
  }

  for (const gate of expected.heldGates ?? []) {
    if (!actual.heldGates.includes(gate)) out.push(`expected a hold on "${gate}", but nothing did`);
  }

  return out;
}
