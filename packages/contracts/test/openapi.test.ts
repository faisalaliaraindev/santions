/**
 * What the OpenAPI document must be true about, independent of any committed file.
 *
 * These are contract properties, not formatting checks. Each one corresponds to a way the
 * document could describe a service that behaves differently from the one we built — which is
 * worse than having no document, because a client would trust it.
 */

import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../src/openapi/document.js';
import { COMPONENT_SCHEMAS } from '../src/openapi/components.js';
import { ERROR_CODES, ERROR_RETRYABLE, ERROR_STATUS } from '../src/errors/errors.js';

type Json = Record<string, unknown>;

const document = buildOpenApiDocument();
const paths = document['paths'] as Record<string, Record<string, Json>>;
const components = document['components'] as Record<string, Record<string, Json>>;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function operations(): { path: string; method: string; operation: Json }[] {
  const found: { path: string; method: string; operation: Json }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.includes(method)) found.push({ path, method, operation });
    }
  }
  return found;
}

function collectRefs(node: unknown, into: Set<string>): Set<string> {
  if (node === null || typeof node !== 'object') return into;
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, into);
    return into;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') into.add(value);
    else collectRefs(value, into);
  }
  return into;
}

function resolve(pointer: string): unknown {
  const segments = pointer.replace(/^#\//u, '').split('/');
  let current: unknown = document;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe('the OpenAPI document', () => {
  it('resolves every $ref it contains', () => {
    const refs = collectRefs(document, new Set<string>());
    expect(refs.size).toBeGreaterThan(0);

    const unresolved = [...refs].filter((ref) => resolve(ref) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('gives every operation a unique operationId', () => {
    const ids = operations().map(({ operation }) => operation['operationId']);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('documents 401 and 403 on every authenticated operation', () => {
    // A documented route that omits them reads as public. The panel would then treat an
    // expired session as an unexpected failure rather than offering a way back in.
    const authenticated = operations().filter(
      ({ operation }) => operation['security'] === undefined,
    );
    expect(authenticated.length).toBeGreaterThan(0);

    for (const { path, method, operation } of authenticated) {
      const responses = operation['responses'] as Json;
      expect(Object.keys(responses), `${method.toUpperCase()} ${path} must document 401`).toContain(
        '401',
      );
      expect(Object.keys(responses), `${method.toUpperCase()} ${path} must document 403`).toContain(
        '403',
      );
    }
  });

  it('marks the probes, the sign-in redirects and signup as unauthenticated, and nothing else', () => {
    const publicOperations = operations()
      .filter(({ operation }) => Array.isArray(operation['security']))
      .map(({ path }) => path);

    // This list is meant to be hard to grow. Every entry is a route reachable with no
    // credential, and adding one is a decision somebody should have to make deliberately —
    // which is why this test exists and why it fails when a new `@Public()` route is
    // documented.
    //
    // `/v1/signup` is the newest and the only one that **writes** (phase I, I1). It is
    // deliberate: a customer cannot authenticate before they have a tenant. What pays for it is
    // that the route reads no principal, generates the tenant id itself, and is bounded per
    // client address.
    expect(publicOperations.toSorted()).toEqual([
      '/auth/callback',
      '/auth/login',
      '/health/live',
      '/health/ready',
      '/v1/signup',
    ]);
  });

  it('documents every error code exactly once, under the status the service returns', () => {
    const responses = components['responses'] ?? {};

    for (const code of ERROR_CODES) {
      const expected = `Error${String(ERROR_STATUS[code])}`;
      const documented = Object.entries(responses).filter(([, response]) =>
        String(response['description']).includes(code),
      );

      expect(
        documented.map(([name]) => name),
        `${code} is documented once`,
      ).toEqual([expected]);
    }
  });

  it('never describes a 403 as retryable', () => {
    // REL-02: an entitlement denial is not throttling. A client that retries a capability it
    // does not have generates load that cannot possibly succeed.
    const forbidden = components['responses']?.['Error403'];
    const example = (
      (forbidden?.['content'] as Json | undefined)?.['application/json'] as Json | undefined
    )?.['example'] as Json | undefined;

    expect(example?.['retryable']).toBe(false);
    expect(ERROR_RETRYABLE.ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN).toBe(false);
    expect(ERROR_RETRYABLE.RATE_LIMITED).toBe(true);
  });

  it('emits a component schema for every registered contract schema', () => {
    const schemas = components['schemas'] ?? {};
    expect(Object.keys(schemas).toSorted()).toEqual(Object.keys(COMPONENT_SCHEMAS).toSorted());
  });

  it('rejects unknown fields in every request body schema', () => {
    // The zod schemas are `.strict()`. If that failed to survive conversion, the document
    // would be advertising a tolerance the service does not have.
    const schemas = components['schemas'] ?? {};
    for (const name of ['CreateSubjectRequest', 'CreateSearchRequest']) {
      expect(schemas[name]?.['additionalProperties'], `${name} is strict`).toBe(false);
    }
  });

  it('keeps the three result dimensions as separate fields', () => {
    // Section 6.2. Collapsing them into one status is how a screening product reports a clean
    // result for a run in which every source was blocked.
    const summary = components['schemas']?.['SearchSummary'];
    const properties = summary?.['properties'] as Json | undefined;

    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(['execution', 'findings', 'coverage']),
    );
    expect(properties?.['status']).toBeUndefined();
  });

  it('declares all three credentials and never suggests a token in the browser', () => {
    const schemes = components['securitySchemes'] ?? {};
    expect(Object.keys(schemes).toSorted()).toEqual(['apiKey', 'machineToken', 'sessionCookie']);
    expect(schemes['sessionCookie']?.['in']).toBe('cookie');
    expect(schemes['machineToken']?.['scheme']).toBe('bearer');
    // Its own scheme, not a second kind of Bearer: see the note in document.ts.
    expect(schemes['apiKey']?.['in']).toBe('header');
    expect(schemes['apiKey']?.['name']).toBe('Authorization');
  });

  it('documents the reserved FR-15 routes with a 501 and a reason', () => {
    const reserved = operations().filter(({ operation }) =>
      (operation['tags'] as string[] | undefined)?.includes('reserved'),
    );
    expect(reserved.length).toBeGreaterThan(0);

    for (const { path, operation } of reserved) {
      const responses = operation['responses'] as Json;
      expect(Object.keys(responses), `${path} returns 501`).toContain('501');
      expect(String(operation['description']), `${path} names the decision`).toContain('D-007');
    }
  });
});
