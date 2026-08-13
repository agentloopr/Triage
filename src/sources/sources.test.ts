/**
 * The source clients' contract suite, run against hand-written fakes.
 *
 * **What this proves and what it does not.** Same standard as the tracker adapters, and the same
 * limitation, stated here so nobody has to infer it: these tests prove each client's own logic —
 * pagination, field mapping, the credential check, error classification, and the two vendor quirks
 * below that are silent failures rather than errors. They cannot prove an endpoint path, a field
 * name or an auth header, because the fake was written from the same reading of the docs as the
 * client it tests. Only a live call settles those, and none has been made.
 *
 * The cases worth having are the ones where a *wrong* implementation still returns data:
 *   • GitHub's issues endpoint returns pull requests too, distinguishable only by a `pull_request`
 *     key. Get it wrong and every PR is silently mislabelled an issue.
 *   • Gmail bodies are base64**url** and often nested inside a multipart tree. Get either wrong and
 *     you get mojibake or an empty string — never an exception.
 *   • Drive v3 returns a minimal projection unless `fields` is sent, so a client that omits it gets
 *     comments with no author, no content and no timestamp, and a 200 to go with them.
 */
import { describe, expect, it } from 'vitest';
import { makeDriveClient } from './drive';
import { decodeBody, firstTextPart, makeGmailClient } from './gmail';
import { makeGithubClient } from './github';
import type { FetchImpl } from './index';

/** A fake `fetch` that answers from a path→payload table and records what was asked for. */
function fakeFetch(routes: Array<[RegExp, unknown]>): { impl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string | URL): Promise<Response> => {
    const href = String(url);
    calls.push(href);
    const hit = routes.find(([re]) => re.test(href));
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as FetchImpl;
  return { impl, calls };
}

const NO_ROUTES = fakeFetch([]).impl;

describe('every client refuses to construct without its credential', () => {
  // A 401 from a missing token is indistinguishable from a 401 from a wrong one, and the two have
  // completely different fixes. Failing at construction names which it is.
  it('github', () => {
    expect(() => makeGithubClient({ token: '', fetchImpl: NO_ROUTES })).toThrow(/GITHUB_TOKEN/);
  });
  it('gmail', () => {
    expect(() => makeGmailClient({ token: '', fetchImpl: NO_ROUTES })).toThrow(/GOOGLE_ACCESS_TOKEN/);
  });
  it('drive', () => {
    expect(() => makeDriveClient({ token: '', fetchImpl: NO_ROUTES })).toThrow(/GOOGLE_ACCESS_TOKEN/);
  });
});

describe('github', () => {
  const issues = [
    {
      number: 412,
      title: 'Add export endpoint',
      state: 'closed',
      user: { login: 'avery' },
      created_at: '2026-08-13T08:00:00Z',
      updated_at: '2026-08-13T09:10:00Z',
      body: 'Closes the export gap.',
      pull_request: { merged_at: '2026-08-13T09:10:00Z' },
    },
    {
      number: 77,
      title: 'Pagination is off by one',
      state: 'open',
      user: { login: 'rowan' },
      created_at: '2026-08-13T08:30:00Z',
      updated_at: '2026-08-13T08:30:00Z',
    },
  ];
  const commits = [
    {
      sha: 'abc1234def',
      commit: { message: 'Fix pagination\n\nLong body nobody wants as a title.', author: { name: 'Rowan Diaz', date: '2026-08-13T08:45:00Z' } },
      author: { login: 'rowan' },
    },
  ];

  it('tells a pull request from an issue by the pull_request key, not by guessing', async () => {
    const { impl } = fakeFetch([[/\/issues\?/, issues], [/\/commits\?/, commits]]);
    const out = await makeGithubClient({ token: 't', fetchImpl: impl }).fetch({ repo: 'acme/api' });

    expect(out.events.find((e) => e.number === 412)?.kind).toBe('pull_request');
    expect(out.events.find((e) => e.number === 77)?.kind).toBe('issue');
  });

  it('reports merged rather than closed for a merged PR', async () => {
    // Both are `state: closed` on the wire. A PR that was closed unmerged is a different event from
    // one that shipped, and collapsing them would tell the pipeline work landed when it did not.
    const { impl } = fakeFetch([[/\/issues\?/, issues], [/\/commits\?/, commits]]);
    const out = await makeGithubClient({ token: 't', fetchImpl: impl }).fetch({ repo: 'acme/api' });
    expect(out.events.find((e) => e.number === 412)?.action).toBe('merged');
  });

  it('takes only the first line of a commit message as the title', async () => {
    const { impl } = fakeFetch([[/\/issues\?/, []], [/\/commits\?/, commits]]);
    const out = await makeGithubClient({ token: 't', fetchImpl: impl }).fetch({ repo: 'acme/api' });
    expect(out.events[0]?.title).toBe('Fix pagination');
  });

  it('sorts every event into one chronological stream', async () => {
    const { impl } = fakeFetch([[/\/issues\?/, issues], [/\/commits\?/, commits]]);
    const out = await makeGithubClient({ token: 't', fetchImpl: impl }).fetch({ repo: 'acme/api' });
    expect(out.events.map((e) => e.at)).toEqual([...out.events.map((e) => e.at)].sort());
  });

  it('stops paging on a short read instead of walking to the cap', async () => {
    const { impl, calls } = fakeFetch([[/\/issues\?/, issues], [/\/commits\?/, commits]]);
    await makeGithubClient({ token: 't', fetchImpl: impl }).fetch({ repo: 'acme/api', maxPages: 10 });
    // Two short pages, so exactly one request each — not ten.
    expect(calls.filter((c) => c.includes('/issues?'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('/commits?'))).toHaveLength(1);
  });

  it('passes `since` through to the server rather than filtering after the fact', async () => {
    const { impl, calls } = fakeFetch([[/\/issues\?/, []], [/\/commits\?/, []]]);
    await makeGithubClient({ token: 't', fetchImpl: impl }).fetch({ repo: 'acme/api', since: '2026-08-13T00:00:00Z' });
    expect(calls.every((c) => c.includes('since='))).toBe(true);
  });
});

describe('gmail', () => {
  it('decodes base64url, not base64', () => {
    // An ordinary sentence is enough to hit the difference — `>` puts a `-` in the base64url form
    // and a `+` in the base64 one.
    const text = 'Ship the export endpoint >> today?';
    const encoded = Buffer.from(text, 'utf8').toString('base64url');
    expect(encoded).toMatch(/[-_]/);
    expect(decodeBody(encoded)).toBe(text);

    // Node's own base64 decoder happens to accept the base64url alphabet as well, so on this
    // runtime the wrong encoding name is survivable. Asserting that here rather than asserting
    // corruption, because the first version of this test claimed corruption and was simply wrong.
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(text);
  });

  it('walks a multipart tree for the first text/plain part', () => {
    const body = Buffer.from('the actual text', 'utf8').toString('base64url');
    expect(
      firstTextPart({
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'application/pdf', body: { data: 'x' } },
          { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: body } }] },
        ],
      })
    ).toBe('the actual text');
  });

  it('returns empty for an HTML-only message rather than shipping markup', () => {
    // A bad extraction that reaches Pass 1 is worse than an absent one: the grounding rule then
    // binds the inventory to tag soup.
    expect(firstTextPart({ mimeType: 'text/html', body: { data: 'PGI+aGk8L2I+' } })).toBe('');
  });

  it('maps a thread, preferring internalDate over the sender-supplied Date header', async () => {
    const { impl } = fakeFetch([
      [
        /threads\//,
        {
          id: 't-1',
          messages: [
            {
              id: 'm-1',
              internalDate: '1786000000000',
              payload: {
                headers: [
                  { name: 'From', value: 'Avery Chen <avery@example.com>' },
                  { name: 'Subject', value: 'Export endpoint' },
                  { name: 'Date', value: 'nonsense' },
                ],
                mimeType: 'text/plain',
                body: { data: Buffer.from('Shipping today.', 'utf8').toString('base64url') },
              },
            },
          ],
        },
      ],
    ]);

    const out = await makeGmailClient({ token: 't', fetchImpl: impl }).fetch({ threadId: 't-1' });
    expect(out.subject).toBe('Export endpoint');
    expect(out.messages[0]?.body).toBe('Shipping today.');
    expect(out.messages[0]?.at).toBe(new Date(1786000000000).toISOString());
  });
});

describe('drive', () => {
  const routes: Array<[RegExp, unknown]> = [
    [/\/files\/[^/?]+\?fields=name/, { name: 'API spec' }],
    [
      /\/comments/,
      {
        comments: [
          {
            author: { displayName: 'Rowan Diaz' },
            createdTime: '2026-08-13T09:20:00Z',
            content: 'Export section needs a rate limit.',
            resolved: false,
            replies: [{ author: { displayName: 'Avery Chen' }, createdTime: '2026-08-13T09:25:00Z', content: 'Agreed.' }],
          },
          {
            author: { displayName: 'Jules Kim' },
            createdTime: '2026-08-13T07:00:00Z',
            content: 'Already handled.',
            resolved: true,
          },
        ],
      },
    ],
    [/\/revisions/, { revisions: [{ modifiedTime: '2026-08-13T09:30:00Z', lastModifyingUser: { displayName: 'Rowan Diaz' } }] }],
  ];

  it('always sends a fields projection — without it Drive returns empty comments and a 200', async () => {
    const { impl, calls } = fakeFetch(routes);
    await makeDriveClient({ token: 't', fetchImpl: impl }).fetch({ fileId: 'f-1' });
    expect(calls.find((c) => c.includes('/comments'))).toContain('fields=');
    expect(calls.find((c) => c.includes('/revisions'))).toContain('fields=');
  });

  it('drops resolved comments', async () => {
    const { impl } = fakeFetch(routes);
    const out = await makeDriveClient({ token: 't', fetchImpl: impl }).fetch({ fileId: 'f-1' });
    expect(out.events.map((e) => e.text ?? '')).not.toContain('Already handled.');
  });

  it('flattens replies into their own events', async () => {
    const { impl } = fakeFetch(routes);
    const out = await makeDriveClient({ token: 't', fetchImpl: impl }).fetch({ fileId: 'f-1' });
    expect(out.events.find((e) => e.text === 'Agreed.')?.author).toBe('Avery Chen');
  });

  it('applies the time window client-side, because Drive filters neither resource', async () => {
    const { impl } = fakeFetch(routes);
    const out = await makeDriveClient({ token: 't', fetchImpl: impl }).fetch({
      fileId: 'f-1',
      since: '2026-08-13T09:22:00Z',
    });
    expect(out.events.map((e) => e.at)).toEqual(['2026-08-13T09:25:00Z', '2026-08-13T09:30:00Z']);
  });

  it('carries the real file name through, not the id', async () => {
    const { impl } = fakeFetch(routes);
    const out = await makeDriveClient({ token: 't', fetchImpl: impl }).fetch({ fileId: 'f-1' });
    expect(out.fileName).toBe('API spec');
  });
});
