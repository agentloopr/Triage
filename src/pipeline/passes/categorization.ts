/**
 * Pass 2a — categorization, orchestrated.
 *
 * One model call per inventory item, through a bounded pool. Every call shares an identical prefix
 * (instructions + the whole board snapshot + the source), so the first call is deliberately
 * serialized to warm the provider's prefix cache before the rest fan out — see `runWarmedPool`.
 *
 * **Per-item fault isolation is the point of the shape.** One item's call failing, returning empty,
 * or producing an unparseable block costs exactly that item; the rest of the meeting still lands.
 * Failed items are collected and reported, never silently dropped.
 */
import { runWarmedPool } from '../../utils/pool';
import { type CategorizationItem, parseCategorizationItem } from '../parsing/categorizationManifest';
import { buildCategorizationPrompt } from '../prompts/categorization';
import type { EnrichedInventoryItem } from '../types';

/** Runs one categorization prompt and returns the model's raw reply. */
export type CategorizationAgentRunner = (prompt: string, label: string, system?: string) => Promise<string>;

export type CategorizationPassInput = {
  items: EnrichedInventoryItem[];
  boardSnapshot: string;
  sourceSummary: string;
  sourceText: string;
  participantLine?: string;
  todayIso?: string;
  /** item number → pre-fetched evidence block. */
  tier2ByItem?: Map<number, string>;
};

export type CategorizationPassResult = {
  /** Parsed manifest entries in inventory order; failed items omitted. */
  items: CategorizationItem[];
  /** item number → raw reply, for traces. */
  rawByItem: Map<number, string>;
  /** Items whose call errored, returned empty, or did not parse. Surfaced, never swallowed. */
  failedItems: number[];
};

export type CategorizationPassOptions = {
  runAgent: CategorizationAgentRunner;
  poolSize?: number;
  warmFirst?: boolean;
  warmDelayMs?: number;
  onItem?: (result: CategorizationItem | null, itemNumber: number) => void;
};

export async function runCategorizationPass(
  input: CategorizationPassInput,
  opts: CategorizationPassOptions
): Promise<CategorizationPassResult> {
  const { items } = input;
  const parsed: Array<CategorizationItem | null> = new Array(items.length).fill(null);
  const rawByItem = new Map<number, string>();
  const failedItems: number[] = [];

  if (items.length === 0) return { items: [], rawByItem, failedItems };

  const processOne = async (i: number): Promise<void> => {
    const inv = items[i]!;
    const parts = buildCategorizationPrompt(inv, input.boardSnapshot, input.sourceSummary, input.sourceText, {
      ...(input.participantLine ? { participantLine: input.participantLine } : {}),
      totalItems: items.length,
      ...(input.todayIso ? { todayIso: input.todayIso } : {}),
      ...(input.tier2ByItem?.get(inv.number) ? { tier2Evidence: input.tier2ByItem.get(inv.number)! } : {}),
    });

    try {
      const reply = await opts.runAgent(parts.user, `pass2a:item${inv.number}`, parts.system);
      rawByItem.set(inv.number, reply);

      const item = reply.trim() ? parseCategorizationItem(reply, inv.number) : null;
      if (item) {
        // The inventory is authoritative for identity — trust it over a model echo, which can garble
        // the number or title. The description is deliberately dropped; FINAL_DESC supersedes it.
        item.item = inv.number;
        if (!item.title) item.title = inv.title;
        if (inv.timestamp) item.timestamp = inv.timestamp;
        parsed[i] = item;
      } else {
        failedItems.push(inv.number);
      }
      opts.onItem?.(item, inv.number);
    } catch {
      failedItems.push(inv.number);
      opts.onItem?.(null, inv.number);
    }
  };

  await runWarmedPool(items.length, Math.max(1, opts.poolSize ?? 5), processOne, {
    ...(opts.warmFirst !== undefined ? { warmFirst: opts.warmFirst } : {}),
    ...(opts.warmDelayMs !== undefined ? { warmDelayMs: opts.warmDelayMs } : {}),
  });

  failedItems.sort((a, b) => a - b);
  return { items: parsed.filter((x): x is CategorizationItem => x !== null), rawByItem, failedItems };
}
