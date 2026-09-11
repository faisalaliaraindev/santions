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

import { buildOpenApiDocument } from '../packages/contracts/dist/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'openapi', 'openapi.json');

// Two spaces and a trailing newline: the same shape prettier would produce, so formatting
// never shows up as a diff on top of a real contract change.
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');

console.log(`OpenAPI document written to ${target}`);
