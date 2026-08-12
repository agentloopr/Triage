/**
 * A read-only tool loop — the optional, flag-gated second implementation of the injected runner.
 *
 * The default path pre-fetches evidence host-side and hands the model a plain completion. That is
 * bounded by the candidate selector: a card whose title is *semantically* rather than lexically
 * similar never enters the evidence block, so the model cannot cite it and the item is held instead
 * of matched. This loop lets the model go and look, which recovers some of that recall.
 *
 * **Read-only is enforced at the adapter, never in prompt text.** `readOnlyTracker` wraps a real
 * adapter and refuses every write, whatever the model asks for. This is the whole design:
 *
 *   - Prompt text is a request. A model that has been jailbroken, confused, or fed a malicious
 *     transcript can ignore it, and the only evidence would be a card that should not exist.
 *   - A wrapper is a guarantee. There is no argument the model can produce that reaches a write,
 *     because the code path does not exist.
 *
 * The production system enforces this with an environment variable read by a shell script. Same
 * intent, more moving parts, and the guarantee lives further from the thing it is guarding.
 *
 * A hard iteration cap bounds the loop. Without one, a model that keeps calling tools burns the
 * budget and the run looks like a hang rather than a failure.
 */
import { TOOL_LOOP_MAX_ITERATIONS } from '../config';
import type { ChatMessage, ModelClient, ToolSpec } from '../providers';
import { screenExternalPromptText } from '../utils/security';
import type { OpOutcome, TrackerAdapter } from '../trackers';

/**
 * Wrap an adapter so it can only be read from.
 *
 * `refused` rather than `failed`: the operation is well-formed and the tracker could do it — this
 * layer declined. A caller that sees `failed` might reasonably retry; nothing about retrying a
 * refusal will help, and the distinction is already load-bearing everywhere else in the pipeline.
 */
export function readOnlyTracker(inner: TrackerAdapter): TrackerAdapter {
  return {
    name: `${inner.name}:read-only`,
    capabilities: inner.capabilities,
    getTask: (id) => inner.getTask(id),
    getComments: (id, limit) => inner.getComments(id, limit),
    listTasks: (opts) => inner.listTasks(opts),
    renderSnapshot: (tasks) => inner.renderSnapshot(tasks),
    async apply(op): Promise<OpOutcome> {
      return {
        status: 'refused',
        detail: `read-only: "${op.kind}" is not available to this pass — writes happen in Pass 2c, from a checked plan, never from a model turn`,
      };
    },
  };
}

export const READ_ONLY_TOOLS: ToolSpec[] = [
  {
    name: 'get_task',
    description: 'Fetch one board task by id. Use to check what an existing card actually covers.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The board id, e.g. t100' } },
      required: ['task_id'],
    },
  },
  {
    name: 'get_task_comments',
    description:
      "Fetch a task's comment and activity history — the evidence for whether work is already tracked or already done.",
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        limit: { type: 'number', description: 'Most recent N comments. Default 20.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'search_tasks',
    description:
      'Find open tasks whose title contains the given text. Use when a card might exist under different wording.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

export interface ToolLoopOptions {
  model: ModelClient;
  /** Wrapped in `readOnlyTracker` internally — passing a writable adapter is safe. */
  tracker: TrackerAdapter;
  maxIterations?: number;
  onEvent?: (e: { kind: 'tool'; name: string; args: Record<string, unknown> } | { kind: 'cap-hit'; iterations: number }) => void;
}

/**
 * Build a runner with the same `(prompt, label) => Promise<string>` shape the passes already inject,
 * so nothing downstream knows or cares whether tools were used.
 */
export function makeToolLoopRunner(opts: ToolLoopOptions): (prompt: string, label: string) => Promise<string> {
  const tracker = readOnlyTracker(opts.tracker);
  const maxIterations = opts.maxIterations ?? TOOL_LOOP_MAX_ITERATIONS;

  return async function run(prompt: string, label: string): Promise<string> {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    for (let i = 0; i < maxIterations; i++) {
      const res = await opts.model.complete({
        key: label,
        messages,
        determinism: 'strict',
        tools: READ_ONLY_TOOLS,
      });

      if (!res.toolCalls?.length) return res.text;

      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

      for (const call of res.toolCalls) {
        opts.onEvent?.({ kind: 'tool', name: call.name, args: call.arguments });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: await dispatch(tracker, call.name, call.arguments),
        });
      }
    }

    opts.onEvent?.({ kind: 'cap-hit', iterations: maxIterations });

    // Ask once, plainly, for the answer. A loop that just gives up returns an empty string, which
    // every parser downstream reads as "this pass found nothing" — indistinguishable from a real
    // empty result, and the reason the cap needs an exit that still produces output.
    const final = await opts.model.complete({
      key: `${label}:final`,
      messages: [...messages, { role: 'user', content: 'Stop using tools. Answer now, in the required output format, using what you already have.' }],
      determinism: 'strict',
    });
    return final.text;
  };
}

async function dispatch(
  tracker: TrackerAdapter,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case 'get_task': {
        const task = await tracker.getTask(String(args.task_id ?? ''));
        return task ? JSON.stringify(task) : `no task with id "${String(args.task_id ?? '')}"`;
      }

      case 'get_task_comments': {
        const limit = Number(args.limit) || 20;
        const comments = await tracker.getComments(String(args.task_id ?? ''), limit);
        if (comments.length === 0) return 'no comments on that task';
        // Comment bodies are written by other people and may contain anything. They get the same
        // screening as the host-side evidence block: framed as data, never as instructions. A tool
        // result is the easiest place to forget that, because it feels like the system's own output.
        return screenExternalPromptText(
          comments.map((c) => `[${c.createdAt}] ${c.author}: ${c.body}`).join('\n'),
          'task-comments'
        ).text;
      }

      case 'search_tasks': {
        const q = String(args.query ?? '').toLowerCase();
        if (!q) return 'search_tasks needs a non-empty query';
        const hits = (await tracker.listTasks()).filter((t) => t.title.toLowerCase().includes(q)).slice(0, 10);
        return hits.length ? JSON.stringify(hits) : `no open task title contains "${q}"`;
      }

      default:
        // Naming what IS available turns a hallucinated tool into a corrected next turn rather than
        // a dead end the model tries to work around.
        return `no tool named "${name}". Available: ${READ_ONLY_TOOLS.map((t) => t.name).join(', ')}`;
    }
  } catch (err) {
    return `tool "${name}" failed: ${(err as Error)?.message ?? String(err)}`;
  }
}
