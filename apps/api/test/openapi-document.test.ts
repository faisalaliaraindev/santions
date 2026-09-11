/**
 * The document must match two things it is easy to drift from: the file we committed, and the
 * routes the service actually serves.
 *
 * The second check is the one that earns its place. A published contract that silently omits
 * an endpoint is not a small documentation gap — it is an undocumented surface that no
 * consumer knows to exercise and no reviewer knows to look at.
 *
 * Route metadata is read from the controller classes directly. Booting the application would
 * need MongoDB and Keycloak, and a contract check that only runs with infrastructure up is a
 * check that stops running.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '@erly/adverse-contracts';

import { AuthController } from '../src/auth/auth.controller.js';
import { ReservedController } from '../src/common/reserved.controller.js';
import { HealthController } from '../src/health/health.controller.js';
import { SearchesController } from '../src/searches/searches.controller.js';
import { SubjectsController } from '../src/subjects/subjects.controller.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const committedPath = join(repoRoot, 'openapi', 'openapi.json');

/** Every controller registered in `AppModule`. Adding one here is part of adding a route. */
const CONTROLLERS = [
  HealthController,
  AuthController,
  SubjectsController,
  SearchesController,
  ReservedController,
];

interface Route {
  readonly method: string;
  readonly path: string;
}

/**
 * `@All` answers every method. It is reported as `all`, and the path — not the method — is
 * what the coverage check requires to be documented.
 */
const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.ALL]: 'all',
};

const reflect = Reflect as unknown as {
  getMetadata: (key: string, target: object) => unknown;
};

/** Nest stores a path as a string, but the metadata API is untyped. Narrow, never stringify. */
function metadataPath(key: string, target: object): string {
  const value = reflect.getMetadata(key, target);
  return typeof value === 'string' ? value : '';
}

function routesOf(controller: new (...args: never[]) => object): Route[] {
  const controllerPath = metadataPath(PATH_METADATA, controller);
  const version = reflect.getMetadata(VERSION_METADATA, controller);
  // Controllers declare their version explicitly; `defaultVersion` in `main.ts` is a net, not
  // a convention to rely on here.
  const prefix = version === VERSION_NEUTRAL ? '' : `/v${String(version)}`;

  const prototype = controller.prototype as object;
  const routes: Route[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = (prototype as Record<string, unknown>)[name];
    if (typeof handler !== 'function') continue;

    const method = reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof method !== 'number') continue;

    const handlerPath = metadataPath(PATH_METADATA, handler);
    routes.push({
      method: METHOD_NAMES[method] ?? String(method),
      path: toOpenApiPath(prefix, controllerPath, handlerPath),
    });
  }

  return routes;
}

/** `/searches/:searchId` in Nest is `/v1/searches/{searchId}` in OpenAPI. */
function toOpenApiPath(prefix: string, controllerPath: string, handlerPath: string): string {
  const joined = [prefix, controllerPath, handlerPath]
    .map((segment) => segment.replace(/^\/+|\/+$/gu, ''))
    .filter((segment) => segment.length > 0)
    .join('/');

  return `/${joined}`.replace(/:([A-Za-z0-9_]+)/gu, '{$1}');
}

describe('the committed OpenAPI document', () => {
  it('is up to date with the contract schemas', () => {
    const committed: unknown = JSON.parse(readFileSync(committedPath, 'utf8'));

    expect(
      committed,
      'openapi/openapi.json is stale. Run `pnpm openapi:generate` and commit the result.',
    ).toEqual(buildOpenApiDocument());
  });

  it('documents every route the controllers serve', () => {
    const documented = new Set(Object.keys(buildOpenApiDocument()['paths'] as object));
    const served = CONTROLLERS.flatMap((controller) => routesOf(controller));

    // A guard against the check quietly passing because it found no routes at all.
    expect(served.length).toBeGreaterThanOrEqual(12);

    const undocumented = served.filter((route) => !documented.has(route.path));
    expect(undocumented, 'These routes are served but absent from the OpenAPI document.').toEqual(
      [],
    );
  });

  it('documents the method each route is served on', () => {
    const paths = buildOpenApiDocument()['paths'] as Record<string, Record<string, unknown>>;

    for (const route of CONTROLLERS.flatMap((controller) => routesOf(controller))) {
      const item = paths[route.path];
      expect(item, `${route.path} is documented`).toBeDefined();
      if (route.method === 'all') continue; // Any documented method covers an `@All` route.

      expect(
        Object.keys(item ?? {}),
        `${route.method.toUpperCase()} ${route.path} is documented`,
      ).toContain(route.method);
    }
  });

  it('does not document a route that no controller serves', () => {
    // The other direction: a path that survives in the document after the code that served it
    // is gone tells an integrator to call something that now 404s.
    const served = new Set(
      CONTROLLERS.flatMap((controller) => routesOf(controller)).map((route) => route.path),
    );

    const documented = Object.keys(buildOpenApiDocument()['paths'] as object);
    expect(documented.filter((path) => !served.has(path))).toEqual([]);
  });
});
