/**
 * I1 — `POST /v1/signup`, through the real API and the real database.
 *
 * Four claims, and each one is the sort that is only true if it was actually tried:
 *
 *  1. **A tenant is created by an unauthenticated caller, whole.** All four records, or none.
 *  2. **The caller cannot name the tenant.** The id is generated, and a body that tries to
 *     supply one is refused rather than ignored.
 *  3. **A self-signed-up tenant cannot issue a live key** until its contact address is
 *     confirmed (D-052) — while a tenant a person onboarded still can, which is what stops this
 *     gate from being a regression for every existing customer.
 *  4. **The open door is bounded.** Past the per-address limit the answer is a retryable 429.
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { MongoClient, type Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG, MONGO_CLIENT, MONGO_DB } from '../../apps/api/src/app.module.js';
import { TokenVerifier } from '../../apps/api/src/auth/token-verifier.js';
import { loadConfig } from '../../apps/api/src/config/config.js';
import type { AuditService } from '../../apps/api/src/persistence/audit.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';
import { AccountService } from '../../apps/api/src/auth/account.service.js';
import { UserService } from '../../apps/api/src/auth/user.service.js';
import { ApiKeyService, type IssuedApiKey } from '../../apps/api/src/tenancy/api-key.service.js';
import { SignupService } from '../../apps/api/src/tenancy/signup.service.js';
import {
  AttemptLimiter,
  originKeyFor,
  SIGNUP_POLICY,
} from '../../apps/api/src/common/attempt-limiter.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const ISSUER = 'https://issuer.test/realms/adverse-search';
const AUDIENCE = 'adverse-search-api';

/** Seeded by `pnpm local:bootstrap`, entitled to live, and onboarded by a person — not signup. */
const SEEDED_LIVE_TENANT = 'tenant-live';

let app: INestApplication;
let mongo: MongoClient;
let db: Db;
let apiKeys: ApiKeyService;
let signups: SignupService;

/**
 * Every tenant this file creates, so it can take them away again.
 *
 * Signup writes to the same database the other suites read, and a test that leaves tenants
 * behind makes the collection grow by a dozen on every run. Worse, T01 counts records that are
 * not labelled `MOCK` — a suite that leaves litter eventually fails a different suite, and the
 * person who has to work out why did not write either of them.
 */
const createdTenants: string[] = [];

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

/**
 * A password that passes the policy without being memorable enough to be reused anywhere.
 *
 * Randomised per call so no two test accounts share one, and long enough that the length rule is
 * never the thing under test unless a test says so.
 */

/**
 * The rows this file's own HTTP signups write.
 *
 * Supertest connects over the loopback interface, which Express reports as one of these
 * depending on how the socket was opened. Keyed with the same function the service uses, so the
 * keying cannot drift between them.
 */
const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'].map((ip) =>
  originKeyFor(String(TEST_ENV['SESSION_SECRET']), ip),
);

function testPassword(): string {
  return `harbour-lantern-${randomUUID()}`;
}

function signupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organisationName: 'Acme Compliance Ltd',
    contactEmail: `${randomUUID()}@example.test`,
    password: testPassword(),
    ...overrides,
  };
}

/** Sign up through the route, as a customer would, with no credential of any kind. */
async function signUp(
  body: Record<string, unknown> = signupBody(),
): Promise<Record<string, unknown>> {
  const response = await request(app.getHttpServer()).post('/v1/signup').send(body).expect(201);
  const result = response.body as Record<string, unknown>;
  createdTenants.push(result['tenantId'] as string);
  return result;
}

/**
 * A `tenant_admin` key for a tenant, issued directly through the service.
 *
 * Deliberately not through the route: issuing the *first* key for a self-signed-up tenant is
 * I2's and I3's job (a password, then a session), and it does not exist yet. What is under test
 * here is what happens when that key is used, not how it is obtained.
 */
async function tenantAdminKey(
  tenantId: string,
  environment: 'sandbox' | 'live',
): Promise<IssuedApiKey> {
  return apiKeys.create({
    tenantId,
    environment,
    label: 'tenant admin, signup tests',
    roles: ['tenant_admin'],
    scopes: ['search:read', 'admin:read', 'admin:write'],
    createdBy: 'operator@erly.test',
    expiresAt: null,
  });
}

/** An analyst key, which is what actually does screening work. */
async function analystKey(tenantId: string): Promise<IssuedApiKey> {
  return apiKeys.create({
    tenantId,
    environment: 'sandbox',
    label: 'analyst, signup tests',
    roles: ['analyst'],
    scopes: ['search:read', 'search:write'],
    createdBy: 'operator@erly.test',
    expiresAt: null,
  });
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
  signups = app.get(SignupService);
  db = app.get<Db>(MONGO_DB);
}, 90_000);

/**
 * Every signup in this file that goes through the route arrives from the loopback address, so
 * without this they share one bucket and the sixth test in the file gets the 429 that the last
 * describe block is deliberately provoking. The limiter itself is exercised there, against its
 * own address, which is the honest way round: clearing the counter here does not weaken that
 * test, and leaving it uncleared would make every other test depend on how many tests ran first.
 */
beforeEach(async () => {
  // Only this bucket. A blanket delete would also clear the counter the rate-limit test in
  // `signup.test.ts` is building up against its own fixed address — the two files run in
  // parallel against one database, and that is exactly how a suite starts failing for a reason
  // that has nothing to do with what it tests.
  await db
    .collection('attemptLog')
    .deleteMany({ bucket: 'SIGNUP', originKey: { $in: LOOPBACK_KEYS } });
});

afterAll(async () => {
  // Signups made directly through the service, by the rate-limit and rollback tests, are
  // matched by name rather than by id — those calls never returned one to collect.
  await Promise.all(
    ['tenants', 'tenantEntitlementVersions', 'taxonomyVersions', 'policyVersions', 'users'].map(
      (collection) => db.collection(collection).deleteMany({ tenantId: { $in: createdTenants } }),
    ),
  );
  const strays = await db
    .collection('tenants')
    .find({ name: { $in: ['Bounded Ltd', 'One Too Many Ltd'] } })
    .toArray();
  const strayIds = strays.map((record) => record['tenantId'] as string);
  await Promise.all(
    ['tenants', 'tenantEntitlementVersions', 'taxonomyVersions', 'policyVersions', 'users'].map(
      (collection) => db.collection(collection).deleteMany({ tenantId: { $in: strayIds } }),
    ),
  );

  await app?.close();
  await mongo?.close();
  try {
    await app?.get<MongoClient>(MONGO_CLIENT).close();
  } catch {
    // Already closed by app.close().
  }
});

describe('I1 — signup creates a whole tenant, with no credential', () => {
  it('creates all four records in one go', async () => {
    const result = await signUp();
    const tenantId = result['tenantId'] as string;

    const [tenant, entitlement, taxonomy, policy] = await Promise.all([
      db.collection('tenants').findOne({ tenantId }),
      db.collection('tenantEntitlementVersions').findOne({ tenantId }),
      db.collection('taxonomyVersions').findOne({ tenantId }),
      db.collection('policyVersions').findOne({ tenantId }),
    ]);

    // The four together. Three of four is the failure this transaction exists to prevent, and
    // it would show up as a search refusing itself rather than as a signup that did not finish.
    expect(tenant).not.toBeNull();
    expect(entitlement).not.toBeNull();
    expect(taxonomy).not.toBeNull();
    expect(policy).not.toBeNull();

    expect(entitlement?.['status']).toBe('ACTIVE');
    expect(taxonomy?.['status']).toBe('ACTIVE');
    expect(policy?.['status']).toBe('ACTIVE');
  });

  it('labels all four records MOCK while the service runs against fixtures (T55)', async () => {
    const result = await signUp();
    const tenantId = result['tenantId'] as string;

    // The label lives on the data, not in a config flag somebody can flip. A tenant provisioned
    // against fixtures whose taxonomy version claims nothing about its provenance is a record
    // the mode check cannot see.
    for (const collection of [
      'tenants',
      'tenantEntitlementVersions',
      'taxonomyVersions',
      'policyVersions',
    ]) {
      const record = await db.collection(collection).findOne({ tenantId });
      expect(record?.['mode'], `${collection} carries a mode`).toBe('MOCK');
    }
  });

  it('grants both environments, and says live is not usable yet', async () => {
    const result = await signUp();

    // D-053: both key kinds from day one. D-052: live waits for a confirmed address. Both are
    // true at once, which is exactly why the grant and the gate are different pieces of state.
    expect(result['entitlement']).toMatchObject({ environments: ['sandbox', 'live'] });
    expect(result['liveAccess']).toMatchObject({
      granted: false,
      blockedBy: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('writes the tenant a first audit entry, inside the same transaction', async () => {
    const result = await signUp();
    const tenantId = result['tenantId'] as string;

    const entries = await db.collection('auditEvents').find({ tenantId }).toArray();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.['action']).toBe('tenant:signup');
    expect(entries[0]?.['sequence']).toBe(1);
    // SEC-05: the minimal permitted fact. The contact address lives on the tenant record, which
    // has a retention policy; the audit chain is append-only and does not.
    expect(JSON.stringify(entries[0])).not.toContain('@example.test');
  });

  it('accepts a search-capable tenant: the versions it wrote are the ones searches pin', async () => {
    const result = await signUp();
    const tenantId = result['tenantId'] as string;
    const key = await analystKey(tenantId);

    // The end of the claim that matters: not "four rows exist" but "this tenant can be used".
    // A subject creation is the cheapest call that goes through tenant resolution.
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send({
        fullName: 'Diego Alberto Solís Ramírez',
        aliases: [],
        countryContext: ['CR'],
        knownCompanies: [],
        purpose: 'CUSTOMER_ONBOARDING',
      });

    expect(response.status).toBe(201);
  });
});

describe('I1 — the caller cannot name the tenant', () => {
  it('refuses a body that supplies a tenant id, rather than ignoring the field', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/signup')
      .send(signupBody({ tenantId: SEEDED_LIVE_TENANT }))
      .expect(400);

    // Rejected, not dropped. A client that believes it chose its id must be told it did not —
    // and a caller who could choose one could choose an existing tenant's.
    expect(response.body.code).toBe('UNKNOWN_FIELD');
  });

  it('generates an id that the organisation name does not predict', async () => {
    const name = `Predictable Name ${randomUUID()}`;
    const first = await signUp(signupBody({ organisationName: name }));
    const second = await signUp(signupBody({ organisationName: name }));

    expect(first['tenantId']).not.toBe(second['tenantId']);
    expect(first['tenantId']).not.toContain('Predictable');
    expect(first['tenantId']).toMatch(/^tenant-[0-9a-f-]{36}$/u);
  });

  it('never returns a secret, because signup issues no credential', async () => {
    const result = await signUp();
    expect(JSON.stringify(result)).not.toContain('erly_');
  });
});

describe('I1 — all four records, or none', () => {
  it('leaves nothing behind when a write inside the transaction fails', async () => {
    // The audit append is the last write in the transaction, so a failure there is the cleanest
    // way to prove the earlier four are rolled back. Without the transaction, this test finds
    // four orphaned records and a tenant that would fail at its first search.
    const exploding = {
      append: (): Promise<never> => Promise.reject(new Error('planted audit failure')),
    } as unknown as AuditService;

    const service = new SignupService(
      db,
      app.get(TransactionRunner),
      exploding,
      app.get(AttemptLimiter),
      app.get(UserService),
      app.get(AccountService),
      loadConfig(TEST_ENV),
    );

    const organisationName = `Rollback Probe ${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;
    await expect(
      service.signUp(
        { organisationName, contactEmail: email, password: testPassword() },
        { ip: `10.0.0.${String(Math.floor(Math.random() * 200))}`, correlationId: null },
      ),
    ).rejects.toThrow();

    expect(await db.collection('tenants').countDocuments({ name: organisationName })).toBe(0);
    // The user goes with it. A user left behind would hold the address for ever, and the
    // customer's second, successful attempt would be refused as a duplicate.
    expect(await db.collection('users').countDocuments({ email })).toBe(0);
  });
});

describe('I1 — live access is read from tenant state (D-052)', () => {
  it('refuses a live key to a self-signed-up tenant with an unconfirmed address', async () => {
    const result = await signUp();
    const tenantId = result['tenantId'] as string;
    // A live credential and a live entitlement, which is everything the rules required before
    // this gate existed. The refusal must come from the tenant's own state.
    const key = await tenantAdminKey(tenantId, 'live');

    const response = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send({ label: 'live before verification', roles: ['tenant_admin'], environment: 'live' })
      .expect(403);

    expect(response.body.code).toBe('SANDBOX_CANNOT_ACCESS_LIVE');
    // The message has to name the thing the customer can do about it, or the 403 sends them to
    // support for an answer they could have acted on themselves.
    expect(String(response.body.message)).toContain('contact email');
  });

  it('issues the live key once the address is confirmed', async () => {
    const result = await signUp();
    const tenantId = result['tenantId'] as string;
    const key = await tenantAdminKey(tenantId, 'live');

    // What the I2 verification flow will do: write the timestamp. Nothing else changes — no
    // entitlement is edited and no route is redeployed, which is the property that makes the
    // later payment gate a value rather than a migration.
    await db
      .collection('tenants')
      .updateOne({ tenantId }, { $set: { emailVerifiedAt: new Date().toISOString() } });

    const response = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send({ label: 'live after verification', roles: ['tenant_admin'], environment: 'live' })
      .expect(201);

    expect(response.body.environment).toBe('live');
  });

  it('still issues a live key to a tenant a person onboarded', async () => {
    // `tenant-live` is seeded by the bootstrap and has neither `createdVia` nor
    // `emailVerifiedAt`. If this fails, the gate has taken live access away from every customer
    // who already had it — on deploy, with no verification email to re-send.
    const key = await tenantAdminKey(SEEDED_LIVE_TENANT, 'live');

    const response = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send({ label: 'live, hand-onboarded tenant', roles: ['tenant_admin'], environment: 'live' })
      .expect(201);

    expect(response.body.environment).toBe('live');
  });

  it('issues a sandbox key to an unverified tenant, because sandbox is not gated', async () => {
    const result = await signUp();
    const key = await tenantAdminKey(result['tenantId'] as string, 'sandbox');

    await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send({ label: 'sandbox, unverified', roles: ['tenant_admin'] })
      .expect(201);
  });
});

describe('I1 — the open door is bounded', () => {
  it('answers 429, retryably, past the per-address limit', async () => {
    // A fixed address, so this test counts against its own bucket and not the shared one every
    // other test in this file signs up from.
    const ip = `203.0.113.${String(Math.floor(Math.random() * 250) + 1)}`;

    for (let attempt = 0; attempt < SIGNUP_POLICY.max; attempt += 1) {
      await signups.signUp(
        {
          organisationName: 'Bounded Ltd',
          contactEmail: `${randomUUID()}@example.test`,
          password: testPassword(),
        },
        { ip, correlationId: null },
      );
    }

    await expect(
      signups.signUp(
        {
          organisationName: 'One Too Many Ltd',
          contactEmail: `${randomUUID()}@example.test`,
          password: testPassword(),
        },
        { ip, correlationId: null },
      ),
    ).rejects.toMatchObject({ rejection: 'RATE_LIMITED' });

    // And nothing was written for the refused attempt: the limiter runs before the transaction.
    expect(await db.collection('tenants').countDocuments({ name: 'One Too Many Ltd' })).toBe(0);
  });
});
