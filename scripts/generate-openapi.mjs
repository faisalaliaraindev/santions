#!/usr/bin/env node
/**
 * `pnpm openapi:generate` — write `openapi/openapi.json` from the contract schemas.
 *
 * The document is committed. A contract change then arrives as a reviewable diff in the same
 * pull request as the code that caused it, rather than as a surprise in a consumer at
 * runtime. `apps/api/test/openapi-document.test.ts` fails if the committed file is stale.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

import { buildOpenApiDocument } from '../packages/contracts/dist/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'openapi', 'openapi.json');

// Formatted with the repository's own prettier configuration rather than raw `JSON.stringify`.
// Otherwise `format:check` and the drift test disagree — one demands prettier's layout, the
// other demands the generator's — and there is no file that satisfies both.
const formatted = await prettier.format(JSON.stringify(buildOpenApiDocument()), {
  ...((await prettier.resolveConfig(target)) ?? {}),
  parser: 'json',
});

writeFileSync(target, formatted, 'utf8');

console.log(`OpenAPI document written to ${target}`);
