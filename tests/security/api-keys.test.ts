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
  type ApiKeyRejection,
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

describe('self-service key issuance (D-050) cannot become a way to get more', () => {
  /** A tenant_admin key, which is what a tenant would actually hold to manage its own keys. */
  async function tenantAdminKey(
    environment: KeyEnvironment = 'sandbox',
    tenantId = `tenant-${randomUUID()}`,
  ): Promise<IssuedApiKey & { tenantId: string }> {
    const issued = await apiKeys.create({
      tenantId,
      environment,
      label: 'tenant admin, self-service tests',
      roles: ['tenant_admin'],
      scopes: ['search:read', 'admin:read', 'admin:write'],
      createdBy: 'operator@erly.test',
      expiresAt: null,
    });
    return { ...issued, tenantId };
  }

  it('issues a key, and returns the secret exactly once', async () => {
    const admin = await tenantAdminKey();

    const created = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ label: 'issued by the tenant itself', roles: ['tenant_admin'] })
      .expect(201);

    expect(created.body.secret).toMatch(/^erly_sandbox_/);
    expect(created.body.warning).toContain('shown once');

    // The listing is the only other place a key appears, and it must not carry the secret — nor
    // a hash of it, which is just a slower way of handing the same thing over.
    const listed = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .expect(200);

    const mine = listed.body.items.find(
      (item: { keyId: string }) => item.keyId === created.body.keyId,
    );
    expect(mine).toBeDefined();
    expect(mine.status).toBe('ACTIVE');
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    expect(JSON.stringify(listed.body)).not.toContain('secretHash');
  });

  it('refuses to mint a role the caller does not hold', async () => {
    // The whole point. Without this a tenant_admin is a path to platform_admin and the role
    // model is decoration.
    const admin = await tenantAdminKey();

    const response = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ label: 'escalation attempt', roles: ['platform_admin'] })
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
    expect(response.body.message).toContain('platform_admin');
  });

  it('refuses a live key from a sandbox credential', async () => {
    const admin = await tenantAdminKey('sandbox');

    const response = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ label: 'live from sandbox', roles: ['tenant_admin'], environment: 'live' })
      .expect(403);

    expect(response.body.code).toBe('SANDBOX_CANNOT_ACCESS_LIVE');
  });

  it('refuses a live key when the tenant is not entitled to live', async () => {
    // A live *credential* is not enough. Entitlement is sold by the provider, and self-service
    // issues within what was sold rather than granting it.
    const admin = await tenantAdminKey('live');

    const response = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ label: 'live, unentitled tenant', roles: ['tenant_admin'], environment: 'live' })
      .expect(403);

    // Either entitlement denial is correct and which one depends on how far the tenant got:
    // this tenant has no entitlement record at all, so the capability check refuses before the
    // environment check is reached. What matters is that a live credential alone did not buy
    // live access.
    expect(['SANDBOX_CANNOT_ACCESS_LIVE', 'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN']).toContain(
      response.body.code,
    );
  });

  it('refuses a scope the requested roles could not use', async () => {
    const admin = await tenantAdminKey();

    // tenant_admin does not grant search:write, so a key claiming it would be wider than the
    // role it was issued under.
    const response = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({
        label: 'scope beyond role',
        roles: ['tenant_admin'],
        scopes: ['search:write'],
      })
      .expect(422);

    expect(response.body.code).toBe('INVALID_SCOPE');
  });

  it("will not revoke another tenant's key, and does not confirm it exists", async () => {
    const admin = await tenantAdminKey();
    const somebodyElse = await issue();

    const response = await request(app.getHttpServer())
      .delete(`/v1/tenant/api-keys/${somebodyElse.keyId}`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'not mine to revoke' })
      .expect(404);

    // NOT_FOUND rather than FORBIDDEN: the second confirms the key exists.
    expect(response.body.code).toBe('NOT_FOUND');

    // And it really is untouched.
    const principal = await apiKeys.verify(somebodyElse.secret);
    expect(principal.tenantId).toBe(somebodyElse.tenantId);
  });

  it('revokes its own key immediately, and the key stops working', async () => {
    const admin = await tenantAdminKey();

    const created = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ label: 'to be revoked', roles: ['tenant_admin'] })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/v1/tenant/api-keys/${created.body.keyId}`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'rotated during the security suite' })
      .expect(200);

    await expect(apiKeys.verify(created.body.secret)).rejects.toThrow(ApiKeyError);
  });

  it('refuses an anonymous caller, and one without the permission', async () => {
    await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .send({ label: 'nobody at all', roles: ['analyst'] })
      .expect(401);

    // An analyst key has no apikey:manage. Issuing keys is not part of running searches.
    const analyst = await issue();
    await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${analyst.secret}`)
      .send({ label: 'analyst trying to issue', roles: ['analyst'] })
      .expect(403);
  });
});

/**
 * I4 — a reversible off switch that is not revocation.
 *
 * The claim under test is a pair of opposites, and both halves have to hold at once:
 * disabling stops a key exactly as revoking does, and unlike revoking it can be undone. If the
 * two ever share a field, one of those halves breaks — either a leaked secret can be switched
 * back on, or pausing an integration destroys the credential.
 *
 * So most of what follows is about the seam between them: that revocation survives every route
 * which could plausibly reverse it, and that disabling reverses cleanly.
 */
describe('I4 — disable is reversible, revoke is not, and they are different fields', () => {
  /** A tenant_admin key, which is what a tenant would hold to manage its own keys. */
  async function tenantAdminKey(
    tenantId = `tenant-${randomUUID()}`,
  ): Promise<IssuedApiKey & { tenantId: string }> {
    const issued = await apiKeys.create({
      tenantId,
      environment: 'sandbox',
      label: 'tenant admin, disable/enable tests',
      roles: ['tenant_admin'],
      scopes: ['search:read', 'admin:read', 'admin:write'],
      createdBy: 'operator@erly.test',
      expiresAt: null,
    });
    return { ...issued, tenantId };
  }

  /** The rejection `verify` raises, or a failure if it accepted the key. */
  async function rejectionFor(secret: string): Promise<ApiKeyRejection> {
    try {
      await apiKeys.verify(secret);
    } catch (error) {
      if (error instanceof ApiKeyError) {
        return error.rejection;
      }
      throw error;
    }
    throw new Error('Expected the key to be refused, and it was accepted.');
  }

  it('refuses a disabled key, and says DISABLED rather than REVOKED', async () => {
    const key = await issue();
    await apiKeys.disable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'paused' });

    expect(await rejectionFor(key.secret)).toBe('DISABLED');

    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `ApiKey ${key.secret}`);
    // The caller still gets one opaque 401. The distinction is for the audit trail and the
    // listing, not for whoever is holding the key.
    expect(response.status).toBe(401);
  });

  it('brings the same secret back on enable, with no re-issue', async () => {
    const key = await issue();
    await apiKeys.disable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'paused' });
    await apiKeys.enable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'resumed' });

    // Same secret, same key id: a tenant configuration holding it needs no edit. This is the
    // whole difference from revocation, which would force a new credential.
    const principal = await apiKeys.verify(key.secret);
    expect(principal.tenantId).toBe(key.tenantId);
    expect(principal.subject).toBe(`api-key:${key.keyId}`);
  });

  it('leaves revokedAt untouched when disabling, and keeps the two fields apart', async () => {
    const key = await issue();
    await apiKeys.disable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'paused' });

    const keys = mongo.db().collection('apiKeyCredentials');
    const disabled = await keys.findOne({ keyId: key.keyId });
    expect(disabled?.['disabledAt']).toBeInstanceOf(Date);
    expect(disabled?.['disabledReason']).toBe('paused');
    // If this is ever not null, disable has become revoke and the reversible half is a lie.
    expect(disabled?.['revokedAt']).toBeNull();

    await apiKeys.revoke({ keyId: key.keyId, actor: 'bob@erly.test', reason: 'leaked after all' });
    const revoked = await keys.findOne({ keyId: key.keyId });
    // Revoking a paused key is a real sequence — "paused" turning out to be "compromised" — and
    // it does not un-happen the pause.
    expect(revoked?.['revokedAt']).toBeInstanceOf(Date);
    expect(revoked?.['disabledAt']).toBeInstanceOf(Date);
  });

  it('will not enable a revoked key back into service', async () => {
    const key = await issue();
    await apiKeys.revoke({ keyId: key.keyId, actor: 'bob@erly.test', reason: 'leaked' });

    await expect(
      apiKeys.enable({ keyId: key.keyId, actor: 'bob@erly.test', reason: 'we changed our minds' }),
    ).rejects.toBeInstanceOf(ApiKeyError);

    // And it is still refused, for the reason it was refused before.
    expect(await rejectionFor(key.secret)).toBe('REVOKED');
  });

  it('will not disable a revoked key, because that would imply enable could undo it', async () => {
    const key = await issue();
    await apiKeys.revoke({ keyId: key.keyId, actor: 'bob@erly.test', reason: 'leaked' });

    await expect(
      apiKeys.disable({ keyId: key.keyId, actor: 'bob@erly.test', reason: 'pause it' }),
    ).rejects.toBeInstanceOf(ApiKeyError);
  });

  it('rotates a disabled key without turning it back on', async () => {
    // Disable, replace the secret, enable is the ordinary rotation sequence. Rotation replaces
    // a secret; it is neither an off switch nor an on switch.
    const key = await issue();
    await apiKeys.disable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'rotating' });

    const rotated = await apiKeys.rotate({
      keyId: key.keyId,
      actor: 'alice@erly.test',
      reason: 'rotating',
    });
    expect(rotated.secret).not.toBe(key.secret);
    expect(await rejectionFor(rotated.secret)).toBe('DISABLED');

    await apiKeys.enable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'rotation done' });
    await expect(apiKeys.verify(rotated.secret)).resolves.toBeDefined();
    // The pre-rotation secret is gone for good, enabled or not.
    expect(await rejectionFor(key.secret)).toBe('BAD_SECRET');
  });

  it('is idempotent both ways, and does not audit a change that did not happen', async () => {
    const key = await issue();
    await apiKeys.disable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'first' });
    await apiKeys.disable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'second' });
    await apiKeys.enable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'back on' });
    await apiKeys.enable({ keyId: key.keyId, actor: 'alice@erly.test', reason: 'back on again' });

    const audit = await apiKeys.auditFor(key.keyId);
    expect(audit.filter((entry) => entry.event === 'DISABLED')).toHaveLength(1);
    expect(audit.filter((entry) => entry.event === 'ENABLED')).toHaveLength(1);
    // The trail says when it actually went off, not when somebody last clicked.
    expect(audit.find((entry) => entry.event === 'DISABLED')?.reason).toBe('first');
  });

  it('audits both events with an actor and a reason', async () => {
    const key = await issue();
    await apiKeys.disable({
      keyId: key.keyId,
      actor: 'alice@erly.test',
      reason: 'integration paused',
    });
    await apiKeys.enable({
      keyId: key.keyId,
      actor: 'bob@erly.test',
      reason: 'integration resumed',
    });

    const audit = await apiKeys.auditFor(key.keyId);
    expect(audit.map((entry) => entry.event)).toEqual(['ENABLED', 'DISABLED', 'CREATED']);
    expect(audit.find((entry) => entry.event === 'DISABLED')?.actor).toBe('alice@erly.test');
    expect(audit.find((entry) => entry.event === 'ENABLED')?.actor).toBe('bob@erly.test');
    expect(audit.find((entry) => entry.event === 'ENABLED')?.reason).toBe('integration resumed');
  });

  it('treats a key written before disabledAt existed as enabled, not as disabled', async () => {
    // Records created by earlier versions have no `disabledAt` at all, and `undefined !== null`
    // would refuse every one of them. This is the check that deploying I4 does not lock out
    // every key already in the database.
    const key = await issue();
    await mongo
      .db()
      .collection('apiKeyCredentials')
      .updateOne({ keyId: key.keyId }, { $unset: { disabledAt: '', disabledReason: '' } });

    await expect(apiKeys.verify(key.secret)).resolves.toBeDefined();
  });

  it('disables and re-enables its own key over HTTP, and the listing says which it is', async () => {
    const admin = await tenantAdminKey();

    const created = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ label: 'to be paused', roles: ['tenant_admin'] })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${created.body.keyId}/disable`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'integration paused for the afternoon' })
      .expect(200);

    expect(await rejectionFor(created.body.secret)).toBe('DISABLED');

    const paused = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .expect(200);
    const off = paused.body.items.find(
      (item: { keyId: string }) => item.keyId === created.body.keyId,
    );
    expect(off.status).toBe('DISABLED');
    expect(off.disabledAt).not.toBeNull();
    expect(off.disabledReason).toBe('integration paused for the afternoon');
    expect(off.revokedAt).toBeNull();

    await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${created.body.keyId}/enable`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'integration resumed' })
      .expect(200);

    await expect(apiKeys.verify(created.body.secret)).resolves.toBeDefined();

    const back = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .expect(200);
    const on = back.body.items.find((item: { keyId: string }) => item.keyId === created.body.keyId);
    expect(on.status).toBe('ACTIVE');
    // Cleared, not left behind: a stale reason on a working key reads as though it were still
    // off. The record of why it was paused lives in the audit trail, which keeps both events.
    expect(on.disabledAt).toBeNull();
    expect(on.disabledReason).toBeNull();
  });

  it('reports a key that is both expired and paused as EXPIRED, and still shows the pause', async () => {
    // `status` can only name one reason, so it names the one the holder must act on: enabling
    // an expired key would not make it work. `disabledAt` is still there to say it was paused.
    const admin = await tenantAdminKey();
    const expired = await issue({
      tenantId: admin.tenantId,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await apiKeys.disable({ keyId: expired.keyId, actor: 'alice@erly.test', reason: 'paused' });

    const listed = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .expect(200);
    const item = listed.body.items.find(
      (candidate: { keyId: string }) => candidate.keyId === expired.keyId,
    );
    expect(item.status).toBe('EXPIRED');
    expect(item.disabledAt).not.toBeNull();
  });

  it('answers 409 rather than reviving a revoked key, on both routes', async () => {
    const admin = await tenantAdminKey();

    const created = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ label: 'to be revoked', roles: ['tenant_admin'] })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/v1/tenant/api-keys/${created.body.keyId}`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'secret pasted into a public ticket' })
      .expect(200);

    const enabled = await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${created.body.keyId}/enable`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'it was only a test ticket' })
      .expect(409);
    expect(enabled.body.code).toBe('ALREADY_TERMINAL');

    const disabled = await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${created.body.keyId}/disable`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'trying the other route' })
      .expect(409);
    expect(disabled.body.code).toBe('ALREADY_TERMINAL');

    expect(await rejectionFor(created.body.secret)).toBe('REVOKED');
  });

  it("will not disable another tenant's key, and does not confirm it exists", async () => {
    const admin = await tenantAdminKey();
    const somebodyElse = await issue();

    const response = await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${somebodyElse.keyId}/disable`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({ reason: 'not mine to pause' })
      .expect(404);

    // NOT_FOUND rather than FORBIDDEN: the second confirms the key exists. Without this check a
    // guessed keyId is an off switch for somebody else's production integration.
    expect(response.body.code).toBe('NOT_FOUND');
    await expect(apiKeys.verify(somebodyElse.secret)).resolves.toBeDefined();
  });

  it('refuses an anonymous caller, and one without apikey:manage', async () => {
    const key = await issue();

    await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${key.keyId}/disable`)
      .send({ reason: 'nobody at all' })
      .expect(401);

    // An analyst key has no apikey:manage. Pausing a credential is not part of running searches.
    const analyst = await issue();
    await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${key.keyId}/disable`)
      .set('Authorization', `ApiKey ${analyst.secret}`)
      .send({ reason: 'analyst trying to pause a key' })
      .expect(403);

    await expect(apiKeys.verify(key.secret)).resolves.toBeDefined();
  });

  it('requires a reason, because a key that stopped working with no record is an outage', async () => {
    const admin = await tenantAdminKey();

    await request(app.getHttpServer())
      .post(`/v1/tenant/api-keys/${admin.keyId}/disable`)
      .set('Authorization', `ApiKey ${admin.secret}`)
      .send({})
      .expect(400);
  });
});
