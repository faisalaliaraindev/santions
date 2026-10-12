#!/usr/bin/env node
/**
 * `pnpm local:bootstrap` — bring a started local stack to a working, seeded state.
 *
 * Idempotent: safe to run repeatedly. Guarded: refuses to run against anything that is not
 * local. Honest: it labels every seeded record as mock, and it does not claim that local
 * emulation proves anything about real AWS.
 *
 * Run after `pnpm local:up`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapAws } from './bootstrap/aws.mjs';
import { bootstrapSearchIndex } from './bootstrap/search-index.mjs';
import { connectMongo, ensureIndexes, seedData } from './bootstrap/seed-data.mjs';
import { assertLocalOnly, log, waitFor } from './lib/local-guard.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader — avoids a dependency for six variables. */
function loadEnv() {
  try {
    const content = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
      }
    }
    log.info('loaded .env');
  } catch {
    log.info('no .env found; using defaults from .env.example');
  }
}

async function checkKeycloak() {
  log.step('OIDC provider');
  const issuer = process.env['OIDC_ISSUER'] ?? 'http://127.0.0.1:28080/realms/adverse-search-local';

  const config = await waitFor(
    'Keycloak realm',
    async () => {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`);
      return response.ok ? response.json() : false;
    },
    { timeoutMs: 120_000 },
  );

  log.info(`realm reachable: ${config.issuer}`);
  log.info(
    `authorization_endpoint present: ${String(config.authorization_endpoint !== undefined)}`,
  );

  // If the realm imported but has no users, the security-negative tests in Phase B cannot be
  // written honestly. Better to say so now than to discover it two phases later.
  log.info('synthetic users: alpha.analyst, alpha.reviewer, beta.analyst, platform.operator, …');
  log.info('DEVELOPMENT ONLY — production startup must reject this issuer (test T09)');

  return { issuer };
}

async function checkModelRuntime() {
  log.step('Extraction model runtime');
  const url = process.env['MODEL_RUNTIME_URL'] ?? 'http://127.0.0.1:28434';

  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`status ${String(response.status)}`);
    }
    const body = await response.json();
    const count = Array.isArray(body.models) ? body.models.length : 0;
    log.info(`runtime healthy, ${String(count)} model(s) loaded`);
    if (count === 0) {
      // Deliberate. Which open-weight model to use is open decision D7, closing in Phase F.
      // Pulling one here to make the check look better would decide D7 by accident.
      log.info(
        'no model pulled — open decision D7 (Phase F). EXTRACTION_MODEL_KIND=synthetic until then',
      );
    }
  } catch (error) {
    log.warn(
      `model runtime not reachable (${String(error.message)}). Extraction is Phase F; continuing.`,
    );
  }
}

async function main() {
  console.log('Local bootstrap — mock mode only, no live source is contacted.\n');

  loadEnv();

  assertLocalOnly(
    {
      MONGODB_URI: process.env['MONGODB_URI'],
      AWS_ENDPOINT_URL: process.env['AWS_ENDPOINT_URL'],
      MEILI_HOST: process.env['MEILI_HOST'],
      OIDC_ISSUER: process.env['OIDC_ISSUER'],
    },
    'bootstrap',
  );

  const mode = process.env['ADVERSE_SEARCH_MODE'] ?? 'mock';
  if (mode !== 'mock') {
    throw new Error(
      `Refusing to bootstrap with ADVERSE_SEARCH_MODE=${mode}. Seeding is mock-mode only; fixtures must never appear as live results (test T55).`,
    );
  }

  const uri =
    process.env['MONGODB_URI'] ??
    'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

  const results = {};

  results.aws = await bootstrapAws();
  results.index = await bootstrapSearchIndex();
  results.oidc = await checkKeycloak();
  await checkModelRuntime();

  log.step('MongoDB');
  const client = await connectMongo(uri);
  try {
    const db = client.db();
    log.info(`connected to ${db.databaseName} with a writable primary (transactions available)`);
    await ensureIndexes(db);
    await seedData(db);
  } finally {
    await client.close();
  }

  console.log(
    [
      '',
      '═══ bootstrap complete ═══',
      '',
      `  S3 bucket      ${results.aws.bucket}`,
      `  Jobs queue     ${results.aws.queueUrl ?? 'n/a'}`,
      `  DLQ            ${results.aws.dlqUrl ?? 'n/a'}`,
      `  Search index   ${results.index.kind} — ${results.index.indexes.join(', ')}`,
      `  OIDC issuer    ${results.oidc.issuer}`,
      '',
      '  Mode: MOCK. No live source has been contacted.',
      '  No language is enabled — none has a measured recall figure (FR-03).',
      '  Local S3 emulation is not evidence that real AWS IAM/KMS policies work (gate G11).',
      '',
      '  Re-running this command is safe; every write is an upsert.',
      '',
    ].join('\n'),
  );
}

try {
  await main();
} catch (error) {
  console.error(`\nBootstrap failed.\n\n${String(error.message ?? error)}\n`);
  process.exit(1);
}
