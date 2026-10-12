/**
 * The generated client is committed, so it can go stale against the contract it came from.
 * These tests check the two ways that matters.
 *
 * **Coverage** — every operation the service publishes has a function here, and no function
 * exists for a route the service refuses by design. A missing operation is a page that cannot
 * be built; a function for a reserved route is an invitation to call something that answers
 * 501.
 *
 * **Routing** — the panel's own routes are version-prefixed and the sign-in and health routes
 * are not. Getting that wrong produces a 404 that looks like an outage, and it is exactly the
 * kind of thing a regeneration can change silently.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as operations from './generated/operations.ts';

const DOCUMENT = join(
  process.cwd(),
  '..',
  'erly-sanction-service-backend',
  'openapi',
  'openapi.json',
);

/** The client is generated from the sibling repository, which is not always checked out. */
const hasDocument = existsSync(DOCUMENT);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
}

interface OpenApiDocument {
  readonly paths: Record<string, Record<string, { operationId?: string; tags?: string[] }>>;
}

function publishedOperations(): { id: string; tags: string[] }[] {
  const document = JSON.parse(readFileSync(DOCUMENT, 'utf8')) as OpenApiDocument;

  return Object.values(document.paths).flatMap((item) =>
    Object.values(item)
      .filter((operation) => typeof operation.operationId === 'string')
      .map((operation) => ({ id: operation.operationId ?? '', tags: operation.tags ?? [] })),
  );
}

describe('the generated API client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.runIf(hasDocument)('exports a function for every callable published operation', () => {
    // Sign-in is a redirect journey, not a call: fetching it would follow the redirect to the
    // identity provider and fail on CORS, which reads as an outage rather than as "this is
    // not how sign-in works". It is exported as a path to navigate to instead.
    const redirects = new Set(['authLogin', 'authCallback']);

    const missing = publishedOperations()
      .filter(({ tags }) => !tags.includes('reserved'))
      .filter(({ id }) => !redirects.has(id))
      .filter(({ id }) => typeof (operations as Record<string, unknown>)[id] !== 'function');

    expect(
      missing.map(({ id }) => id),
      'Published operations with no client function. Run `pnpm api:generate`.',
    ).toEqual([]);

    expect(operations.AUTH_LOGIN_PATH).toBe('/auth/login');
  });

  it.runIf(hasDocument)('exports nothing for the reserved routes', () => {
    // FR-15 reserved routes answer 501 by design (decision D-007).
    const reserved = publishedOperations()
      .filter(({ tags }) => tags.includes('reserved'))
      .filter(({ id }) => (operations as Record<string, unknown>)[id] !== undefined);

    expect(reserved.map(({ id }) => id)).toEqual([]);
  });

  it('sends business calls to the versioned surface', async () => {
    const fetchMock = mockFetch();

    await operations.getSearch({ path: { searchId: 'srch_1' } });
    await operations.listSearches({ query: { limit: 20 } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/searches/srch_1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/v1/searches?limit=20');
  });

  it('does not version the sign-in and health routes', async () => {
    // They are VERSION_NEUTRAL on the service. Prefixing them would 404 on every deployment.
    const fetchMock = mockFetch();

    await operations.authSession();
    await operations.healthLive();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/auth/session');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/health/live');
  });

  it('escapes path parameters', async () => {
    const fetchMock = mockFetch();

    await operations.getSubjectVersion({ path: { subjectId: 'a/b c', version: 2 } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/subjects/a%2Fb%20c/versions/2');
  });

  it('carries an idempotency key through the transport', async () => {
    document.cookie = 'csrf_token=test-csrf-token';
    const fetchMock = mockFetch();

    await operations.createSearch(
      {
        body: {
          requestedScope: {
            jurisdictions: ['CR'],
            languages: ['es'],
            includeFormerDirectorships: false,
            fromDate: null,
          },
          environment: 'sandbox',
        },
      },
      { idempotencyKey: 'key-1' },
    );

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('key-1');
    expect(headers['X-CSRF-Token']).toBe('test-csrf-token');
  });

  it('omits an empty query string rather than sending a bare ?', async () => {
    const fetchMock = mockFetch();

    await operations.listSearches();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/searches');
  });
});
