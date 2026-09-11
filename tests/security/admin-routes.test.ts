/**
 * Phase D step D1 — the administrative routes, through the real guards.
 *
 * The service-level properties (four-eyes, the SEC-05 gate, the lifecycle) are covered in
 * `tests/integration/admin-lifecycle.test.ts`. What is tested here is the part a service test
 * cannot see: that the HTTP layer does not hand an unauthorised caller a way in, and that
 * runtime source administration cannot be used to ship configuration the FR-05 rules forbid.
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
  readonly roles: readonly string[];
  readonly subject?: string;
}): Promise<string> {
  return new SignJWT({
    realm_access: { roles: options.roles },
    tenant_id: 'tenant-alpha',
    environment: 'sandbox',
    scope: 'admin:read admin:write',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(options.subject ?? 'admin-user')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

/** A well-formed source proposal, used as the baseline the invalid ones deviate from. */
function sourceBody(recordId: string, content: Record<string, unknown> = {}) {
  return {
    recordId,
    content: { sourceName: 'Test', connectorType: 'NEWS_DISCOVERY_RSS', ...content },
    rightsPolicy: {
      policyId: 'p1',
      jurisdiction: 'CR',
      permittedOperations: ['COLLECT'],
      permittedClassifications: ['PUBLISHED_CONTENT'],
      permittedIntendedUses: ['ADVERSE_SCREENING'],
      permittedCollectionMethods: ['PUBLISHED_FEED'],
      permittedRegions: ['us-east-1'],
      maxRetentionDays: 30,
      rawPersonalDataRetentionPermitted: true,
      approvalRequiredFor: [],
    },
    dataProfile: {
      jurisdiction: 'CR',
      classification: 'PUBLISHED_CONTENT',
      collectionMethod: 'PUBLISHED_FEED',
      intendedUse: 'ADVERSE_SCREENING',
      operations: ['COLLECT'],
      requestedRetentionDays: 30,
      retainsRawPersonalData: false,
      processingRegion: 'us-east-1',
      approval: null,
    },
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
  // Delete everything this suite wrote. It proposes against the seeded `tenant-alpha`, and a
  // suite that leaves records behind in shared fixture state makes some other file fail — which
  // is exactly how this one broke T55 the first time it ran.
  await mongo?.db().collection('sourceVersions').deleteMany({ proposedBy: 'admin-user' });
  await mongo?.db().collection('taxonomyVersions').deleteMany({ proposedBy: 'admin-user' });
  await mongo?.db().collection('policyVersions').deleteMany({ proposedBy: 'admin-user' });
  await mongo?.db().collection('auditEvents').deleteMany({ 'actor.subject': 'admin-user' });
  await app?.close();
  await mongo?.close();
  try {
    await app?.get<MongoClient>(MONGO_CLIENT).close();
  } catch {
    // Already closed by app.close().
  }
});

describe('who may administer sources', () => {
  it('refuses an analyst, who may run searches but not configure what they search', async () => {
    const analyst = await token({ roles: ['analyst'] });
    const response = await request(app.getHttpServer())
      .post('/v1/admin/sources')
      .set('Authorization', `Bearer ${analyst}`)
      .send(sourceBody(`src-${randomUUID()}`));

    expect(response.status).toBe(403);
  });

  it('refuses a platform_operator — running the platform is not configuring it (T06)', async () => {
    const operator = await token({ roles: ['platform_operator'] });
    const response = await request(app.getHttpServer())
      .get('/v1/admin/sources')
      .set('Authorization', `Bearer ${operator}`);

    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated caller without disclosing anything', async () => {
    const response = await request(app.getHttpServer()).get('/v1/admin/sources');
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toMatch(/signature|issuer|audience|jwks/i);
  });

  it('lets a taxonomy_admin propose a taxonomy but not a source', async () => {
    const taxonomyAdmin = await token({ roles: ['taxonomy_admin'] });

    const source = await request(app.getHttpServer())
      .post('/v1/admin/sources')
      .set('Authorization', `Bearer ${taxonomyAdmin}`)
      .send(sourceBody(`src-${randomUUID()}`));
    expect(source.status).toBe(403);

    const taxonomy = await request(app.getHttpServer())
      .post('/v1/admin/taxonomy')
      .set('Authorization', `Bearer ${taxonomyAdmin}`)
      .send({ recordId: 'tenant-alpha', content: { categories: [] } });
    expect(taxonomy.status).toBe(201);
  });
});

describe('what a source administrator may configure (FR-05)', () => {
  const asSourceAdmin = async () => token({ roles: ['source_admin'] });

  it('rejects a regional pseudo-code where a country is required', async () => {
    const auth = await asSourceAdmin();
    const body = sourceBody(`src-${randomUUID()}`);
    const response = await request(app.getHttpServer())
      .post('/v1/admin/sources')
      .set('Authorization', `Bearer ${auth}`)
      .send({
        ...body,
        rightsPolicy: { ...body.rightsPolicy, jurisdiction: 'EU' },
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/jurisdiction/);
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    const auth = await asSourceAdmin();
    const response = await request(app.getHttpServer())
      .post('/v1/admin/sources')
      .set('Authorization', `Bearer ${auth}`)
      .send({ ...sourceBody(`src-${randomUUID()}`), fetchUrl: 'https://example.test/a?b=c' });

    expect(response.status).toBe(400);
  });

  it('refuses an approval whose scope does not cover what it is attached to', async () => {
    const auth = await asSourceAdmin();
    const body = sourceBody(`src-${randomUUID()}`);
    const response = await request(app.getHttpServer())
      .post('/v1/admin/sources')
      .set('Authorization', `Bearer ${auth}`)
      .send({
        ...body,
        dataProfile: {
          ...body.dataProfile,
          approval: {
            approvalRef: 'X',
            approvedBy: 'someone',
            approvedAt: 'not-a-date',
            expiresAt: null,
            coversOperations: ['COLLECT'],
            coversJurisdictions: ['CR'],
          },
        },
      });

    expect(response.status).toBe(400);
  });
});

describe('the reserved FR-15 routes are not shadowed by the admin routes', () => {
  it('still returns 501 for /v1/admin/plans', async () => {
    const auth = await token({ roles: ['platform_admin'] });
    const response = await request(app.getHttpServer())
      .get('/v1/admin/plans')
      .set('Authorization', `Bearer ${auth}`);

    expect(response.status).toBe(501);
    expect(response.body.code).toBe('NOT_IMPLEMENTED');
  });

  it('returns 404 for an admin collection that does not exist', async () => {
    const auth = await token({ roles: ['source_admin'] });
    const response = await request(app.getHttpServer())
      .get('/v1/admin/connectors')
      .set('Authorization', `Bearer ${auth}`);

    expect(response.status).toBe(404);
  });
});

describe('coverage is readable by the people who must not be misled', () => {
  it('lets an auditor read a jurisdiction coverage statement', async () => {
    const auditor = await token({ roles: ['auditor'] });
    const response = await request(app.getHttpServer())
      .get('/v1/admin/coverage/CR')
      .set('Authorization', `Bearer ${auditor}`);

    expect(response.status).toBe(200);
    expect(response.body.jurisdiction).toBe('CR');
    // The property that matters: nothing in CR may say an empty result means "no findings".
    for (const entry of response.body.capabilities) {
      expect(entry.emptyResultMeans).toBe('NOT_ESTABLISHED');
    }
    expect(response.body.outcome).not.toBe('COMPLETE');
    expect(response.body.gaps.length).toBeGreaterThan(0);
  });

  it('refuses to let an analyst rewrite a coverage status', async () => {
    const analyst = await token({ roles: ['analyst'] });
    const response = await request(app.getHttpServer())
      .put('/v1/admin/coverage')
      .set('Authorization', `Bearer ${analyst}`)
      .send({
        jurisdiction: 'CR',
        capability: 'OFFICER_ASSOCIATIONS',
        status: 'SUPPORTED',
        rationale: 'Looks fine to me.',
      });

    expect(response.status).toBe(403);
  });
});
