import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  handleWebhookRequest,
  requireWebhookSecret,
  verifyGithubSignature,
  verifySlackSignature,
  type WebhookRequest,
} from './webhook';

const GITHUB_SECRET = 'gh-secret';
const SLACK_SECRET = 'slack-secret';

const githubSig = (body: string, secret = GITHUB_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const slackSig = (body: string, ts: string, secret = SLACK_SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;

const req = (over: Partial<WebhookRequest>): WebhookRequest => ({
  method: 'GET',
  path: '/',
  headers: {},
  rawBody: Buffer.alloc(0),
  ...over,
});

describe('verifyGithubSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = '{"ok":true}';
    expect(verifyGithubSignature(Buffer.from(body), githubSig(body), GITHUB_SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = '{"ok":true}';
    expect(verifyGithubSignature(Buffer.from(body), githubSig(body, 'wrong'), GITHUB_SECRET)).toBe(false);
  });

  it('rejects a missing header rather than throwing', () => {
    expect(verifyGithubSignature(Buffer.from('x'), undefined, GITHUB_SECRET)).toBe(false);
  });

  // A signature over re-serialized JSON is a different string than one over the wire bytes —
  // this is what makes the raw-body-before-parse rule load-bearing rather than stylistic.
  it('a signature computed over a re-serialized body does not verify against the original bytes', () => {
    const original = '{"a":1,  "b":2}'; // deliberately not what JSON.stringify would produce
    const reserialized = JSON.stringify(JSON.parse(original));
    expect(verifyGithubSignature(Buffer.from(original), githubSig(reserialized), GITHUB_SECRET)).toBe(false);
  });
});

describe('verifySlackSignature', () => {
  const NOW = 1_786_000_000_000;
  const ts = String(Math.floor(NOW / 1_000));

  it('accepts a correctly signed, fresh request', () => {
    const body = '{"ok":true}';
    expect(verifySlackSignature(Buffer.from(body), ts, slackSig(body, ts), SLACK_SECRET, NOW)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = '{"ok":true}';
    expect(verifySlackSignature(Buffer.from(body), ts, slackSig(body, ts, 'wrong'), SLACK_SECRET, NOW)).toBe(false);
  });

  it('rejects a stale timestamp even with a mathematically valid signature — the replay guard', () => {
    const body = '{"ok":true}';
    const staleTs = String(Math.floor(NOW / 1_000) - 600); // 10 minutes old, outside the 5-minute window
    expect(verifySlackSignature(Buffer.from(body), staleTs, slackSig(body, staleTs), SLACK_SECRET, NOW)).toBe(false);
  });

  it('rejects a missing timestamp or signature header rather than throwing', () => {
    expect(verifySlackSignature(Buffer.from('x'), undefined, 'v0=whatever', SLACK_SECRET, NOW)).toBe(false);
    expect(verifySlackSignature(Buffer.from('x'), ts, undefined, SLACK_SECRET, NOW)).toBe(false);
  });
});

describe('requireWebhookSecret', () => {
  it('throws, naming the missing env var, rather than starting unsigned', () => {
    expect(() => requireWebhookSecret('', 'GITHUB_WEBHOOK_SECRET')).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });
  it('passes the secret through when set', () => {
    expect(requireWebhookSecret('s', 'GITHUB_WEBHOOK_SECRET')).toBe('s');
  });
});

describe('handleWebhookRequest — the route table', () => {
  const onGithub = vi.fn(async () => {});
  const onSlack = vi.fn(async () => {});
  const config = { githubSecret: GITHUB_SECRET, slackSigningSecret: SLACK_SECRET, onGithub, onSlack };

  it('answers GET /healthz with no signature required', async () => {
    const { response } = await handleWebhookRequest(req({ method: 'GET', path: '/healthz' }), config);
    expect(response).toEqual({ status: 200, body: 'ok' });
  });

  it('404s exactly one route beyond the three — the closed table §9 depends on', async () => {
    const { response } = await handleWebhookRequest(req({ method: 'GET', path: '/debug/clarify-test' }), config);
    expect(response.status).toBe(404);
  });

  it('404s the right paths under the wrong method too', async () => {
    expect((await handleWebhookRequest(req({ method: 'GET', path: '/hooks/github' }), config)).response.status).toBe(404);
    expect((await handleWebhookRequest(req({ method: 'POST', path: '/healthz' }), config)).response.status).toBe(404);
  });

  it('rejects a POST /hooks/github with a bad signature', async () => {
    const body = Buffer.from('{}');
    const { response } = await handleWebhookRequest(
      req({ method: 'POST', path: '/hooks/github', rawBody: body, headers: { 'x-hub-signature-256': 'sha256=nope' } }),
      config
    );
    expect(response.status).toBe(401);
    expect(onGithub).not.toHaveBeenCalled();
  });

  it('acks a verified github delivery immediately and runs the handler in the background', async () => {
    onGithub.mockClear();
    const body = JSON.stringify({ repository: { full_name: 'acme/api' } });
    const { response, done } = await handleWebhookRequest(
      req({
        method: 'POST',
        path: '/hooks/github',
        rawBody: Buffer.from(body),
        headers: { 'x-hub-signature-256': githubSig(body), 'x-github-delivery': 'd-1' },
      }),
      config
    );
    expect(response).toEqual({ status: 202, body: 'accepted' });
    await done;
    expect(onGithub).toHaveBeenCalledWith({ repository: { full_name: 'acme/api' } }, 'd-1');
  });

  it('logs, rather than throws back to the caller, when the background handler rejects', async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = '{}';
    const { response, done } = await handleWebhookRequest(
      req({ method: 'POST', path: '/hooks/github', rawBody: Buffer.from(body), headers: { 'x-hub-signature-256': githubSig(body) } }),
      { ...config, onGithub: failing }
    );
    expect(response.status).toBe(202); // the ack already happened
    await done;
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    errSpy.mockRestore();
  });

  it('rejects a POST /hooks/slack with a bad or stale signature', async () => {
    const body = '{}';
    const { response } = await handleWebhookRequest(
      req({ method: 'POST', path: '/hooks/slack', rawBody: Buffer.from(body), headers: { 'x-slack-request-timestamp': '1', 'x-slack-signature': 'v0=nope' } }),
      config
    );
    expect(response.status).toBe(401);
    expect(onSlack).not.toHaveBeenCalled();
  });

  it('answers Slack url_verification with the challenge, signed like any other request', async () => {
    const ts = String(Math.floor(Date.now() / 1_000));
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const { response } = await handleWebhookRequest(
      req({
        method: 'POST',
        path: '/hooks/slack',
        rawBody: Buffer.from(body),
        headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSig(body, ts) },
      }),
      config
    );
    expect(response).toEqual({ status: 200, body: JSON.stringify({ challenge: 'abc123' }) });
    expect(onSlack).not.toHaveBeenCalled();
  });

  it('acks a verified, non-challenge slack event and runs the handler in the background', async () => {
    onSlack.mockClear();
    const ts = String(Math.floor(Date.now() / 1_000));
    const body = JSON.stringify({ event: { channel: 'C1' } });
    const { response, done } = await handleWebhookRequest(
      req({
        method: 'POST',
        path: '/hooks/slack',
        rawBody: Buffer.from(body),
        headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSig(body, ts) },
      }),
      config
    );
    expect(response).toEqual({ status: 202, body: 'accepted' });
    await done;
    expect(onSlack).toHaveBeenCalledWith({ event: { channel: 'C1' } });
  });
});
