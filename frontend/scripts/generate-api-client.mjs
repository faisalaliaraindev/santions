#!/usr/bin/env node
/**
 * Generates the typed API client from the backend's OpenAPI document.
 *
 * This is the only route from the control panel to the service (decision D-001). Three things
 * about how it works are deliberate:
 *
 *  - **The output is committed.** The panel builds with no backend running, and a contract
 *    change arrives as a reviewable diff rather than as a runtime surprise in a page nobody
 *    thought to retest.
 *  - **`src/lib/api/client.ts` is never generated.** Transport, the backend-for-frontend
 *    session, CSRF and error typing are hand-written once and every operation goes through
 *    them. Generating them per operation is how one path ends up without CSRF.
 *  - **Reserved routes get no client function.** They answer 501 by design (decision D-007);
 *    a typed function for one is an invitation to call it.
 *
 * Run `pnpm openapi:generate` in the backend first if the document is stale.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';
import prettier from 'prettier';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(projectRoot, 'src', 'lib', 'api', 'generated');

const documentPath = resolve(
  process.argv[2] ??
    process.env.ERLY_OPENAPI_DOCUMENT ??
    join(projectRoot, '..', 'erly-sanction-service-backend', 'openapi', 'openapi.json'),
);

/** Browser redirect journeys, not fetchable calls. Exported as paths to navigate to. */
const REDIRECT_OPERATIONS = new Set(['authLogin', 'authCallback']);

/** Reserved FR-15 routes (decision D-007). Documented for integrators, not called by us. */
const SKIPPED_TAGS = new Set(['reserved']);

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Business routes carry it. Auth and health are version-neutral on the service. */
const VERSION_PREFIX = '/v1';

const HEADER = [
  '/**',
  ' * GENERATED FILE — do not edit.',
  ' *',
  " * Produced by `pnpm api:generate` from the backend's OpenAPI document. To change it, edit",
  ' * the contract schemas in the backend (`packages/contracts`), regenerate, and commit the',
  ' * diff.',
  ' */',
  '',
].join('\n');

async function main() {
  const document = readDocument();

  mkdirSync(outputDir, { recursive: true });

  await write('schema.ts', astToString(await openapiTS(pathToFileURL(documentPath))));
  await write('operations.ts', operationsModule(document));
  await write(
    'index.ts',
    [
      "export * from './operations';",
      "export type { components, paths } from './schema';",
      '',
    ].join('\n'),
  );

  console.log(`Generated the API client from ${documentPath}`);
}

function readDocument() {
  try {
    return JSON.parse(readFileSync(documentPath, 'utf8'));
  } catch (error) {
    console.error(
      [
        `Could not read the OpenAPI document at ${documentPath}.`,
        '',
        'It is generated and committed by the backend repository:',
        '',
        '  cd ../erly-sanction-service-backend && pnpm openapi:generate',
        '',
        'Pass a different location as the first argument or in ERLY_OPENAPI_DOCUMENT.',
        '',
        String(error instanceof Error ? error.message : error),
      ].join('\n'),
    );
    process.exit(1);
  }
}

async function write(name, body) {
  const file = join(outputDir, name);
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(`${HEADER}\n${body}`, {
    ...config,
    parser: 'typescript',
  });
  writeFileSync(file, formatted, 'utf8');
}

/** Collect the operations worth generating, with everything the emitter needs. */
function collectOperations(document) {
  const collected = [];

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;

      const tags = operation.tags ?? [];
      if (tags.some((tag) => SKIPPED_TAGS.has(tag))) continue;
      if (REDIRECT_OPERATIONS.has(operation.operationId)) continue;

      const parameters = (operation.parameters ?? []).map((parameter) =>
        resolveParameter(document, parameter),
      );

      collected.push({
        name: operation.operationId,
        method,
        path,
        summary: operation.summary ?? '',
        description: operation.description ?? '',
        pathParameters: parameters.filter((p) => p.in === 'path'),
        // Header parameters are the transport's business: CSRF and Idempotency-Key are set by
        // the client, not passed per call, so a caller cannot forget one.
        hasQuery: parameters.some((p) => p.in === 'query'),
        hasBody: operation.requestBody !== undefined,
        successStatus: successStatus(operation.responses ?? {}),
        returnsContent: hasJsonContent(operation.responses ?? {}),
      });
    }
  }

  return collected.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveParameter(document, parameter) {
  if (parameter.$ref === undefined) return parameter;
  const name = parameter.$ref.split('/').pop();
  return document.components?.parameters?.[name] ?? {};
}

/**
 * The success a caller should expect.
 *
 * Explicitly ranked rather than taken in document order, because JSON object keys are not
 * ordered: `Object.keys` returns integer-like keys ascending, so a parsed document cannot say
 * which status the contract listed first. Creating a search answers 202; its 200 is the
 * idempotent replay of an earlier one, and documenting the replay as the normal outcome would
 * describe the opposite of what the service does.
 */
const SUCCESS_PREFERENCE = [202, 201, 200, 204, 203, 205, 206];

function successStatus(responses) {
  const declared = Object.keys(responses).map(Number);
  return (
    SUCCESS_PREFERENCE.find((code) => declared.includes(code)) ??
    declared.find((code) => code >= 200 && code < 300)
  );
}

function hasJsonContent(responses) {
  const status = successStatus(responses);
  return responses[String(status)]?.content?.['application/json'] !== undefined;
}

function operationsModule(document) {
  const operations = collectOperations(document);
  const redirects = redirectConstants(document);

  return [PREAMBLE, ...operations.map((operation) => emit(operation)), redirects].join('\n\n');
}

const PREAMBLE = `import { apiRequest } from '../client';
import type { RequestOptions } from '../client';
import type { paths } from './schema';

/** Per-call options. Everything else — credentials, CSRF, error typing — is the transport's. */
export interface OperationOptions {
  readonly signal?: AbortSignal;
  /**
   * FR-12. Send it on a submission that must be safe to retry: an identical request returns
   * the original operation, and a changed body under the same key returns 409.
   */
  readonly idempotencyKey?: string;
}

function request(
  operation: OperationOptions | undefined,
  base: Partial<RequestOptions>,
): RequestOptions {
  return {
    ...base,
    ...(operation?.signal === undefined ? {} : { signal: operation.signal }),
    ...(operation?.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: operation.idempotencyKey }),
  };
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (query === undefined) return '';

  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) parameters.append(key, String(entry));
    } else {
      parameters.append(key, String(value));
    }
  }

  const serialised = parameters.toString();
  return serialised === '' ? '' : \`?\${serialised}\`;
}`;

function emit(operation) {
  const capital = operation.name.charAt(0).toUpperCase() + operation.name.slice(1);
  const accessor = `paths['${operation.path}']['${operation.method}']`;

  const aliases = [];
  const requestFields = [];

  if (operation.pathParameters.length > 0) {
    aliases.push(`export type ${capital}Path = ${accessor}['parameters']['path'];`);
    requestFields.push(`readonly path: ${capital}Path;`);
  }
  if (operation.hasQuery) {
    aliases.push(`export type ${capital}Query = NonNullable<${accessor}['parameters']['query']>;`);
    requestFields.push(`readonly query?: ${capital}Query;`);
  }
  if (operation.hasBody) {
    aliases.push(
      `export type ${capital}Body = NonNullable<${accessor}['requestBody']>['content']['application/json'];`,
    );
    requestFields.push(`readonly body: ${capital}Body;`);
  }

  const responseType = operation.returnsContent ? `${capital}Response` : 'void';
  if (operation.returnsContent) {
    aliases.push(
      `export type ${capital}Response = ${accessor}['responses'][${String(operation.successStatus)}]['content']['application/json'];`,
    );
  }

  const requestInterface =
    requestFields.length > 0
      ? [`export interface ${capital}Request {`, ...requestFields.map((f) => `  ${f}`), '}'].join(
          '\n',
        )
      : '';

  // A request object with only optional members should not be mandatory at the call site.
  const allOptional = requestFields.every((field) => field.includes('?:'));
  const signature =
    requestFields.length === 0
      ? 'operation?: OperationOptions'
      : `input${allOptional ? ': ' + capital + 'Request = {}' : ': ' + capital + 'Request'}, operation?: OperationOptions`;

  const base = [`method: '${operation.method.toUpperCase()}'`];
  if (operation.hasBody) base.push('body: input.body');
  if (!operation.path.startsWith(VERSION_PREFIX)) {
    // Version-neutral on the service; the transport's default /v1 prefix must not apply.
    base.push("basePath: ''");
  }

  return [
    ...aliases,
    requestInterface,
    docComment(operation),
    `export async function ${operation.name}(${signature}): Promise<${responseType}> {`,
    `  return apiRequest<${responseType}>(`,
    `    ${urlExpression(operation)},`,
    `    request(operation, { ${base.join(', ')} }),`,
    '  );',
    '}',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

function urlExpression(operation) {
  const clientPath = operation.path.startsWith(VERSION_PREFIX)
    ? operation.path.slice(VERSION_PREFIX.length)
    : operation.path;

  const interpolated = clientPath.replace(
    /\{([A-Za-z0-9_]+)\}/gu,
    (_match, name) => `\${encodeURIComponent(String(input.path.${name}))}`,
  );

  return operation.hasQuery
    ? `\`${interpolated}\${queryString(input.query)}\``
    : `\`${interpolated}\``;
}

/** Carries the contract's own prose to the call site, where it is actually read. */
function docComment(operation) {
  const text = [operation.summary, operation.description]
    .filter((part) => part.length > 0)
    .join('\n\n')
    .split('\n');

  return ['/**', ...text.map((line) => ` * ${line}`.trimEnd()), ' */'].join('\n');
}

/**
 * Sign-in is a browser redirect, so it is a path to navigate to rather than a call. A fetch
 * would follow the redirect to the identity provider and fail on CORS, which reads as an
 * outage rather than as "this is not how sign-in works".
 */
function redirectConstants(document) {
  const constants = [];

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      if (!REDIRECT_OPERATIONS.has(operation.operationId)) continue;

      const name = operation.operationId
        .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
        .toUpperCase()
        .concat('_PATH');
      constants.push(`/** ${operation.summary}. Navigate to it; do not fetch it. */`);
      constants.push(`export const ${name} = '${path}';`);
    }
  }

  return constants.join('\n');
}

// Called last: the emitter templates below are const-declared, and a call above them
// would hit the temporal dead zone.
await main();
