/**
 * The typed client, against a stubbed transport.
 *
 * These assert the behaviours that exist to stop an integrator making the mistakes that matter
 * here — not that `fetch` was called.
 */

import { describe, expect, it, vi } from 'vitest';

import { AdverseSearchClient, AdverseSearchError } from '../src/index.js';

function stub(responses: { status: number; body: unknown }[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = ((url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(next?.body ?? null), {
        status: next?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function clientWith(responses: { status: number; body: unknown }[]): {
  client: AdverseSearchClient;
  calls: { url: string; init: RequestInit }[];
} {
  const { fetchImpl, calls } = stub(responses);
  return {
    client: new AdverseSearchClient({
      baseUrl: 'https://adverse.example.com/',
      apiKey: 'erly_sandbox_abc_secret',
      fetchImpl,
    }),
    calls,
  };
}

const QUEUED = { searchId: 's1', execution: 'QUEUED', findings: 'NOT_EVALUATED' };
const DONE = { searchId: 's1', execution: 'SUCCEEDED', findings: 'POTENTIAL_MATCHES' };

describe('authentication and addressing', () => {
  it('sends the API key on every request and trims a trailing slash', async () => {
    const { client, calls } = clientWith([{ status: 200, body: DONE }]);
    await client.getSearch('s1');

    expect(calls[0]?.url).toBe('https://adverse.example.com/v1/searches/s1');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('ApiKey erly_sandbox_abc_secret');
  });

  it('encodes a search id rather than interpolating it raw', async () => {
    const { client, calls } = clientWith([{ status: 200, body: DONE }]);
    await client.getSearch('a/../b');
    expect(calls[0]?.url).toContain('a%2F..%2Fb');
  });
});

describe('submitting a search', () => {
  it('always sends an idempotency key, even when the caller forgets', async () => {
    // A retry after a timeout otherwise creates a second run: the service cannot tell a retry
    // from a fresh request unless the caller says so.
    const { client, calls } = clientWith([{ status: 202, body: { searchId: 's1' } }]);
    await client.createSearch({} as never);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(/\S/);
  });

  it('uses the caller’s key when given one', async () => {
    const { client, calls } = clientWith([{ status: 202, body: { searchId: 's1' } }]);
    await client.createSearch({} as never, { idempotencyKey: 'case-4711' });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('case-4711');
  });
});

describe('waiting for a run', () => {
  it('polls until the run reaches a terminal state', async () => {
    const { client, calls } = clientWith([
      { status: 200, body: QUEUED },
      { status: 200, body: QUEUED },
      { status: 200, body: DONE },
    ]);

    const summary = await client.waitForSearch('s1', { pollIntervalMs: 1 });
    expect(summary.execution).toBe('SUCCEEDED');
    expect(calls.length).toBe(3);
  });

  it('throws on timeout rather than returning a QUEUED summary', async () => {
    // The dangerous alternative: returning the last summary. A caller that receives a QUEUED
    // run from a function called `waitForSearch` treats it as a result — and a QUEUED run has
    // `findings: NOT_EVALUATED`, which reads as "nothing found" to anybody not looking closely.
    const { client } = clientWith([{ status: 200, body: QUEUED }]);

    await expect(client.waitForSearch('s1', { timeoutMs: 5, pollIntervalMs: 1 })).rejects.toThrow(
      /still QUEUED/,
    );
  });

  it('says the run has not stopped, only the waiting', async () => {
    const { client } = clientWith([{ status: 200, body: QUEUED }]);
    await expect(client.waitForSearch('s1', { timeoutMs: 5, pollIntervalMs: 1 })).rejects.toThrow(
      /only the waiting/i,
    );
  });

  it('reports progress to the caller on each poll', async () => {
    const { client } = clientWith([
      { status: 200, body: QUEUED },
      { status: 200, body: DONE },
    ]);
    const seen: string[] = [];
    await client.waitForSearch('s1', { pollIntervalMs: 1, onPoll: (s) => seen.push(s.execution) });
    expect(seen).toEqual(['QUEUED', 'SUCCEEDED']);
  });

  it('treats CANCELLED as terminal, not as something to keep waiting for', async () => {
    const { client } = clientWith([{ status: 200, body: { ...QUEUED, execution: 'CANCELLED' } }]);
    const summary = await client.waitForSearch('s1', { pollIntervalMs: 1 });
    expect(summary.execution).toBe('CANCELLED');
  });
});

describe('errors', () => {
  it('carries the service error code, message and correlation id', async () => {
    const { client } = clientWith([
      {
        status: 403,
        body: {
          code: 'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN',
          message: 'This tenant is not entitled.',
          correlationId: 'corr-123',
        },
      },
    ]);

    const error = await client.getSearch('s1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdverseSearchError);
    const typed = error as AdverseSearchError;
    // A caller must be able to branch on the code without parsing prose.
    expect(typed.code).toBe('ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN');
    expect(typed.status).toBe(403);
    expect(typed.correlationId).toBe('corr-123');
  });

  it('marks a 5xx retryable and a 403 not', async () => {
    const server = clientWith([{ status: 503, body: { code: 'INTERNAL' } }]);
    const forbidden = clientWith([{ status: 403, body: { code: 'FORBIDDEN' } }]);

    const a = (await server.client.getSearch('s1').catch((e: unknown) => e)) as AdverseSearchError;
    const b = (await forbidden.client
      .getSearch('s1')
      .catch((e: unknown) => e)) as AdverseSearchError;

    expect(a.retryable).toBe(true);
    expect(b.retryable).toBe(false);
  });

  it('survives an error body that is not the documented shape', async () => {
    // A proxy or a load balancer can return HTML. The client must still raise something a
    // caller can handle rather than throwing a parse error from inside the transport.
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('<html>gateway timeout</html>', { status: 504 }),
      )) as unknown as typeof fetch;
    const client = new AdverseSearchClient({
      baseUrl: 'https://adverse.example.com',
      apiKey: 'k',
      fetchImpl,
    });

    await expect(client.getSearch('s1')).rejects.toThrow();
  });
});

describe('the shape of the API this client exposes', () => {
  it('offers no way to read findings without their coverage', () => {
    // There is deliberately no `getFindingsOnly`. An empty findings array is not a result until
    // the caller has read coverage beside it, so the contract does not let them be separated.
    const methods = Object.getOwnPropertyNames(AdverseSearchClient.prototype);
    expect(methods).toContain('getFindings');
    expect(methods.filter((m) => /finding/i.test(m))).toEqual(['getFindings']);
  });

  it('returns findings together with the run’s three dimensions', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: {
          searchId: 's1',
          execution: 'SUCCEEDED',
          findingsState: 'NO_MATCHES_FOUND',
          coverage: 'INCOMPLETE',
          findings: [],
          rejectedLeads: [],
          sourceOutcomes: [],
          unmeasuredLanguages: ['es'],
          noMatchStatement: { headline: 'h', limitations: [], disclaimer: 'd' },
          mode: 'MOCK',
        },
      },
    ]);

    const page = await client.getFindings('s1');
    expect(page.coverage).toBe('INCOMPLETE');
    expect(page.noMatchStatement).not.toBeNull();
    expect(page.unmeasuredLanguages).toEqual(['es']);
  });
});

describe('timeouts', () => {
  it('aborts a request that exceeds the configured timeout', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;

    const client = new AdverseSearchClient({
      baseUrl: 'https://adverse.example.com',
      apiKey: 'k',
      fetchImpl,
      timeoutMs: 10,
    });

    await expect(client.getSearch('s1')).rejects.toThrow();
  });
});
