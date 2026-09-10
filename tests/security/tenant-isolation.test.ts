/**
 * T04, T05, T06, T22, T23, T62, T63 — against the real API and the real database.
 *
 * These are the tests Phase B exists to make pass. They are not unit tests with a mocked
 * repository: the whole point is that tenant isolation holds through the HTTP layer, the
 * guards, the services and the queries together. A mocked repository would prove that the
 * mock returns what it was told to.
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';
import { VersioningType, type INestApplication } from '@nestjs/common';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG, MONGO_CLIENT } from '../../apps/api/src/app.module.js';
import { TokenVerifier } from '../../apps/api/src/auth/token-verifier.js';
import { loadConfig } from '../../apps/api/src/config/config.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const ISSUER = 'https://issuer.test/realms/adverse-search';
const AUDIENCE = 'adverse-search-api';

let app: INestApplication;
let privateKey: KeyLike;
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

async function token(options: {
  readonly tenantId?: string | undefined;
  readonly roles: readonly string[];
  readonly environment?: 'sandbox' | 'live';
  readonly scope?: string;
  readonly subject?: string;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    realm_access: { roles: options.roles },
    environment: options.environment ?? 'sandbox',
    scope: options.scope ?? 'search:read search:write',
  };
  if (options.tenantId !== undefined) {
    payload['tenant_id'] = options.tenantId;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(options.subject ?? 'test-user')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

function subjectPayload(name = 'Rhys Mordaunt') {
  return {
    fullName: name,
    aliases: [],
    countryContext: ['GB'],
    knownCompanies: [],
    purpose: 'CUSTOMER_ONBOARDING' as const,
  };
}

function searchPayload(
  subjectId: string,
  version: number,
  environment: 'sandbox' | 'live' = 'sandbox',
) {
  return {
    subjectRef: { subjectId, version },
    requestedScope: {
      jurisdictions: ['GB'],
      languages: ['en'],
      includeFormerDirectorships: false,
      fromDate: null,
    },
    environment,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
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
    // The only override: a local key set instead of fetching JWKS over the network. The
    // verifier itself, and every check it performs, is the real one.
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
  await app.init();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await mongo?.close();
  // The app opens its own Mongo client through the module; close it too.
  try {
    await app?.get<MongoClient>(MONGO_CLIENT).close();
  } catch {
    // Already closed by app.close(); nothing to do.
  }
});

describe('T03 — unauthenticated access', () => {
  it('rejects a request with no credential, without disclosing anything', async () => {
    const response = await request(app.getHttpServer()).get('/v1/searches');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    // The body must not say which check failed.
    expect(JSON.stringify(response.body)).not.toMatch(/signature|issuer|audience|jwks/i);
  });

  it('rejects a forged token', async () => {
    const forged = await new SignJWT({ realm_access: { roles: ['platform_admin'] } })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('attacker')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('10m')
      .sign((await generateKeyPair('RS256')).privateKey);

    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `Bearer ${forged}`);
    expect(response.status).toBe(401);
  });

  it('leaves health endpoints public but keeps dependency detail authorised', async () => {
    expect((await request(app.getHttpServer()).get('/health/live')).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/health/ready')).status).toBe(200);
    // Detailed dependency state is operator-only (section 6.1).
    expect((await request(app.getHttpServer()).get('/v1/health/dependencies')).status).toBe(401);
  });
});

describe('T04 / T05 — tenant isolation across the HTTP surface', () => {
  it('denies tenant beta access to a search created by tenant alpha', async () => {
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const beta = await token({ tenantId: 'tenant-beta', roles: ['analyst'] });

    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${alpha}`)
      .send(subjectPayload());
    expect(subject.status).toBe(201);

    const created = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${alpha}`)
      .send(searchPayload(subject.body.subjectId, subject.body.version));
    expect(created.status).toBe(202);

    // Beta knows the exact ID and is a legitimate analyst in its own tenant.
    const stolen = await request(app.getHttpServer())
      .get(`/v1/searches/${created.body.searchId}`)
      .set('Authorization', `Bearer ${beta}`);

    expect(stolen.status).toBe(404);
    // Non-enumerating: a cross-tenant read is indistinguishable from a missing record, so the
    // ID space of another tenant cannot be mapped by watching status codes.
    expect(stolen.body.code).toBe('NOT_FOUND');
  });

  it("denies tenant beta access to alpha's subject", async () => {
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const beta = await token({ tenantId: 'tenant-beta', roles: ['analyst'] });

    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${alpha}`)
      .send(subjectPayload('Katarzyna Nowak'));

    const stolen = await request(app.getHttpServer())
      .get(`/v1/subjects/${subject.body.subjectId}/versions/1`)
      .set('Authorization', `Bearer ${beta}`);

    expect(stolen.status).toBe(404);
  });

  it('keeps two tenants isolated even with identical external references', async () => {
    // The specific case section 4.1 calls out: an external ref is a correlation aid, never a
    // lookup key and never an authorisation credential.
    const sharedRef = `case-${randomUUID()}`;
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const beta = await token({ tenantId: 'tenant-beta', roles: ['analyst'] });

    const a = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${alpha}`)
      .send({ ...subjectPayload('Shared Name'), externalSubjectRef: sharedRef });

    const b = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${beta}`)
      .send({ ...subjectPayload('Shared Name'), externalSubjectRef: sharedRef });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.subjectId).not.toBe(b.body.subjectId);

    // Neither can read the other's, despite the identical external reference.
    const crossed = await request(app.getHttpServer())
      .get(`/v1/subjects/${a.body.subjectId}/versions/1`)
      .set('Authorization', `Bearer ${beta}`);
    expect(crossed.status).toBe(404);
  });

  it("T05 — a client-supplied tenant header does not change the caller's tenant", async () => {
    const beta = await token({ tenantId: 'tenant-beta', roles: ['analyst'] });
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });

    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${alpha}`)
      .send(subjectPayload());

    const spoofed = await request(app.getHttpServer())
      .get(`/v1/subjects/${subject.body.subjectId}/versions/1`)
      .set('Authorization', `Bearer ${beta}`)
      .set('X-Tenant-Id', 'tenant-alpha')
      .set('x-tenant', 'tenant-alpha');

    expect(spoofed.status).toBe(404);
  });

  it('lists only the calling tenant’s searches', async () => {
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const listed = await request(app.getHttpServer())
      .get('/v1/searches?limit=100')
      .set('Authorization', `Bearer ${alpha}`);

    expect(listed.status).toBe(200);
    for (const item of listed.body.items) {
      expect(item.tenantId).toBe('tenant-alpha');
    }
  });
});

describe('T06 — role policy', () => {
  it('a viewer cannot create a search', async () => {
    const viewer = await token({ tenantId: 'tenant-alpha', roles: ['viewer'] });
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${viewer}`)
      .send(subjectPayload());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('a platform_operator cannot read customer searches', async () => {
    // The row that matters most: operating the platform is not permission to read what it
    // holds.
    const operator = await token({ tenantId: undefined, roles: ['platform_operator'] });
    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Authorization', `Bearer ${operator}`);

    expect(response.status).toBe(403);
  });

  it('a platform_operator can read dependency health', async () => {
    const operator = await token({ tenantId: undefined, roles: ['platform_operator'] });
    const response = await request(app.getHttpServer())
      .get('/v1/health/dependencies')
      .set('Authorization', `Bearer ${operator}`);

    expect(response.status).toBe(200);
  });

  it('an analyst cannot reach plan administration', async () => {
    const analyst = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const response = await request(app.getHttpServer())
      .get('/v1/admin/plans')
      .set('Authorization', `Bearer ${analyst}`);

    expect(response.status).toBe(403);
  });
});

describe('T22 / T23 — idempotency', () => {
  it('T22 — concurrent identical requests commit exactly one search', async () => {
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${alpha}`)
      .send(subjectPayload());

    const key = randomUUID();
    const body = searchPayload(subject.body.subjectId, subject.body.version);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/v1/searches')
          .set('Authorization', `Bearer ${alpha}`)
          .set('Idempotency-Key', key)
          .send(body),
      ),
    );

    const created = responses.filter((r) => r.status === 202 || r.status === 200);
    const ids = new Set(created.map((r) => r.body.searchId).filter(Boolean));

    // Exactly one search exists, whatever mix of 202 / 200 / 409-in-flight came back.
    expect(ids.size).toBe(1);

    const searchId = [...ids][0];
    const committed = await mongo.db().collection('searchRuns').countDocuments({ searchId });
    expect(committed).toBe(1);
  }, 30_000);

  it('T23 — the same key with a changed body is a 409', async () => {
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${alpha}`)
      .send(subjectPayload());

    const key = randomUUID();
    const first = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${alpha}`)
      .set('Idempotency-Key', key)
      .send(searchPayload(subject.body.subjectId, subject.body.version));
    expect(first.status).toBe(202);

    const changed = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${alpha}`)
      .set('Idempotency-Key', key)
      .send({
        ...searchPayload(subject.body.subjectId, subject.body.version),
        requestedScope: {
          jurisdictions: ['GB', 'US'],
          languages: ['en'],
          includeFormerDirectorships: false,
          fromDate: null,
        },
      });

    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY');
  });

  it('T23 — the same key in another tenant is an independent operation', async () => {
    const key = randomUUID();
    const alpha = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const beta = await token({ tenantId: 'tenant-beta', roles: ['analyst'] });

    const makeSearch = async (auth: string) => {
      const subject = await request(app.getHttpServer())
        .post('/v1/subjects')
        .set('Authorization', `Bearer ${auth}`)
        .send(subjectPayload());
      return request(app.getHttpServer())
        .post('/v1/searches')
        .set('Authorization', `Bearer ${auth}`)
        .set('Idempotency-Key', key)
        .send(searchPayload(subject.body.subjectId, subject.body.version));
    };

    const a = await makeSearch(alpha);
    const b = await makeSearch(beta);

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.searchId).not.toBe(b.body.searchId);
  });
});

describe('T62 / T63 — entitlements', () => {
  it('T62 — a sandbox credential cannot create a live search', async () => {
    const sandbox = await token({
      tenantId: 'tenant-alpha',
      roles: ['analyst'],
      environment: 'sandbox',
    });
    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${sandbox}`)
      .send(subjectPayload());

    const response = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${sandbox}`)
      .send(searchPayload(subject.body.subjectId, subject.body.version, 'live'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SANDBOX_CANNOT_ACCESS_LIVE');
    // Distinct from throttling and from a coverage gap (REL-02).
    expect(response.body.retryable).toBe(false);
  });

  it('T63 — a tenant without the capability is refused as an entitlement denial', async () => {
    const tenantId = `tenant-nocap-${randomUUID().slice(0, 8)}`;
    await mongo.db().collection('tenants').insertOne({
      tenantId,
      name: 'No capability (test)',
      environment: 'sandbox',
      mode: 'MOCK',
    });
    await mongo
      .db()
      .collection('tenantEntitlementVersions')
      .insertOne({
        tenantId,
        version: 1,
        capabilities: [],
        environments: ['sandbox'],
        status: 'ACTIVE',
        activatedAt: new Date().toISOString(),
        mode: 'MOCK',
      });

    try {
      const auth = await token({ tenantId, roles: ['analyst'] });
      const subject = await request(app.getHttpServer())
        .post('/v1/subjects')
        .set('Authorization', `Bearer ${auth}`)
        .send(subjectPayload());

      const before = await mongo.db().collection('searchRuns').countDocuments({ tenantId });

      const response = await request(app.getHttpServer())
        .post('/v1/searches')
        .set('Authorization', `Bearer ${auth}`)
        .send(searchPayload(subject.body.subjectId, subject.body.version));

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN');

      // "no source calls occur" — the run is never created, so nothing downstream can dispatch.
      const after = await mongo.db().collection('searchRuns').countDocuments({ tenantId });
      expect(after).toBe(before);
    } finally {
      // Always clean up: a tenant left behind by a failed assertion breaks unrelated suites
      // later, and the resulting failure points at the wrong test.
      await mongo.db().collection('tenants').deleteMany({ tenantId });
      await mongo.db().collection('tenantEntitlementVersions').deleteMany({ tenantId });
      await mongo.db().collection('subjectVersions').deleteMany({ tenantId });
    }
  });
});

describe('FR-01 — subject intake', () => {
  it('preserves the original script and stores derived forms alongside it', async () => {
    const auth = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${auth}`)
      .send(subjectPayload('Владимир Петров'));

    expect(response.status).toBe(201);
    // The original is untouched — a reviewer sees what was entered.
    expect(response.body.fullName).toBe('Владимир Петров');
    expect(response.body.normalised.scripts).toContain('Cyrillic');
    expect(response.body.normalised.folded).toBeTruthy();
  });

  it('does not invent a date of birth when none is supplied', async () => {
    const auth = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${auth}`)
      .send(subjectPayload());

    expect(response.body.dateOfBirth).toBeNull();
    // No measured distribution is loaded, so the prior is honestly null rather than guessed.
    expect(response.body.nameFrequencyPrior).toBeNull();
  });

  it('marks a client-supplied company as an unverified candidate', async () => {
    const auth = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${auth}`)
      .send({
        ...subjectPayload(),
        knownCompanies: [{ registrationNumber: '01234567', jurisdiction: 'GB' }],
      });

    expect(response.body.knownCompanies[0].verificationStatus).toBe('SUPPLIED_UNVERIFIED');
  });

  it('rejects unknown fields rather than silently dropping them', async () => {
    const auth = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${auth}`)
      // A typo that would otherwise mean screening someone with no date of birth.
      .send({ ...subjectPayload(), dateofBirth: { value: '1974-03-02', precision: 'DAY' } });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('UNKNOWN_FIELD');
  });

  it('requires a screening purpose', async () => {
    const auth = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const withoutPurpose: Record<string, unknown> = { ...subjectPayload() };
    delete withoutPurpose['purpose'];
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${auth}`)
      .send(withoutPurpose);

    expect(response.status).toBe(400);
  });
});

describe('FR-15 — reserved endpoints', () => {
  it('returns 501 with a documented reason, not a 404', async () => {
    const admin = await token({ tenantId: 'tenant-alpha', roles: ['platform_admin'] });
    const response = await request(app.getHttpServer())
      .get('/v1/admin/plans')
      .set('Authorization', `Bearer ${admin}`);

    expect(response.status).toBe(501);
    expect(response.body.code).toBe('NOT_IMPLEMENTED');
    // The gap is visible to an integrator rather than looking like a route to work around.
    expect(response.body.message).toMatch(/D-007/);
  });
});

describe('section 6.2 — a newly accepted search claims no result', () => {
  it('reports QUEUED / NOT_EVALUATED / UNKNOWN, never a clean result', async () => {
    const auth = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${auth}`)
      .send(subjectPayload());

    const created = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${auth}`)
      .send(searchPayload(subject.body.subjectId, subject.body.version));

    const search = await request(app.getHttpServer())
      .get(`/v1/searches/${created.body.searchId}`)
      .set('Authorization', `Bearer ${auth}`);

    expect(search.body.execution).toBe('QUEUED');
    // Nothing has run, so "no matches found" would be a lie.
    expect(search.body.findings).toBe('NOT_EVALUATED');
    expect(search.body.coverage).toBe('UNKNOWN');
    // No fabricated percentage (FR-14).
    expect(search.body.progress.cascadeRungReached).toBeNull();
  });

  it('pins every version needed to explain the result later', async () => {
    const auth = await token({ tenantId: 'tenant-alpha', roles: ['analyst'] });
    const subject = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${auth}`)
      .send(subjectPayload());

    const created = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${auth}`)
      .send(searchPayload(subject.body.subjectId, subject.body.version));

    const search = await request(app.getHttpServer())
      .get(`/v1/searches/${created.body.searchId}`)
      .set('Authorization', `Bearer ${auth}`);

    expect(search.body.pinnedVersions.taxonomyVersion).toBeGreaterThan(0);
    expect(search.body.pinnedVersions.policyVersion).toBeGreaterThan(0);
    expect(search.body.pinnedVersions.entitlementVersion).toBeGreaterThan(0);
    expect(search.body.pinnedVersions.bandingRulesVersion).toBeTruthy();
  });
});
