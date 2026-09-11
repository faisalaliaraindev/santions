/**
 * T68 and T62 — the API key lifecycle, through the real API and the real database.
 *
 * The claims under test are the ones a tenant would be told when they are handed a key: the
 * secret is shown once and cannot be recovered, rotation kills the previous secret, revocation
 * is immediate, both are audited, and a sandbox key cannot reach live data no matter what its
 * roles say.
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG, MONGO_CLIENT } from '../../apps/api/src/app.module.js';
import { TokenVerifier } from '../../apps/api/src/auth/token-verifier.js';
import { loadConfig } from '../../apps/api/src/config/config.js';
import {
  ApiKeyError,
  ApiKeyService,
  type IssuedApiKey,
  type KeyEnvironment,
} from '../../apps/api/src/tenancy/api-key.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const ISSUER = 'https://issuer.test/realms/adverse-search';
const AUDIENCE = 'adverse-search-api';

/**
 * Tenants `pnpm local:bootstrap` seeds, with an active entitlement, taxonomy and policy.
 *
 * Used wherever a test creates a search. Inventing a tenant would fail on a missing taxonomy
 * version — a 422 that says nothing about the key under test, and would make a green result
 * here meaningless.
 */
const SEEDED_TENANT = 'tenant-alpha';
const OTHER_SEEDED_TENANT = 'tenant-beta';

let app: INestApplication;
let apiKeys: ApiKeyService;
let mongo: MongoClient;

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ADVERSE_SEARCH_MODE: 'mock',
  MONGODB_URI,
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: 'adverse-search-panel',
  OIDC_CLIENT_SECRET: 'test-only-secret-value',
  OIDC_AUDIENCE: AUDIENCE,
  SESSION_SECRET: 'test-only-session-secret-value',
  SESSION_COOKIE_SECURE: 'false',
  CORS_ORIGINS: '',
};

async function issue(
  overrides: {
    readonly environment?: KeyEnvironment;
    readonly tenantId?: string;
    readonly scopes?: readonly string[];
    readonly expiresAt?: Date | null;
  } = {},
): Promise<IssuedApiKey & { tenantId: string }> {
  const tenantId = overrides.tenantId ?? `tenant-${randomUUID()}`;
  const issued = await apiKeys.create({
    tenantId,
    environment: overrides.environment ?? 'sandbox',
    label: 'integration test key',
    roles: ['analyst'],
    scopes: overrides.scopes ?? ['search:read', 'search:write'],
    createdBy: 'operator@erly.test',
    expiresAt: overrides.expiresAt ?? null,
  });
  return { ...issued, tenantId };
}

function subjectPayload(name = 'Diego Alberto Solís Ramírez') {
  return {
    fullName: name,
    aliases: [],
    countryContext: ['CR'],
    knownCompanies: [],
    purpose: 'CUSTOMER_ONBOARDING' as const,
  };
}

function searchPayload(
  subjectId: string,
  version: number,
  environment: KeyEnvironment = 'sandbox',
) {
  return {
    subjectRef: { subjectId, version },
    requestedScope: {
      jurisdictions: ['CR'],
      languages: ['es'],
      includeFormerDirectorships: false,
      fromDate: null,
    },
    environment,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };

  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(
      `The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap\n\n${String(error)}`,
    );
  }

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(TEST_ENV))
    .overrideProvider(TokenVerifier)
    .useValue(
      new TokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        keyResolver: createLocalJWKSet({ keys: [publicJwk] }),
      }),
    )
    .compile();

  app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });
  app.use(cookieParser());
  await app.init();

  apiKeys = app.get(ApiKeyService);
}, 90_000);

afterAll(async () => {
  await app?.close();
  await mongo?.close();
  try {
    await app?.get<MongoClient>(MONGO_CLIENT).close();
  } catch {
    // Already closed by app.close().
  }
});

describe('T68 — the secret is shown once and stored hashed', () => {
  it('stores no part of the secret, in any field', async () => {
    const key = await issue();
    const stored = await mongo.db().collection('apiKeyCredentials').findOne({ keyId: key.keyId });

    expect(stored).not.toBeNull();
    // The whole credential, and the secret half on its own. A database dump must not
    // authenticate as the tenant.
    const secretHalf = key.secret.split('_').at(-1) ?? '';
    expect(JSON.stringify(stored)).not.toContain(key.secret);
    expect(JSON.stringify(stored)).not.toContain(secretHalf);
    expect(stored?.['secretHash']).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('offers no way to read a secret back', async () => {
    const key = await issue();

    // Listing is the closest thing to a "show me the key" API, and it must not carry a hash
    // either — a credential-shaped field ends up in a screenshot or a support ticket.
    const listed = await apiKeys.listForTenant(key.tenantId);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(key.secret);
    expect(Object.keys(listed[0] ?? {})).not.toContain('secretHash');
    expect(listed[0]?.keyId).toBe(key.keyId);
  });

  it('names the environment in the credential itself', async () => {
    // So an operator who pastes a live key into a sandbox configuration can see the mistake.
    const sandbox = await issue({ environment: 'sandbox' });
    const live = await issue({ environment: 'live' });

    expect(sandbox.secret.startsWith('erly_sandbox_')).toBe(true);
    expect(live.secret.startsWith('erly_live_')).toBe(true);
  });
});

describe('T68 — a key authenticates, and a broken one does not', () => {
  it('authenticates a machine caller and records last use', async () => {
    const key = await issue();

    const before = await mongo.db().collection('apiKeyCredentials').findOne({ keyId: key.keyId });
    expect(before?.['lastUsedAt']).toBeNull();

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send(subjectPayload());

    expect(response.status).toBe(201);

    // Last use is what makes an unused key identifiable, and therefore safe to revoke.
    const after = await mongo.db().collection('apiKeyCredentials').findOne({ keyId: key.keyId });
    expect(after?.['lastUsedAt']).toBeInstanceOf(Date);
  });

  it('needs no CSRF token, because a browser cannot send this header by itself', async () => {
    const key = await issue();

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send(subjectPayload('Sociedad Anónima Demo'));

    expect(response.status).toBe(201);
  });

  it('rejects a tampered secret without saying which half was wrong', async () => {
    const key = await issue();
    const tampered = `${key.secret.slice(0, -1)}${key.secret.endsWith('A') ? 'B' : 'A'}`;

    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${tampered}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(response.body)).not.toMatch(/secret|unknown|revoked|expired/i);
  });

  it('rejects a key whose environment has been edited', async () => {
    // The most plausible tampering: a sandbox key rewritten to claim live. It must fail even
    // though the key ID and secret are genuine.
    const key = await issue({ environment: 'sandbox' });
    const escalated = key.secret.replace('erly_sandbox_', 'erly_live_');

    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${escalated}`);

    expect(response.status).toBe(401);
  });

  it('rejects an expired key', async () => {
    const key = await issue({ expiresAt: new Date(Date.now() - 1_000) });

    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${key.secret}`);

    expect(response.status).toBe(401);
  });

  it('does not treat an API key as a bearer token, or the reverse', async () => {
    // Sharing one scheme would mean every failure is attempted against both verifiers, and the
    // logs would stop saying which credential the caller meant.
    const key = await issue();

    const asBearer = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `Bearer ${key.secret}`);

    expect(asBearer.status).toBe(401);
  });
});

describe('T68 — rotation and revocation are audited', () => {
  it('invalidates the previous secret on rotation, with no grace period', async () => {
    const key = await issue();

    await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${key.secret}`)
      .expect(200);

    const rotated = await apiKeys.rotate({
      keyId: key.keyId,
      actor: 'operator@erly.test',
      reason: 'suspected exposure in a build log',
    });

    // The key keeps its identity, so the tenant's configuration does not change.
    expect(rotated.keyId).toBe(key.keyId);
    expect(rotated.secret).not.toBe(key.secret);

    await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${rotated.secret}`)
      .expect(200);

    // The old one stops working immediately. A rotation that leaves the previous secret valid
    // is not a rotation — and the usual reason to rotate is that it must not be valid.
    const old = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${key.secret}`);
    expect(old.status).toBe(401);
  });

  it('refuses immediately after revocation', async () => {
    const key = await issue();
    await apiKeys.revoke({
      keyId: key.keyId,
      actor: 'operator@erly.test',
      reason: 'tenant offboarded',
    });

    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${key.secret}`);

    expect(response.status).toBe(401);
  });

  it('will not rotate a revoked key back into service', async () => {
    const key = await issue();
    await apiKeys.revoke({ keyId: key.keyId, actor: 'operator@erly.test', reason: 'offboarded' });

    await expect(
      apiKeys.rotate({ keyId: key.keyId, actor: 'operator@erly.test', reason: 'oops' }),
    ).rejects.toBeInstanceOf(ApiKeyError);
  });

  it('writes an audit entry for creation, rotation and revocation, each with actor and reason', () => {
    return (async () => {
      const key = await issue();
      await apiKeys.rotate({
        keyId: key.keyId,
        actor: 'alice@erly.test',
        reason: 'quarterly rotation',
      });
      await apiKeys.revoke({
        keyId: key.keyId,
        actor: 'bob@erly.test',
        reason: 'contract ended',
      });

      const audit = await apiKeys.auditFor(key.keyId);
      expect(audit.map((entry) => entry.event)).toEqual(['REVOKED', 'ROTATED', 'CREATED']);

      const revoked = audit.find((entry) => entry.event === 'REVOKED');
      const rotated = audit.find((entry) => entry.event === 'ROTATED');

      // An unexplained revocation is indistinguishable from an outage when somebody
      // investigates it three months later.
      expect(revoked?.actor).toBe('bob@erly.test');
      expect(revoked?.reason).toBe('contract ended');
      expect(rotated?.actor).toBe('alice@erly.test');
      expect(rotated?.reason).toBe('quarterly rotation');
    })();
  });

  it('is idempotent on a second revocation, and does not double-audit it', async () => {
    const key = await issue();
    await apiKeys.revoke({ keyId: key.keyId, actor: 'operator@erly.test', reason: 'first' });
    await apiKeys.revoke({ keyId: key.keyId, actor: 'operator@erly.test', reason: 'second' });

    const audit = await apiKeys.auditFor(key.keyId);
    expect(audit.filter((entry) => entry.event === 'REVOKED')).toHaveLength(1);
    expect(audit.find((entry) => entry.event === 'REVOKED')?.reason).toBe('first');
  });
});

describe('T62 — a sandbox key cannot reach live data', () => {
  it('refuses a live search from a sandbox key, as an entitlement denial', async () => {
    const key = await issue({ environment: 'sandbox', tenantId: SEEDED_TENANT });

    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send(subjectPayload())
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send(searchPayload(subject.body.subjectId, subject.body.version, 'live'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SANDBOX_CANNOT_ACCESS_LIVE');
    // Not a rate limit and not a coverage gap: retrying can never help (REL-02).
    expect(response.body.retryable).toBe(false);
  });

  it('allows the same sandbox search', async () => {
    const key = await issue({ environment: 'sandbox', tenantId: SEEDED_TENANT });

    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send(subjectPayload())
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send(searchPayload(subject.body.subjectId, subject.body.version, 'sandbox'));

    expect(response.status).toBe(202);
  });

  it('keeps a key inside its own tenant', async () => {
    const mine = await issue({ tenantId: SEEDED_TENANT });
    const theirs = await issue({ tenantId: OTHER_SEEDED_TENANT });

    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `ApiKey ${theirs.secret}`)
      .send(subjectPayload())
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/v1/subjects/${String(subject.body.subjectId)}/versions/1`)
      .set('Authorization', `ApiKey ${mine.secret}`);

    // Indistinguishable from a missing record, so another tenant's ID space cannot be mapped.
    expect(response.status).toBe(404);
  });

  it('honours the scopes on the key, not only its roles', async () => {
    const readOnly = await issue({ scopes: ['search:read'], tenantId: SEEDED_TENANT });

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `ApiKey ${readOnly.secret}`)
      .send(subjectPayload());

    // `POST /v1/subjects` declares a permission but no scope, so this key still creates one.
    expect(response.status).toBe(201);

    const search = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `ApiKey ${readOnly.secret}`)
      .send(searchPayload('sub_does_not_matter', 1));

    expect(search.status).toBe(403);
    expect(search.body.code).toBe('FORBIDDEN');
  });
});
