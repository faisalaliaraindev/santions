/**
 * The whole join: a stranger becomes a customer and runs a search, over HTTP, with nothing seeded.
 *
 * # Why this file exists when `api-lifecycle.test.ts` already runs a search
 *
 * That suite borrows `tenant-alpha` and builds its API key **by hand**, calling `ApiKeyService`
 * directly, because when it was written there was no endpoint that issued one. Its own comment
 * says a fresh tenant "has no active taxonomy version, so every search would 422". That was true
 * then and is false now — phase I made signup provision all four records — but nothing proved it.
 *
 * So there were two halves and no test across the seam:
 *
 * - `tests/security/{signup,account,login}.test.ts` prove a tenant can create itself and issue a
 *   key. None of them ever calls `POST /v1/searches`.
 * - `tests/e2e/api-lifecycle.test.ts` proves a search runs. It never calls `POST /v1/signup`.
 *
 * A tenant could therefore be provisioned with everything except the one thing that makes the
 * product work, and every suite would stay green. **It was.** See "the role gap" below.
 *
 * # The rule this suite holds
 *
 * After the key is issued, **every customer-facing call authenticates with that key** — the one
 * the tenant minted for itself, seconds earlier, through the public API. No seeded credential,
 * no hand-built key, no JWT, no tenant id in a payload. The `auth()` helpers below are the only
 * way a request in this file gets a credential, and neither can return a borrowed one.
 *
 * # The role gap this suite was written to catch
 *
 * `tenant_admin` holds `apikey:manage` but **not** `search:create`, and `scopesForRoles` maps
 * `search:write` from `analyst` alone. The key route refuses to mint a key carrying a role the
 * caller does not hold. So an administrator holding only `tenant_admin` could issue only
 * `tenant_admin` keys, and every one of them was refused at `POST /v1/searches` — a tenant sold
 * `adverse_media`, provisioned correctly, and unable to search. `SignupService` now grants
 * `['tenant_admin', 'analyst']`, and the assertion below fails if that is reverted.
 *
 * # Live
 *
 * The tenant confirms its address, so it is entitled to live and its session is live, and this
 * suite issues a **live key** and proves it authenticates and is bound to the tenant. It does
 * **not** run a live search: that contacts real publishers under our user agent, against a
 * budget shared across all tenants, and it is not a test's to trigger. Searches here are
 * `sandbox` against the local fixture server, and every result asserts `mode: 'MOCK'` (T55).
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { MongoClient, type Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG } from '../../apps/api/src/app.module.js';
import { loadConfig } from '../../apps/api/src/config/config.js';
import { originKeyFor } from '../../apps/api/src/common/attempt-limiter.js';
import { OutboxPublisher } from '../../apps/api/src/jobs/outbox-publisher.js';
import { WorkerRuntime } from '../../apps/api/src/jobs/worker-runtime.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

/**
 * The name the seeded discovery fixtures respond to.
 *
 * Accents included, and that matters: the fixture match folds accents, so a name that arrives
 * mangled folds to something else and matches nothing — an honest `NO_MATCHES_FOUND` that looks
 * like a matching bug. Asserting on a non-zero finding count is what catches it.
 */
const FIXTURE_SUBJECT = 'María Fernanda Solís Rojas';

/** A password that clears the policy: long, not a known-bad, and containing neither identifier. */
const PASSWORD = 'harbour-lantern-drift-98';

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ADVERSE_SEARCH_MODE: 'mock',
  MONGODB_URI,
  OIDC_ISSUER: 'https://issuer.test/realms/adverse-search',
  OIDC_CLIENT_ID: 'adverse-search-panel',
  OIDC_CLIENT_SECRET: 'test-only-secret-value',
  OIDC_AUDIENCE: 'adverse-search-api',
  SESSION_SECRET: 'test-only-session-secret-value',
  SESSION_COOKIE_SECURE: 'false',
  CORS_ORIGINS: '',

  AWS_REGION: process.env['AWS_REGION'] ?? 'eu-west-2',
  AWS_ENDPOINT_URL: process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566',
  AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
  AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
  JOBS_QUEUE_URL:
    process.env['JOBS_QUEUE_URL'] ?? 'http://127.0.0.1:28566/000000000000/adverse-search-jobs',
  JOBS_DEAD_LETTER_QUEUE_URL:
    process.env['JOBS_DEAD_LETTER_QUEUE_URL'] ??
    'http://127.0.0.1:28566/000000000000/adverse-search-jobs-dlq',

  /**
   * The fixture server, and it is NOT optional.
   *
   * In mock mode every source adapter is a fixture that reads from this host. Without it the
   * adapters are constructed, discovery runs, and every rung answers with nothing — so the run
   * completes in about a second with `execution: FAILED` and `coverage: INCOMPLETE`, which reads
   * exactly like a provisioning bug in the tenant under test and is not one. `api-lifecycle.test.ts`
   * omits it too and fails the same way; the value lives in `.env` and both suites need it.
   */
  FIXTURE_SERVER_URL: process.env['FIXTURE_SERVER_URL'] ?? 'http://127.0.0.1:28090',
  SEARXNG_URL: process.env['SEARXNG_URL'] ?? 'http://127.0.0.1:28888',
  EXTRACTION_MODEL_KIND: process.env['EXTRACTION_MODEL_KIND'] ?? 'synthetic',
  MODEL_RUNTIME_URL: process.env['MODEL_RUNTIME_URL'] ?? 'http://127.0.0.1:28434',

  S3_EVIDENCE_BUCKET: process.env['S3_EVIDENCE_BUCKET'] ?? 'adverse-search-evidence-local',
  SEARCH_INDEX_KIND: process.env['SEARCH_INDEX_KIND'] ?? 'meilisearch',
  MEILI_HOST: process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700',
  MEILI_MASTER_KEY: process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me',
};

let app: INestApplication;
let mongo: MongoClient;
let db: Db;

type Json = Record<string, unknown>;

/** Everything one onboarded tenant ends up holding. Nothing here is seeded or hand-built. */
interface OnboardedTenant {
  readonly tenantId: string;
  readonly adminUserId: string;
  readonly email: string;
  readonly sessionToken: string;
  readonly sandboxKey: string;
  readonly sandboxKeyId: string;
  readonly liveKey: string;
  readonly liveKeyId: string;
}

let alpha: OnboardedTenant;

/**
 * The rows this file's own signups write to the shared per-origin bucket.
 *
 * D-056 bounds signup to five per origin per hour, and every request here arrives from the
 * loopback interface — so this suite, which onboards several tenants, is indistinguishable from
 * the abuse the bound exists to stop. Clearing **only this bucket, only for loopback** keeps the
 * limiter under test elsewhere (`tests/security/signup.test.ts` asserts it fires) instead of
 * turning it off. Express reports the loopback socket as one of three forms depending on how it
 * was opened, and the key is derived with the same function the service uses so the two cannot
 * drift.
 */
const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'].map((ip) =>
  originKeyFor(String(TEST_ENV['SESSION_SECRET']), ip),
);

async function clearSignupBound(): Promise<void> {
  await db
    .collection('attemptLog')
    .deleteMany({ bucket: 'SIGNUP', originKey: { $in: LOOPBACK_KEYS } });
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\n${String(error)}`);
  }
  db = mongo.db();

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(TEST_ENV))
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  // Both halves, or every search sits at QUEUED with nothing in the logs saying why: the
  // publisher turns a committed outbox row into an SQS message, the worker consumes it.
  app.get(OutboxPublisher).start(250);
  app.get(WorkerRuntime).start();

  alpha = await onboard('Acme Compliance Ltd');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await mongo?.close();
}, 60_000);

/**
 * Sign up, confirm, sign in, issue both keys — entirely over HTTP.
 *
 * The one thing it does not do over HTTP is *read the mailbox*, and even that goes through the
 * dev route rather than the collection, so the route Postman depends on is exercised by the
 * suite rather than merely existing.
 */
async function onboard(organisationName: string): Promise<OnboardedTenant> {
  await clearSignupBound();
  const email = `e2e-${randomUUID()}@example.test`;

  const signedUp = await request(app.getHttpServer())
    .post('/v1/signup')
    .send({ organisationName, contactEmail: email, password: PASSWORD });
  expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(201);
  const s = signedUp.body as Json;

  const token = await verificationToken(email);
  const verified = await request(app.getHttpServer()).post('/v1/signup/verify').send({ token });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);

  // Sign in AFTER confirming, so the session's derived environment is live and can mint a live
  // key. A session created before confirmation is sandbox and T62 refuses it a live key.
  const loggedIn = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ email, password: PASSWORD });
  expect(loggedIn.status, JSON.stringify(loggedIn.body)).toBe(200);
  const sessionToken = String((loggedIn.body as Json)['sessionToken']);

  const sandbox = await issueKey(sessionToken, 'sandbox');
  const live = await issueKey(sessionToken, 'live');

  return {
    tenantId: String(s['tenantId']),
    adminUserId: String(s['adminUserId']),
    email,
    sessionToken,
    sandboxKey: String(sandbox['secret']),
    sandboxKeyId: String(sandbox['keyId']),
    liveKey: String(live['secret']),
    liveKeyId: String(live['keyId']),
  };
}

async function issueKey(sessionToken: string, environment: 'sandbox' | 'live'): Promise<Json> {
  const issued = await request(app.getHttpServer())
    .post('/v1/tenant/api-keys')
    .set('Authorization', `Session ${sessionToken}`)
    .send({
      label: `e2e ${environment} key`,
      // Both roles the administrator holds. `analyst` is the one that carries search:create.
      roles: ['tenant_admin', 'analyst'],
      environment,
    });
  expect(issued.status, `${environment} key: ${JSON.stringify(issued.body)}`).toBe(201);
  return issued.body as Json;
}

/** Read the token through the dev route — the same call Postman makes. */
async function verificationToken(email: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .get('/v1/dev/outbound-emails/latest')
    .query({ kind: 'EMAIL_VERIFICATION', email });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const token = (response.body as Json)['token'];
  expect(token, 'the dev mailbox route returned a message with no parseable token').toBeTypeOf(
    'string',
  );
  return String(token);
}

/** The tenant's own sandbox key. There is no accessor in this file that returns a seeded one. */
function sandboxAuth(tenant: OnboardedTenant = alpha): string {
  return `ApiKey ${tenant.sandboxKey}`;
}

async function createSubject(tenant: OnboardedTenant = alpha): Promise<Json> {
  const created = await request(app.getHttpServer())
    .post('/v1/subjects')
    .set('Authorization', sandboxAuth(tenant))
    .send({
      fullName: FIXTURE_SUBJECT,
      aliases: [],
      countryContext: ['CR'],
      dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
      knownCompanies: [{ registrationNumber: 'CR-3101-100001', jurisdiction: 'CR' }],
      externalSubjectRef: `e2e-onboarding-${randomUUID()}`,
      purpose: 'CUSTOMER_ONBOARDING',
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as Json;
}

async function startSearch(subject: Json, tenant: OnboardedTenant = alpha): Promise<string> {
  const accepted = await request(app.getHttpServer())
    .post('/v1/searches')
    .set('Authorization', sandboxAuth(tenant))
    .set('Idempotency-Key', randomUUID())
    .send({
      subjectRef: { subjectId: subject['subjectId'], version: subject['version'] },
      externalCaseRef: 'e2e-onboarding-case',
      requestedScope: {
        jurisdictions: ['CR'],
        languages: ['es', 'en'],
        includeFormerDirectorships: false,
        fromDate: null,
      },
      environment: 'sandbox',
    });
  // 202, not 200. A submitted search is a receipt, not an answer.
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  return String((accepted.body as Json)['searchId']);
}

/** Poll the real status endpoint until `execution` settles. Bounded, and loud about why. */
async function waitForTerminal(searchId: string, tenant: OnboardedTenant = alpha): Promise<Json> {
  const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
  const deadline = Date.now() + 90_000;
  let last: Json = {};

  while (Date.now() < deadline) {
    const response = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}`)
      .set('Authorization', sandboxAuth(tenant));
    expect(response.status).toBe(200);
    last = response.body as Json;
    if (terminal.has(String(last['execution']))) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Search ${searchId} never reached a terminal state. Last seen: ` +
      `${String(last['execution'])} / ${String(last['findings'])} / ${String(last['coverage'])}. ` +
      `Is the worker consuming? Is the queue reachable?`,
  );
}

describe('signup provisions a tenant that can actually search', () => {
  it('created the tenant, its administrator, and confirmed the address', async () => {
    const tenant = await db.collection('tenants').findOne({ tenantId: alpha.tenantId });
    expect(tenant, 'no tenant record').not.toBeNull();
    expect(tenant?.['createdVia']).toBe('SIGNUP');
    // The confirmed address is what unlocks live (D-052), so this is not incidental. Stored as
    // an ISO string, like every other timestamp on these records.
    expect(tenant?.['emailVerifiedAt']).toBeTypeOf('string');

    const user = await db.collection('users').findOne({ userId: alpha.adminUserId });
    expect(user, 'no administrator record').not.toBeNull();
    expect(user?.['tenantId']).toBe(alpha.tenantId);
    // A Date here, an ISO string on the tenant record. The two collections genuinely differ.
    expect(user?.['emailVerifiedAt']).toBeInstanceOf(Date);
    // Nothing ever returns the hash; this asserts the plaintext is not what was stored.
    expect(user?.['passwordHash']).not.toBe(PASSWORD);
  });

  it('grants the administrator both tenant_admin AND analyst', async () => {
    // The role gap. `analyst` is the only role `scopesForRoles` maps to `search:write`, and the
    // key route will not mint a role the caller does not hold — so without this the tenant can
    // never issue a key that may search, and every assertion further down fails with a 403 that
    // names a scope rather than the missing role.
    const user = await db.collection('users').findOne({ userId: alpha.adminUserId });
    expect(user?.['roles']).toEqual(['tenant_admin', 'analyst']);
  });

  it('grants ADVERSE_MEDIA in both environments', async () => {
    const entitlement = await db
      .collection('tenantEntitlementVersions')
      .findOne({ tenantId: alpha.tenantId, status: 'ACTIVE' });
    expect(entitlement, 'no active entitlement').not.toBeNull();
    expect(entitlement?.['environments']).toEqual(['sandbox', 'live']);

    const capabilities = JSON.stringify(entitlement?.['capabilities'] ?? []);
    expect(capabilities.toLowerCase()).toContain('adverse_media');
  });

  it('activates a taxonomy enabling the jurisdiction the fixtures operate in', async () => {
    // Without an ACTIVE taxonomy version every search is INVALID_POLICY; without CR enabled it
    // is JURISDICTION_NOT_ENABLED. Both read as a search bug rather than a provisioning one.
    const taxonomy = await db
      .collection('taxonomyVersions')
      .findOne({ tenantId: alpha.tenantId, status: 'ACTIVE' });
    expect(taxonomy, 'no active taxonomy version').not.toBeNull();

    const categories = (taxonomy?.['categories'] ?? []) as { enabledCountries: string[] }[];
    expect(categories.length).toBeGreaterThan(0);
    const countries = new Set(categories.flatMap((c) => c.enabledCountries));
    expect(countries.has('CR'), 'CR is where the fixture sources operate').toBe(true);
    expect(countries.has('US'), 'US is where the only live-approved source publishes').toBe(true);
  });

  it('activates a policy version', async () => {
    const policy = await db
      .collection('policyVersions')
      .findOne({ tenantId: alpha.tenantId, status: 'ACTIVE' });
    expect(policy, 'no active policy version').not.toBeNull();
    expect(Number(policy?.['queryPlanCap'])).toBeGreaterThan(0);
  });
});

describe('the keys the tenant issued for itself', () => {
  it('issued a sandbox key bound to the new tenant, carrying search:write', async () => {
    const record = await db.collection('apiKeyCredentials').findOne({ keyId: alpha.sandboxKeyId });
    expect(record, 'no key record').not.toBeNull();
    // The key resolves to ITS OWN tenant, not the seeded one.
    expect(record?.['tenantId']).toBe(alpha.tenantId);
    expect(record?.['tenantId']).not.toBe('tenant-alpha');
    expect(record?.['environment']).toBe('sandbox');
    expect(record?.['scopes']).toContain('search:write');
    // Only a hash is stored: the secret exists in the creation response and nowhere else.
    expect(JSON.stringify(record)).not.toContain(alpha.sandboxKey);
  });

  it('issued a live key too, once the address was confirmed', async () => {
    const record = await db.collection('apiKeyCredentials').findOne({ keyId: alpha.liveKeyId });
    expect(record, 'no live key record').not.toBeNull();
    expect(record?.['tenantId']).toBe(alpha.tenantId);
    expect(record?.['environment']).toBe('live');
  });

  it('the live key authenticates as the same tenant', async () => {
    // Proves the credential is real and bound correctly WITHOUT driving live external traffic:
    // listing keys is a read of the tenant's own records and contacts no publisher.
    const listed = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${alpha.liveKey}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);

    const ids = JSON.stringify(listed.body);
    expect(ids).toContain(alpha.liveKeyId);
    expect(ids).toContain(alpha.sandboxKeyId);
    // No secret is recoverable after issuance, for either key.
    expect(ids).not.toContain(alpha.liveKey);
    expect(ids).not.toContain(alpha.sandboxKey);
  });

  it('refuses a live key to a session that is only sandbox', async () => {
    // An unconfirmed tenant: entitled to live by D-053, refused it by D-052 until it confirms.
    await clearSignupBound();
    const email = `e2e-unconfirmed-${randomUUID()}@example.test`;
    const signedUp = await request(app.getHttpServer())
      .post('/v1/signup')
      .send({ organisationName: 'Unconfirmed Ltd', contactEmail: email, password: PASSWORD });
    expect(signedUp.status).toBe(201);

    const loggedIn = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(loggedIn.status).toBe(200);
    expect((loggedIn.body as Json)['environment']).toBe('sandbox');

    const refused = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `Session ${String((loggedIn.body as Json)['sessionToken'])}`)
      .send({ label: 'live before confirming', roles: ['tenant_admin'], environment: 'live' });
    expect(refused.status).toBe(403);
    expect((refused.body as Json)['code']).toBe('SANDBOX_CANNOT_ACCESS_LIVE');
  });
});

describe('a brand-new tenant runs an adverse search with its own key', () => {
  it('creates a subject, runs a search to terminal, and retrieves findings', async () => {
    const subject = await createSubject();
    expect(subject['subjectId']).toBeTypeOf('string');

    const searchId = await startSearch(subject);
    const settled = await waitForTerminal(searchId);

    // SUCCEEDED, not merely terminal: FAILED is terminal too and would pass a weaker assertion.
    expect(settled['execution'], JSON.stringify(settled)).toBe('SUCCEEDED');
    // The result belongs to the tenant that ran it.
    expect(settled['tenantId']).toBe(alpha.tenantId);
    expect(settled['environment']).toBe('sandbox');

    const page = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}/findings`)
      .set('Authorization', sandboxAuth());
    expect(page.status).toBe(200);
    const body = page.body as Json;

    // Something meaningful, not just a 200: the fixtures respond to this subject, so a non-zero
    // count is what proves discovery, fetch, extraction and banding all ran for THIS tenant's
    // freshly provisioned taxonomy and policy.
    const findings = body['findings'] as unknown[];
    expect(findings.length, 'the fixtures respond to this subject').toBeGreaterThan(0);

    // Findings never travel without their coverage.
    for (const field of ['execution', 'findingsState', 'coverage', 'noMatchStatement', 'mode']) {
      expect(body, `findings page is missing ${field}`).toHaveProperty(field);
    }

    // T55: fixture data must be unmistakable in a record.
    expect(body['mode']).toBe('MOCK');
  }, 180_000);
});

describe('one tenant cannot reach another', () => {
  it("refuses a second tenant's key access to the first tenant's search, without confirming it exists", async () => {
    const beta = await onboard('Beta Compliance Ltd');
    expect(beta.tenantId).not.toBe(alpha.tenantId);

    const subject = await createSubject();
    const searchId = await startSearch(subject);

    // Beta holds a legitimate analyst key in its own tenant and the exact search id.
    const stolen = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}`)
      .set('Authorization', sandboxAuth(beta));

    // 404, not 403: a cross-tenant read is indistinguishable from a missing record, so alpha's
    // id space cannot be mapped by watching status codes.
    expect(stolen.status).toBe(404);
    expect((stolen.body as Json)['code']).toBe('NOT_FOUND');
  }, 180_000);

  it('ignores a tenant id in the payload — the tenant comes from the credential', async () => {
    // There is no tenant field to honour, so a strict schema refuses it outright rather than
    // silently ignoring it. Either way the credential decides; this proves it is not read.
    const spoofed = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', sandboxAuth())
      .send({
        fullName: FIXTURE_SUBJECT,
        aliases: [],
        countryContext: ['CR'],
        externalSubjectRef: `e2e-spoof-${randomUUID()}`,
        purpose: 'CUSTOMER_ONBOARDING',
        tenantId: 'tenant-alpha',
      });
    expect(spoofed.status).toBe(400);
    expect(String((spoofed.body as Json)['code'])).toBe('UNKNOWN_FIELD');
  });

  it('lists only its own keys', async () => {
    const listed = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', sandboxAuth());
    expect(listed.status).toBe(200);

    // The summary carries no tenantId — the listing is scoped by the credential, so there is
    // nothing in the row to check. Resolve each id back to its record instead: a key belonging
    // to anybody else appearing here is the failure this is looking for.
    const items = (listed.body as Json)['items'] as { keyId: string }[];
    expect(items.length).toBeGreaterThanOrEqual(2);

    for (const item of items) {
      const record = await db.collection('apiKeyCredentials').findOne({ keyId: item.keyId });
      expect(record?.['tenantId'], `key ${item.keyId} is not this tenant's`).toBe(alpha.tenantId);
    }
  });
});

describe('the dev mailbox route', () => {
  it('will not list messages without an address', async () => {
    // Never a listing of who the customers are.
    const response = await request(app.getHttpServer()).get('/v1/dev/outbound-emails/latest');
    expect(response.status).toBe(400);
    expect((response.body as Json)['code']).toBe('VALIDATION_FAILED');
  });

  it('answers 404 for an address it has sent nothing to', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dev/outbound-emails/latest')
      .query({ email: `nobody-${randomUUID()}@example.test` });
    expect(response.status).toBe(404);
  });

  it('reads back the message actually sent to the tenant', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dev/outbound-emails/latest')
      .query({ kind: 'EMAIL_VERIFICATION', email: alpha.email });
    expect(response.status).toBe(200);
    const body = response.body as Json;
    expect(body['to']).toBe(alpha.email);
    expect(body['kind']).toBe('EMAIL_VERIFICATION');
    expect(body['token']).toBeTypeOf('string');
  });
});
