/**
 * Shared scenario runner for the demo and the recorder.
 *
 * The two CLIs differ in exactly one thing — which `ModelClient` they hand over — so everything else
 * lives here. That is also what makes the demo trustworthy: it is not a special "demo mode" through
 * a simplified path, it is the real pipeline with a different provider behind the same seam.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonFileStore } from '../idempotency/jsonFile';
import { memoryStore } from '../idempotency/memory';
import { type Scenario, diffExpected } from '../fixtures';
import { traceEvents, traceModelClient } from '../observability/otel';
import { PipelineEvents, type PipelineEvent } from '../pipeline/events';
import { setTaskUrlBuilder } from '../pipeline/gates/clarify';
import { type PipelineResult, runPipeline } from '../pipeline/run';
import type { ModelClient } from '../providers';
import { setOpsRegistryPath } from '../registry/opsRegistry';
import { setCorrectionsPath } from '../state/corrections';
import { fileRoleStateStore, setRoleStateDir } from '../state/roleState';
import { delegateToRoleAgents } from '../agents/boardAgent';
import { AGENT_MAX_DELEGATIONS } from '../config';
import { memoryTracker } from '../trackers/memory';
import { categoryBreakdown } from '../pipeline/parsing/categorizationManifest';

export type RunScenarioOptions = {
  model: ModelClient;
  /** Persisted across runs when set — this is how `--twice` proves idempotency. */
  idempotencyPath?: string;
  quiet?: boolean;
  /** Run the agent layer (PRD §5). Off by default — see AGENTS_ENABLED in config. */
  agents?: boolean;
};

export type ScenarioRun = {
  result: PipelineResult;
  events: PipelineEvent[];
  mismatches: string[];
  modelCalls: number;
};

export async function runScenario(scenario: Scenario, opts: RunScenarioOptions): Promise<ScenarioRun> {
  setOpsRegistryPath(scenario.registryPath);
  setCorrectionsPath(scenario.correctionsPath ?? `${scenario.dir}/.corrections.json`);

  // Role state gets a FRESH directory per invocation, not a fixed one under the scenario.
  //
  // Two reasons, and the second is the one that bites. First: the pipeline writes role state after
  // every execute and that state enters the next run's prompt, so a fixture whose prompt depends on
  // how many times you have run it is not a fixture. Second: a path derived from the scenario is
  // shared mutable state between every runner using that scenario, and the test files run
  // concurrently — one resetting the directory while another builds a prompt from it produces a
  // prompt that differs run to run, which surfaces as cassette-drift warnings on recordings nobody
  // has touched. A unique directory has no such race by construction.
  const roleStateDir = mkdtempSync(join(tmpdir(), 'scenario-role-state-'));
  setRoleStateDir(roleStateDir);

  setTaskUrlBuilder((id) => `card ${id}`);

  const events: PipelineEvent[] = [];
  const emitter = new PipelineEvents();
  emitter.on((e) => {
    events.push(e);
    if (!opts.quiet) print(e);
  });

  // Wired unconditionally, with no flag and no endpoint check. `@opentelemetry/api` hands back
  // non-recording spans until the host application registers a provider, so this costs an allocation
  // per call and emits nothing — which is why the demo still runs offline with no configuration.
  // The alternative, gating it on an env var, means the instrumentation is only ever exercised by
  // people who already turned it on, and the first person to do that discovers whether it works.
  const untrace = traceEvents(emitter);
  const model = traceModelClient(opts.model);

  let modelCalls = 0;
  // `system` carries the half of the prompt that is identical for every item in a run. Passing it
  // through as a real system block is what lets the Anthropic adapter's cache breakpoint fire — it
  // has always set one, and the pipeline had never given it anything to sit on.
  const complete = async (key: string, prompt: string, system?: string): Promise<string> => {
    modelCalls++;
    const r = await model.complete({
      key,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      determinism: 'strict',
    });
    if (r.truncated) throw new Error(`[${key}] reply was truncated`);
    return r.text;
  };

  const tracker = memoryTracker({ tasks: scenario.board });

  const result = await runPipeline(scenario.source, {
    tracker,
    idempotency: opts.idempotencyPath ? jsonFileStore(opts.idempotencyPath) : memoryStore(),
    roleState: fileRoleStateStore(roleStateDir),
    // Same `model` and `tracker` the pipeline uses, so the agent path is the real thing behind the
    // same seams rather than a parallel implementation that could drift from it.
    ...(opts.agents
      ? {
          agents: {
            delegate: (items) =>
              delegateToRoleAgents(items, {
                model,
                tracker,
                maxDelegations: AGENT_MAX_DELEGATIONS,
                onDelegate: (d) => emitter.emit({ type: 'agent:delegate', ...d }),
                onEvent: (e) => {
                  if (e.kind === 'tool') emitter.emit({ type: 'agent:tool', name: e.name, args: e.args });
                  else emitter.emit({ type: 'alert', detail: `role agent hit its ${e.iterations}-turn cap` });
                },
              }),
          },
        }
      : {}),
    events: emitter,
    runPass: async ({ prompt, label }) => ({ text: await complete(passKey(label), prompt) }),
    runCategorization: (prompt, label, system) => complete(`2a/${itemKey(label)}`, prompt, system),
    runContractCheck: (prompt, label, system) => complete(`2b/${itemKey(label)}`, prompt, system),
    warmDelayMs: 0,
  });

  const mismatches =
    result.status === 'skipped'
      ? []
      : diffExpected(scenario.expected, {
          inventoryCount: result.inventory.length,
          categories: categoryBreakdown(result.manifest),
          cleanCount: result.clean.length,
          heldCount: result.held.length,
          skippedNotTaskCount: result.skippedNotTask.length,
          createdCount: result.exec?.created ?? 0,
          heldGates: result.held.map((h) => h.gate),
        });

  untrace();
  setOpsRegistryPath(null);
  setCorrectionsPath(null);
  setRoleStateDir(null);
  rmSync(roleStateDir, { recursive: true, force: true });
  setTaskUrlBuilder(null);

  return { result, events, mismatches, modelCalls };
}

/** `pass1.5:critic` → `1.5-critic`, so a cassette file is named after the pass a reader recognises. */
function passKey(label: string): string {
  const [pass, name] = label.split(':');
  return `${pass?.replace(/^pass/, '') ?? '?'}-${name ?? 'main'}`;
}

/** `pass2a:item7` → `item-07`. Zero-padded so the files sort in item order. */
function itemKey(label: string): string {
  const n = label.match(/item(\d+)/)?.[1];
  return n ? `item-${n.padStart(2, '0')}` : label.replace(/[^a-z0-9-]/gi, '-');
}

function print(e: PipelineEvent): void {
  switch (e.type) {
    case 'pass:done':
      console.log(`  ✓ ${e.pass.padEnd(20)} ${e.ms}ms`);
      break;
    case 'skipped':
      console.log(`  ⏭ skipped at layer '${e.layer}' — ${e.reason}`);
      break;
    case 'items:uncategorized':
      console.log(`  ⚠ ${e.items.length} item(s) could not be categorized: ${e.items.map((i) => `#${i.number}`).join(', ')}`);
      break;
    case 'items:held':
      console.log(`  ⏸ ${e.items.length} held for a human:`);
      for (const i of e.items) console.log(`      #${i.item} [${i.gate}] ${i.title}`);
      break;
    case 'items:skipped-not-task':
      for (const i of e.items) console.log(`  ⏭ #${i.item} skipped — not a task: ${i.title}`);
      break;
    case 'flags':
      for (const f of e.flags) console.log(`  ⚑ ${f.kind}: ${f.note}`);
      break;
    case 'executed':
      console.log(`  → ${e.created} created · ${e.commented} commented · ${e.skipped} skipped · ${e.failed} failed`);
      break;
    case 'audit':
      console.log(`  ✓ audit: ${e.passed} passed, ${e.mismatched} mismatched`);
      if (e.report) console.log(e.report);
      break;
    case 'agent:delegate':
      console.log(`  🤖 #${e.item} → ${e.role} agent (${e.owner})`);
      break;
    case 'agent:tool':
      console.log(`     ↳ ${e.name}(${JSON.stringify(e.args)})`);
      break;
    case 'agent:summary':
      for (const line of e.summary.split('\n')) console.log(`  ▪ ${line}`);
      break;
    case 'alert':
      console.log(`  ⚠ ${e.detail}`);
      break;
  }
}
