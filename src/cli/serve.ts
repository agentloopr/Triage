/**
 * `npm run serve` — the webhook receiver: verify, ack, then re-pull and run the pipeline.
 *
 * **What this deliberately does NOT do: parse the webhook payload as the source of truth.** GitHub's
 * and Slack's event payloads are shapes this repo has never made a live call against — the exact risk
 * `sources.test.ts`'s own header names ("a fake proves the client's logic, not an endpoint shape").
 * Building a second, webhook-payload parser on top of that same unverified reading of the docs would
 * repeat it for a *less* tested shape. Instead, a verified delivery is a TRIGGER: it names a repo or
 * a channel, and the handler re-pulls that target through the already-tested `SourceClient` (the
 * same one `npm run pull` and `npm run poll` use) with a short lookback window. The `source` and
 * `content` idempotency layers `runPipeline` already runs make the re-pull's overlap with whatever
 * the last poll saw free, not wasted work.
 *
 * **What is NOT here, and is real infrastructure work if you deploy this**: TLS termination (put this
 * behind a reverse proxy — it speaks plain HTTP), process supervision and restart-on-crash, queue
 * durability if the process dies mid-delivery (there is no persisted inbox, only the ack), and
 * horizontal scale (multiple instances would each re-verify and re-pull independently, which is safe
 * but redundant). This is a reference wiring of the signature verification in `transport/webhook.ts`,
 * not a production ingress.
 *
 *   GITHUB_WEBHOOK_SECRET=... SLACK_SIGNING_SECRET=... npm run serve
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { delegateToRoleAgents } from '../agents/boardAgent';
import {
  AGENT_MAX_DELEGATIONS,
  GITHUB_WEBHOOK_SECRET,
  MODEL_PROVIDER,
  RETRIEVAL_DIR,
  SERVE_PORT,
  SLACK_SIGNING_SECRET,
} from '../config';
import { buildLiveDeps } from './liveDeps';
import { PipelineEvents } from '../pipeline/events';
import { localRetriever } from '../pipeline/retrieval/local';
import { runPipeline } from '../pipeline/run';
import { makeModelClient, type ProviderName } from '../providers/factory';
import { readSource, type SourceTarget } from './readSource';
import { makeTracker } from '../trackers/factory';
import { printEvent } from './runScenario';
import { handleWebhookRequest, requireWebhookSecret, type WebhookRequest } from '../transport/webhook';

/** How far back a triggered re-pull looks — generous on purpose; the idempotency layers absorb the overlap. */
const LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const sinceNow = () => new Date(Date.now() - LOOKBACK_MS).toISOString();

async function runTriggeredTarget(target: SourceTarget, deliveryId: string | undefined): Promise<void> {
  const provider = MODEL_PROVIDER as ProviderName;
  if (provider === 'cassette') {
    console.error('[serve] MODEL_PROVIDER is "cassette" — set it to deepseek or anthropic to actually process a delivery.');
    return;
  }

  const ingested = await readSource(target);
  // Tags the re-pulled batch with the webhook's OWN delivery id, so a redelivered webhook (GitHub
  // retries on a slow ack) short-circuits at layer 1 rather than re-running layers 2/3 for nothing.
  // Two DIFFERENT deliveries whose re-pulled windows overlap still dedup correctly, just one layer
  // down — the `source`/`content` layers below don't care which delivery triggered the pull.
  if (deliveryId) ingested.eventId = deliveryId;
  if (!ingested.text.trim()) {
    console.log(`[serve] ${target.source} trigger produced nothing in the lookback window — no model calls made.`);
    return;
  }

  const emitter = new PipelineEvents();
  emitter.on(printEvent);
  const tracker = makeTracker();
  const { model, deps: liveDeps } = buildLiveDeps({ tracker, model: makeModelClient({ provider }), events: emitter, write: true });
  const complete = async (key: string, prompt: string, system?: string): Promise<string> => {
    const r = await model.complete({ key, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }], determinism: 'strict' });
    if (r.truncated) throw new Error('reply was truncated');
    return r.text;
  };

  const result = await runPipeline(ingested, {
    ...liveDeps,
    runPass: async ({ prompt, label }) => ({ text: await complete(label, prompt) }),
    runCategorization: (prompt, label, system) => complete(`2a/${label}`, prompt, system),
    runContractCheck: (prompt, label, system) => complete(`2b/${label}`, prompt, system),
    runDisputeArbiter: (prompt, label) => complete(`arb/${label}`, prompt),
    ...(RETRIEVAL_DIR ? { retrieval: localRetriever(RETRIEVAL_DIR) } : {}),
    ...(process.env.AGENTS_ENABLED === 'true'
      ? { agents: { delegate: (items) => delegateToRoleAgents(items, { model, tracker, maxDelegations: AGENT_MAX_DELEGATIONS, onDelegate: (d) => emitter.emit({ type: 'agent:delegate', ...d }) }) } }
      : {}),
  });

  console.log(`[serve] ${target.source} → ${result.exec?.created ?? 0} created · ${result.exec?.commented ?? 0} commented · ${result.held.length} held`);
}

async function onGithub(payload: unknown, deliveryId: string | undefined): Promise<void> {
  const repo = (payload as { repository?: { full_name?: string } }).repository?.full_name;
  if (!repo) {
    console.log('[serve] github delivery carried no repository.full_name — nothing to re-pull (likely a ping).');
    return;
  }
  await runTriggeredTarget({ source: 'github', repo, since: sinceNow() }, deliveryId);
}

async function onSlack(payload: unknown): Promise<void> {
  const channel = (payload as { event?: { channel?: string } }).event?.channel;
  if (!channel) {
    console.log('[serve] slack event carried no event.channel — nothing to re-pull.');
    return;
  }
  await runTriggeredTarget({ source: 'slack', channel, since: sinceNow() }, undefined);
}

function readRawBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function headerString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function main(): Promise<void> {
  const githubSecret = requireWebhookSecret(GITHUB_WEBHOOK_SECRET, 'GITHUB_WEBHOOK_SECRET');
  const slackSigningSecret = requireWebhookSecret(SLACK_SIGNING_SECRET, 'SLACK_SIGNING_SECRET');

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      res.writeHead(400).end(`bad request: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const webhookReq: WebhookRequest = {
      method: req.method ?? 'GET',
      path: (req.url ?? '/').split('?')[0]!,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, headerString(v)])),
      rawBody,
    };

    const { response, done } = await handleWebhookRequest(webhookReq, { githubSecret, slackSigningSecret, onGithub, onSlack });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(response.body);
    // Ack already sent — the background handler's own errors are logged inside handleWebhookRequest.
    void done;
  });

  server.listen(SERVE_PORT, () => {
    console.log(`[serve] listening on :${SERVE_PORT} — POST /hooks/github, POST /hooks/slack, GET /healthz`);
  });
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
