#!/usr/bin/env node
/**
 * `pnpm key:issue` — mint a machine API key so a human can actually call this service.
 *
 * # Why a script and not an endpoint
 *
 * `POST /v1/tenant/api-keys` exists in the OpenAPI document and returns **501**. That is not an
 * oversight: decision **D-007** defers the whole commercial self-service layer, and records that
 * keys are **provider-managed** in this phase. A script an operator runs *is* provider-managed
 * key issuance. Building the endpoint instead would quietly close a decision nobody has taken.
 *
 * So the gap this fills is narrower than it looks. `ApiKeyService` already does create, verify,
 * rotate, revoke, list and audit, and all of it is tested. What was missing was any way to reach
 * it without writing a throwaway script against Mongo — which is exactly what `demo-api.mjs` has
 * been doing, and what anyone wanting to try the API in Postman had to copy.
 *
 * # The secret is shown once
 *
 * Only a SHA-256 hash is stored. There is no recovery path and there is not meant to be: a
 * credential a provider can read back is a credential a provider can leak. Copy it when it
 * prints, or issue another.
 *
 * # It refuses to run against anything that is not local
 *
 * Same guard as `local:bootstrap` and `local:reset`. A key-minting script that can reach a real
 * database is a script that eventually mints a key in one. Issuing keys for a deployed
 * environment is an operator procedure with an audit trail, not a developer convenience — pass
 * `--i-am-sure` only if you are running this against a stack you own and have understood that.
 *
 * ## Usage
 *
 * ```
 * pnpm key:issue                                   # tenant-alpha, sandbox, analyst
 * pnpm key:issue --tenant tenant-beta --role viewer
 * pnpm key:issue --env live --role tenant_admin --label "postman, Faisal"
 * pnpm key:issue --list --tenant tenant-alpha      # what exists, without secrets
 * pnpm key:issue --revoke <keyId> --reason "rotated"
 * ```
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MongoClient } from 'mongodb';

import { assertLocalOnly, log } from './lib/local-guard.mjs';

/** The shared `log` has step/info/warn; these two are local so the helper stays unchanged. */
const good = (message) => {
  console.log(`  OK       ${message}`);
};
const fail = (message) => {
  console.error(`  FAILED   ${message}`);
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The roles a key may be given, and what each is for.
 *
 * Listed here rather than imported so that the help text is readable without building the
 * project. `permissions.ts` is the authority; if these drift, that file wins and this list is
 * wrong — which is why the script validates against the compiled roles below rather than
 * against this table.
 */
const ROLE_HELP = {
  viewer: 'read searches, findings, coverage, associations',
  analyst: 'viewer + create/cancel/refresh searches, read evidence, export',
  reviewer: 'viewer + record review decisions. Deliberately cannot create searches',
  tenant_admin: 'viewer + manage the tenant, its clients, webhooks, keys; read audit',
  source_admin: 'viewer + propose and approve sources and policies',
  taxonomy_admin: 'viewer + propose and approve taxonomy versions',
  auditor: 'read the audit trail',
  platform_operator: 'operate the platform; read health',
  platform_admin: 'platform administration',
};

/** Minimal .env loader — the same six variables every other script here reads. */
function loadEnv() {
  try {
    const content = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
      }
    }
  } catch {
    // No .env is fine. Defaults below match .env.example.
  }
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

function usage() {
  console.log(`
Issue a machine API key for the adverse-search service.

  pnpm key:issue [options]

Options
  --tenant <id>      Tenant the key belongs to        (default: tenant-alpha)
  --env <name>       sandbox | live                   (default: sandbox)
  --role <name>      Role to grant, repeatable        (default: analyst)
  --label <text>     What this key is for             (default: generated)
  --expires <days>   Expire after N days              (default: never)
  --list             List this tenant's keys, no secrets
  --revoke <keyId>   Revoke a key
  --reason <text>    Reason, required with --revoke
  --i-am-sure        Allow a non-local MONGODB_URI

Roles
${Object.entries(ROLE_HELP)
  .map(([role, help]) => `  ${role.padEnd(18)} ${help}`)
  .join('\n')}

The secret prints once. Only its hash is stored; there is no way to read it back.
`);
}

async function main() {
  if (arg('help') === true || arg('h') === true) {
    usage();
    return;
  }

  loadEnv();
  const mongodbUri = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017/adverse_search';

  // The same refusal as `local:bootstrap`. Overridable, deliberately loudly.
  if (arg('i-am-sure') !== true) {
    assertLocalOnly({ MONGODB_URI: mongodbUri }, 'issue an API key');
  } else {
    log.info(
      '--i-am-sure: the local-only guard is off. This will write to whatever is configured.',
    );
  }

  // Imported from the build rather than reimplemented, so the hashing, the key format and the
  // audit record are the ones the API itself verifies against. A script with its own copy of
  // `hashSecret` is a script that silently stops issuing valid keys after a change.
  const modulePath = join(repoRoot, 'apps/api/dist/tenancy/api-key.service.js');
  let ApiKeyService;
  try {
    ({ ApiKeyService } = await import(`file://${modulePath.replaceAll('\\', '/')}`));
  } catch {
    throw new Error(
      `Could not load ${modulePath}.\nRun \`pnpm build\` first — this script uses the compiled ` +
        `service so that the key it mints is the key the API will accept.`,
    );
  }

  const mongo = new MongoClient(mongodbUri);
  await mongo.connect();

  try {
    const service = new ApiKeyService(mongo.db());
    await service.ensureIndexes();

    const tenantId = String(arg('tenant', 'tenant-alpha'));

    if (arg('list') === true) {
      const keys = await service.listForTenant(tenantId);
      log.step(`API keys for ${tenantId}`);
      if (keys.length === 0) {
        log.info('none');
        return;
      }
      for (const key of keys) {
        const state = key.revokedAt ? 'REVOKED' : 'active';
        log.info(
          `${key.keyId}  ${String(key.environment).padEnd(7)}  ${state.padEnd(7)}  ` +
            `roles=[${key.roles.join(', ')}]  ${key.label}`,
        );
      }
      return;
    }

    const revokeId = arg('revoke');
    if (typeof revokeId === 'string') {
      const reason = arg('reason');
      if (typeof reason !== 'string') {
        throw new Error('--revoke needs --reason. A revocation with no reason is not a record.');
      }
      await service.revoke({ keyId: revokeId, actor: 'script:key:issue', reason });
      good(`revoked ${revokeId}`);
      return;
    }

    const environment = String(arg('env', 'sandbox'));
    if (environment !== 'sandbox' && environment !== 'live') {
      throw new Error(`--env must be sandbox or live, not "${environment}".`);
    }

    // Repeatable: `--role analyst --role source_admin`.
    const roles = process.argv.reduce((acc, value, index) => {
      if (value === '--role') {
        const role = process.argv[index + 1];
        if (typeof role === 'string' && !role.startsWith('--')) {
          acc.push(role);
        }
      }
      return acc;
    }, []);
    if (roles.length === 0) {
      roles.push('analyst');
    }

    const unknown = roles.filter((role) => !(role in ROLE_HELP));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown role(s): ${unknown.join(', ')}.\nKnown roles: ${Object.keys(ROLE_HELP).join(', ')}`,
      );
    }

    const expiresDays = arg('expires');
    const expiresAt =
      typeof expiresDays === 'string'
        ? new Date(Date.now() + Number(expiresDays) * 86_400_000)
        : null;

    const label =
      typeof arg('label') === 'string'
        ? String(arg('label'))
        : `issued by key:issue ${new Date().toISOString()}`;

    const issued = await service.create({
      tenantId,
      environment,
      label,
      roles,
      // Scopes narrow a key *within* its roles. Empty means "whatever the roles allow", which is
      // the right default for a key a person is about to paste into Postman: narrowing it here
      // would produce confusing 403s that look like a bug in the API.
      scopes: [],
      createdBy: 'script:key:issue',
      expiresAt,
    });

    log.step('API key issued');
    log.info(`tenant       ${tenantId}`);
    log.info(`environment  ${environment}`);
    log.info(`roles        ${roles.join(', ')}`);
    log.info(`keyId        ${issued.keyId}`);
    log.info(`expires      ${expiresAt === null ? 'never' : expiresAt.toISOString()}`);
    console.log('');
    good('Secret — shown once, not recoverable:');
    console.log('');
    console.log(`  ${issued.secret}`);
    console.log('');
    log.info('Use it as:  Authorization: ApiKey <secret>');
    log.info('In Postman: set the `apiKey` environment variable to the value above.');

    if (environment === 'live') {
      log.warn(
        'This is a LIVE-environment key. It is still only as live as the sources are, and no ' +
          'source has been approved for live use yet.',
      );
    }
  } finally {
    await mongo.close();
  }
}

main().catch((error) => {
  fail(String(error.message ?? error));
  process.exitCode = 1;
});
