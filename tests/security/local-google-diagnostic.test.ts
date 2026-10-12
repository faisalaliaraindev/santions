/**
 * The local Google diagnostic header, through the real HTTP stack and the real database.
 *
 * The unit file (`apps/api/test/local-google-diagnostic.test.ts`) proves the decision and the
 * connector. This one proves the **door**: that a request carrying
 * `X-Local-Discovery-Diagnostic` is decided before anything is written, that every failed
 * condition is a refusal rather than a quietly normal search, and that nothing lands in the
 * engine-settings collection whichever way it goes.
 *
 * Two apps: one with the flag set for `tenant-alpha`, one without it. supertest connects over
 * loopback, which is the local-development condition, so what varies here is the flag, the
 * tenant and the header — the three a developer actually gets wrong.
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

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
const DIAGNOSTIC_TENANT = 'tenant-alpha';
const OTHER_TENANT = 'tenant-beta';

const BASE_ENV: NodeJS.ProcessEnv = {
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

let privateKey: KeyLike;
let publicJwk: JWK;
let mongo: MongoClient;
let flagged: INestApplication;
let unflagged: INestApplication;

async function appWith(env: NodeJS.ProcessEnv): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(env))
    .overrideProvider(TokenVerifier)
    .useValue(
      new TokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        keyResolver: createLocalJWKSet({ keys: [publicJwk] }),
      }),
    )
    .compile();
  const app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });
  await app.init();
  return app;
}

async function token(tenantId: string): Promise<string> {
  return new SignJWT({
    realm_access: { roles: ['analyst'] },
    environment: 'sandbox',
    scope: 'search:read search:write',
    tenant_id: tenantId,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('diagnostic-test-user')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function subjectFor(
  app: INestApplication,
  bearer: string,
): Promise<{ id: string; v: number }> {
  const response = await request(app.getHttpServer())
    .post('/v1/subjects')
    .set('Authorization', `Bearer ${bearer}`)
    .send({
      fullName: 'Diagnostic Subject',
      aliases: [],
      countryContext: ['US'],
      knownCompanies: [],
      purpose: 'CUSTOMER_ONBOARDING',
    });
  expect(response.status).toBe(201);
  return { id: response.body.subjectId as string, v: response.body.version as number };
}

function searchBody(subject: { id: string; v: number }) {
  return {
    subjectRef: { subjectId: subject.id, version: subject.v },
    requestedScope: {
      jurisdictions: ['US'],
      languages: ['en'],
      includeFormerDirectorships: false,
      fromDate: null,
    },
    environment: 'sandbox',
  };
}

async function runCount(tenantId: string): Promise<number> {
  return mongo.db().collection('searchRuns').countDocuments({ tenantId });
}

async function settingsCount(): Promise<number> {
  return mongo.db().collection('searxngEngineSettings').countDocuments({});
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };

  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(
      `The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap\n\n${String(error)}`,
    );
  }

  flagged = await appWith({
    ...BASE_ENV,
    ALLOW_LOCAL_GOOGLE_DIAGNOSTIC: 'true',
    GOOGLE_DIAGNOSTIC_TENANT_ID: DIAGNOSTIC_TENANT,
  });
  unflagged = await appWith({ ...BASE_ENV, GOOGLE_DIAGNOSTIC_TENANT_ID: DIAGNOSTIC_TENANT });
}, 90_000);

afterAll(async () => {
  for (const app of [flagged, unflagged]) {
    await app?.close();
    try {
      await app?.get<MongoClient>(MONGO_CLIENT).close();
    } catch {
      // Already closed by app.close().
    }
  }
  await mongo?.close();
});

describe('X-Local-Discovery-Diagnostic at the HTTP door', () => {
  it('reaches the grant for the named tenant with the flag set, and refuses a non-live search', async () => {
    const bearer = await token(DIAGNOSTIC_TENANT);
    const subject = await subjectFor(flagged, bearer);
    const runsBefore = await runCount(DIAGNOSTIC_TENANT);
    const settingsBefore = await settingsCount();

    const response = await request(flagged.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Local-Discovery-Diagnostic', 'GOOGLE_NEWS')
      .send(searchBody(subject));

    // Every condition held, so the only thing left to refuse is the environment: the diagnostic
    // applies to LIVE searches only.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(await runCount(DIAGNOSTIC_TENANT)).toBe(runsBefore);
    expect(await settingsCount()).toBe(settingsBefore);
  });

  it('refuses the wrong tenant, and writes nothing', async () => {
    const bearer = await token(OTHER_TENANT);
    const subject = await subjectFor(flagged, bearer);
    const runsBefore = await runCount(OTHER_TENANT);

    const response = await request(flagged.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Local-Discovery-Diagnostic', 'GOOGLE_NEWS')
      .send(searchBody(subject));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    // The body does not say which condition failed.
    expect(JSON.stringify(response.body)).not.toMatch(/tenant|ALLOW_LOCAL|production|loopback/i);
    expect(await runCount(OTHER_TENANT)).toBe(runsBefore);
  });

  it('refuses when the process does not have the flag set', async () => {
    const bearer = await token(DIAGNOSTIC_TENANT);
    const subject = await subjectFor(unflagged, bearer);
    const response = await request(unflagged.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Local-Discovery-Diagnostic', 'GOOGLE_NEWS')
      .send(searchBody(subject));
    expect(response.status).toBe(403);
  });

  it('refuses a wrong header value', async () => {
    const bearer = await token(DIAGNOSTIC_TENANT);
    const subject = await subjectFor(flagged, bearer);
    for (const value of ['BING_NEWS', 'google_news', 'true']) {
      const response = await request(flagged.getHttpServer())
        .post('/v1/searches')
        .set('Authorization', `Bearer ${bearer}`)
        .set('X-Local-Discovery-Diagnostic', value)
        .send(searchBody(subject));
      expect(response.status).toBe(403);
    }
  });

  it('leaves a search without the header a normal search, with no diagnostic marker', async () => {
    const bearer = await token(DIAGNOSTIC_TENANT);
    const subject = await subjectFor(flagged, bearer);
    const settingsBefore = await settingsCount();
    const response = await request(flagged.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', `Bearer ${bearer}`)
      .send(searchBody(subject));
    expect(response.status).toBe(202);

    const run = await mongo
      .db()
      .collection('searchRuns')
      .findOne({ tenantId: DIAGNOSTIC_TENANT, searchId: response.body.searchId as string });
    expect(run).not.toBeNull();
    expect(run?.['localDiscoveryDiagnostic']).toBeUndefined();
    expect(await settingsCount()).toBe(settingsBefore);
  });
});

/**
 * `POST /v1/screen` is the one endpoint that runs everything — every source in one call, or one
 * source at a time with `sources`. It must decide the diagnostic header exactly as
 * `POST /v1/searches` does, and it must refuse a source filter that names nothing searchable.
 */
describe('POST /v1/screen — the single endpoint', () => {
  const screenBody = (extra: Record<string, unknown> = {}) => ({
    fullName: 'Diagnostic Subject',
    purpose: 'CUSTOMER_ONBOARDING',
    environment: 'sandbox',
    ...extra,
  });

  it('refuses the diagnostic header for the wrong tenant, and writes nothing', async () => {
    const bearer = await token(OTHER_TENANT);
    const runsBefore = await runCount(OTHER_TENANT);
    const response = await request(flagged.getHttpServer())
      .post('/v1/screen')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Local-Discovery-Diagnostic', 'GOOGLE_NEWS')
      .send(screenBody());
    expect(response.status).toBe(403);
    expect(await runCount(OTHER_TENANT)).toBe(runsBefore);
  });

  it('refuses the diagnostic header on a non-live screening', async () => {
    const bearer = await token(DIAGNOSTIC_TENANT);
    const response = await request(flagged.getHttpServer())
      .post('/v1/screen')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Local-Discovery-Diagnostic', 'GOOGLE_NEWS')
      .send(screenBody());
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an unknown source id, names what is searchable, and writes nothing', async () => {
    const bearer = await token(DIAGNOSTIC_TENANT);
    const runsBefore = await runCount(DIAGNOSTIC_TENANT);
    const response = await request(unflagged.getHttpServer())
      .post('/v1/screen')
      .set('Authorization', `Bearer ${bearer}`)
      .send(screenBody({ sources: ['no-such-source'] }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).toMatch(/Searchable here: /);
    expect(await runCount(DIAGNOSTIC_TENANT)).toBe(runsBefore);
  });

  it('runs one source through the same endpoint and reports the rest as SKIPPED', async () => {
    const bearer = await token(DIAGNOSTIC_TENANT);
    // The refusal names the searchable ids, which is how a tester finds them.
    const probe = await request(unflagged.getHttpServer())
      .post('/v1/screen')
      .set('Authorization', `Bearer ${bearer}`)
      .send(screenBody({ sources: ['no-such-source'] }));
    const listed = /Searchable here: ([^.]*)\./.exec(JSON.stringify(probe.body))?.[1] ?? '';
    const searchable = listed.split(', ').filter((id) => id.length > 0);
    expect(searchable.length).toBeGreaterThan(1);
    const chosen = searchable[0]!;

    const response = await request(unflagged.getHttpServer())
      .post('/v1/screen')
      .set('Authorization', `Bearer ${bearer}`)
      .send(screenBody({ sources: [chosen] }));
    expect(response.status).toBe(201);

    const outcomes = response.body.result.sourceOutcomes as {
      sourceId: string;
      outcome: string;
      detail: string | null;
    }[];
    const bySource = new Map(outcomes.map((o) => [o.sourceId, o]));
    expect(bySource.get(chosen)?.detail ?? '').not.toMatch(/restricted the run to named sources/);
    for (const other of searchable.slice(1)) {
      expect(bySource.get(other)?.outcome).toBe('SKIPPED');
    }
    // One source is never a full screening.
    expect(response.body.coverage).toBe('INCOMPLETE');
  }, 120_000);
});
