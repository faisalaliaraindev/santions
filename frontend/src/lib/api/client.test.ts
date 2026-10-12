import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest } from './client.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiRequest', () => {
  beforeEach(() => {
    document.cookie = 'csrf_token=test-csrf-token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the session cookie rather than a bearer token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { ok: true }));

    await apiRequest('/searches');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.credentials).toBe('same-origin');
    // Provider tokens stay server-side (section 4.2). Nothing bearer-shaped in the browser.
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i);
  });

  it('versions every route under /v1', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}));
    await apiRequest('/searches/abc');
    expect(fetchMock.mock.calls[0]![0]).toBe('/v1/searches/abc');
  });

  it('attaches a CSRF token to state-changing requests only', async () => {
    // A fresh Response per call: a Response body can only be read once.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse(200, {})));

    await apiRequest('/searches');
    expect(
      (fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)['X-CSRF-Token'],
    ).toBeUndefined();

    await apiRequest('/searches', { method: 'POST', body: { name: 'test' } });
    expect((fetchMock.mock.calls[1]![1]?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'test-csrf-token',
    );
  });

  it('forwards the idempotency key when one is supplied', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}));
    await apiRequest('/searches', { method: 'POST', body: {}, idempotencyKey: 'key-1' });
    expect(
      (fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe('key-1');
  });

  it('raises a typed error carrying the correlation ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(500, {
        code: 'INTERNAL',
        message: 'Something failed',
        correlationId: 'corr-123',
        retryable: true,
      }),
    );

    await expect(apiRequest('/searches')).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL',
      correlationId: 'corr-123',
      retryable: true,
    });
  });

  it('distinguishes an entitlement denial from a rate limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(403, {
        code: 'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN',
        message: 'Not included in plan',
        correlationId: 'corr-1',
        retryable: false,
      }),
    );

    const error = await apiRequest('/searches').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    // REL-02: an entitlement denial is not throttling and not a coverage gap. The panel must
    // be able to say which, because the operator's next action is completely different.
    expect((error as ApiError).isEntitlementDenial).toBe(true);
    expect((error as ApiError).retryable).toBe(false);
  });

  it('flags a session expiry and a revision conflict distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, {
        code: 'UNAUTHENTICATED',
        message: 'Expired',
        correlationId: '',
        retryable: false,
      }),
    );
    const expired = (await apiRequest('/searches').catch((e: unknown) => e)) as ApiError;
    expect(expired.isSessionExpired).toBe(true);
    expect(expired.isRevisionConflict).toBe(false);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Stale',
        correlationId: '',
        retryable: false,
      }),
    );
    const conflict = (await apiRequest('/searches').catch((e: unknown) => e)) as ApiError;
    expect(conflict.isRevisionConflict).toBe(true);
  });

  it('survives a non-JSON error body without crashing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>502</html>', { status: 502 }),
    );
    const error = (await apiRequest('/searches').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('UNKNOWN');
  });

  it('returns undefined for a 204 rather than trying to parse a body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiRequest('/searches/abc/cancel', { method: 'POST' })).resolves.toBeUndefined();
  });
});
