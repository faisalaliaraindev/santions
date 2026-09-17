/**
 * The whole thing, live: a stranger becomes a customer and runs one real SEC-backed search.
 *
 * # What makes this different from `tests/e2e/tenant-onboarding-e2e.test.ts`
 *
 * That suite proves the join — signup, confirmation, sign-in, both keys, a search — against the
 * **fixture** server, with every record stamped `MOCK`. It deliberately stops short of a live
 * search, and its own header says why: a live search contacts a real publisher under our user
 * agent, against a free tier shared by every tenant, and that is not a test suite's to trigger.
 *
 * This file is the one that does it, once, deliberately. Everything else is identical on purpose:
 * the tenant creates itself over HTTP, mints its **own live key**, and every customer call after
 * that authenticates with that key. No seeded credential, no admin key, no JWT, no tenant id in a
 * payload, no record written by hand.
 *
 * # Two gates, and neither is a guard somebody can invert
 *
 * **It is not in any project a normal run executes.** `vitest.config.mts` puts it in a project
 * called `live`, and `pnpm verify:local` and CI both enumerate their projects by name. `pnpm
 * test:unit`, `test:integration`, `test:security` and `test:e2e:api` cannot reach this file.
 *
 * **It refuses without `SEC_LIVE_E2E=yes-contact-the-sec`.** Running `pnpm test:live` with the
 * variable unset fails with an explanation rather than making a request.
 *
 * # What it costs the SEC
 *
 * One poll of the litigation-releases feed, one `robots.txt` on a cold process, and one document
 * fetch per lead that matches the subject — three or four requests, out of a hundred and twenty
 * an hour. The count is asserted, not hoped for: `FixedFeedPollCache` reports exactly how many
 * requests were put on the wire for the feed URL, and this file fails if it is more than one.
 *
 * # What it proves that a 200 does not
 *
 * A search returning `SUCCEEDED` proves nothing on its own — a fixture returns `SUCCEEDED` too.
 * So the assertions below are about **provenance**: the run is `live`, the findings' source is
 * `sec-litigation-releases`, their adapter mode is `LIVE`, no fixture source appears anywhere in
 * the run's outcomes, and the source health record moved by the number of requests actually made.
 *
 * Requires the local stack (`pnpm local:up && pnpm local:bootstrap`) and an ACTIVE, approved
 * `sec-litigation-releases` version with `robotsPosition: HONOURED`.
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
import { FixedFeedPollCache } from '../../apps/api/src/sources/feed-poll-cache.js';

const CONFIRMATION = 'yes-contact-the-sec';
const SEC_SOURCE_ID = 'sec-litigation-releases';
const SEC_FEED_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss';

/**
 * A person the SEC has actually published a litigation release about.
 *
 * Chosen from the feed as it stood, so the run has something to find. If the release ages out of
 * the feed this run returns `NO_MATCHES_FOUND` — still a terminal result from a live source and
 * still a pass for everything this file is asserting, because what is under test is the path, not
 * whether a particular person is currently in a list we do not control.
 */
const SUBJECT_NAME = 'Jon P. Kipp';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const PASSWORD = 'harbour-lantern-drift-98';

/**
 * Live mode, and **no `FIXTURE_SERVER_URL`**.
 *
 * Its absence is load-bearing rather than tidy. In live mode a fixture adapter cannot be built at
 * all (`MockModeWitness`), so pointing this at the fixture host would either do nothing or make
 * the result ambiguous — and an ambiguous live result is the one thing this file exists to rule
 * out.
 */
const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ADVERSE_SEARCH_MODE: 'live',
  MONGODB_URI,
  OIDC_ISSUER: 'https://issuer.test/realms/adverse-search',
  OIDC_CLIENT_ID: 'adverse-search-panel',
  OIDC_CLIENT_SECRET: 'test-only-secret-value',
  OIDC_AUDIENCE: 'adverse-search-api',
  SESSION_SECRET: 'test-only-session-secret-value',
  SESSION_COOKIE_SECURE: 'false',
  CORS_ORIGINS: '',

  // The honest user agent. Live mode refuses to start without one, which is the correct
  // behaviour and is why this is not defaulted to something plausible here.
  FETCH_CONTACT_URL:
    process.env['FETCH_CONTACT_URL'] ?? 'https://erlystage.com/bots/adverse-search',

  AWS_REGION: process.env['AWS_REGION'] ?? 'eu-west-2',
  AWS_ENDPOINT_URL: process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566',
  AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
  AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
  JOBS_QUEUE_URL:
    process.env['JOBS_QUEUE_URL'] ?? 'http://127.0.0.1:28566/000000000000/adverse-search-jobs',
  JOBS_DEAD_LETTER_QUEUE_URL:
    process.env['JOBS_DEAD_LETTER_QUEUE_URL'] ??
    'http://127.0.0.1:28566/000000000000/adverse-search-jobs-dlq',

  SEARXNG_URL: process.env['SEARXNG_URL'] ?? 'http://127.0.0.1:28888',
  EXTRACTION_MODEL_KIND: process.env['EXTRACTION_MODEL_KIND'] ?? 'synthetic',
  MODEL_RUNTIME_URL: process.env['MODEL_RUNTIME_URL'] ?? 'http://127.0.0.1:28434',

  S3_EVIDENCE_BUCKET: process.env['S3_EVIDENCE_BUCKET'] ?? 'adverse-search-evidence-local',
  SEARCH_INDEX_KIND: process.env['SEARCH_INDEX_KIND'] ?? 'meilisearch',
  MEILI_HOST: process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700',
  MEILI_MASTER_KEY: process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me',
};

type Json = Record<string, unknown>;

interface LiveTenant {
  readonly tenantId: string;
  readonly email: string;
  readonly liveKey: string;
  readonly liveKeyId: string;
}

let app: INestApplication;
let mongo: MongoClient;
let db: Db;
let tenant: LiveTenant;
let secRequestsBefore: number;
let secSpendBefore: number;

const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'].map((ip) =>
  originKeyFor(String(TEST_ENV['SESSION_SECRET']), ip),
);

function liveAuth(): string {
  return `ApiKey ${tenant.liveKey}`;
}

async function sourceHealthRecord(): Promise<Json | null> {
  // `_id` on this collection is the source id, a string, which the driver's default `Document`
  // typing does not know. The cast is about the key's type, not about trusting the document.
  const found = await db
    .collection('sourceHealth')
    .findOne({ _id: SEC_SOURCE_ID } as unknown as Record<string, unknown>);
  return found;
}

function dailySpend(record: Json | null): number {
  const daily = (record?.['daily'] ?? {}) as Json;
  return typeof daily['spent'] === 'number' ? daily['spent'] : 0;
}

/** A field off a loosely typed document, as a string, without stringifying an object. */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

beforeAll(async () => {
  if (process.env['SEC_LIVE_E2E'] !== CONFIRMATION) {
    throw new Error(
      'This suite makes real requests to the SEC and will not run without being asked to.\n\n' +
        `    SEC_LIVE_E2E=${CONFIRMATION} pnpm test:live\n\n` +
        'Run `pnpm sec:live-smoke --yes-contact-the-sec` first. It makes one request and reports ' +
        'on it, which is a much cheaper place to find a problem than an eleven-step flow.',
    );
  }

  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongo.connect();
  db = mongo.db();

  const health = await sourceHealthRecord();
  const breaker = text(health?.['breaker'], 'CLOSED');
  if (breaker !== 'CLOSED' && breaker !== 'HALF_OPEN') {
    throw new Error(
      `${SEC_SOURCE_ID} has breaker ${breaker}, so every request in this run would be refused ` +
        'before a socket opened and the result would say nothing about the live path.\n\n' +
        `    pnpm source:health ${SEC_SOURCE_ID} --reset --reason "..."\n\n` +
        'That clears our own record. It does not clear anything at sec.gov.',
    );
  }
  secSpendBefore = dailySpend(health);

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(TEST_ENV))
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  // A search needs both halves: the publisher turns a committed outbox row into a queue message,
  // the worker consumes it and runs the pipeline. With one of them missing the run sits at
  // QUEUED for ever and the symptom looks like a provisioning fault.
  app.get(OutboxPublisher).start(250);
  app.get(WorkerRuntime).start();

  secRequestsBefore = app.get(FixedFeedPollCache).statsFor(SEC_FEED_URL).requests;

  tenant = await onboard();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await mongo?.close();
}, 60_000);

/** Signup → confirm → sign in → live key. Entirely over HTTP, nothing seeded. */
async function onboard(): Promise<LiveTenant> {
  await db
    .collection('attemptLog')
    .deleteMany({ bucket: 'SIGNUP', originKey: { $in: LOOPBACK_KEYS } });

  const email = `live-e2e-${randomUUID()}@example.test`;
  const signedUp = await request(app.getHttpServer())
    .post('/v1/signup')
    .send({ organisationName: 'Live E2E Ltd', contactEmail: email, password: PASSWORD });
  expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(201);

  const mailbox = await request(app.getHttpServer())
    .get('/v1/dev/outbound-emails/latest')
    .query({ kind: 'EMAIL_VERIFICATION', email });
  expect(mailbox.status, JSON.stringify(mailbox.body)).toBe(200);
  const token = String((mailbox.body as Json)['token']);

  const verified = await request(app.getHttpServer()).post('/v1/signup/verify').send({ token });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);

  // After confirmation, so the session's derived environment is live and may mint a live key.
  const loggedIn = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ email, password: PASSWORD });
  expect(loggedIn.status, JSON.stringify(loggedIn.body)).toBe(200);
  const sessionToken = String((loggedIn.body as Json)['sessionToken']);

  const issued = await request(app.getHttpServer())
    .post('/v1/tenant/api-keys')
    .set('Authorization', `Session ${sessionToken}`)
    .send({ label: 'live e2e key', roles: ['tenant_admin', 'analyst'], environment: 'live' });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const key = issued.body as Json;
  expect(key['environment']).toBe('live');

  return {
    tenantId: String((signedUp.body as Json)['tenantId']),
    email,
    liveKey: String(key['secret']),
    liveKeyId: String(key['keyId']),
  };
}

describe('a newly signed-up tenant runs one real SEC-backed search', () => {
  let searchId: string;
  let settled: Json;
  let findingsBody: Json;

  it('creates a subject with its own live key', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', liveAuth())
      .send({
        fullName: SUBJECT_NAME,
        aliases: [],
        countryContext: ['US'],
        // `dateOfBirth` is `.optional()` rather than `.nullable()`, so it is omitted rather than
        // sent as null — and a date of birth is not something a live SEC search needs.
        knownCompanies: [],
        externalSubjectRef: `live-e2e-${randomUUID()}`,
        purpose: 'CUSTOMER_ONBOARDING',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const subject = created.body as Json;
    expect(subject['tenantId'] ?? tenant.tenantId).toBeTruthy();

    const accepted = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', liveAuth())
      .set('Idempotency-Key', randomUUID())
      .send({
        subjectRef: { subjectId: subject['subjectId'], version: subject['version'] },
        externalCaseRef: 'sec-live-e2e',
        requestedScope: {
          // US and English, because that is what the SEC source is approved for. A scope the
          // source does not cover takes it off the ladder and the run proves nothing.
          jurisdictions: ['US'],
          languages: ['en'],
          includeFormerDirectorships: false,
          fromDate: null,
        },
        environment: 'live',
      });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    searchId = String((accepted.body as Json)['searchId']);
  });

  it('reaches a terminal execution state', async () => {
    const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
    const deadline = Date.now() + 180_000;
    let last: Json = {};

    while (Date.now() < deadline) {
      const response = await request(app.getHttpServer())
        .get(`/v1/searches/${searchId}`)
        .set('Authorization', liveAuth());
      expect(response.status).toBe(200);
      last = response.body as Json;
      if (terminal.has(String(last['execution']))) {
        settled = last;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(
      settled,
      `search ${searchId} never settled; last seen ${JSON.stringify(last)}`,
    ).toBeDefined();
    // `PARTIAL` is terminal and is an honest live outcome — a source refused mid-run is a
    // coverage gap, not a failure of this path. `FAILED` is not: nothing usable came back.
    expect(['SUCCEEDED', 'PARTIAL'], JSON.stringify(settled)).toContain(
      String(settled['execution']),
    );
    expect(settled['environment']).toBe('live');
  });

  it('retrieves the result with its own live key', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}/findings`)
      .set('Authorization', liveAuth());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    findingsBody = response.body as Json;

    for (const field of ['execution', 'findingsState', 'coverage', 'noMatchStatement', 'mode']) {
      expect(findingsBody, `findings page is missing ${field}`).toHaveProperty(field);
    }
    // The whole point. A fixture run says MOCK here.
    expect(findingsBody['mode']).toBe('LIVE');
  });

  it('proves the SEC source was the one consulted, and no fixture stood in for it', async () => {
    const run = await db.collection('searchRuns').findOne({ searchId });
    expect(run, 'the run record').toBeTruthy();

    const outcomes = JSON.stringify(run?.['sourceOutcomes'] ?? []);
    expect(outcomes).toContain(SEC_SOURCE_ID);
    // Every fixture source id the bootstrap seeds. If one appears in a live run, the mode split
    // has failed and the result is not what it says it is.
    for (const fixture of [
      'fixture-newsroom',
      'fixture-court',
      'src-mock-news-discovery',
      'src-mock-web-discovery',
      'src-mock-primary',
      'src-mock-cr-registry',
      'src-mock-fetch',
      'src-mock-extraction',
    ]) {
      expect(outcomes, `a fixture source appeared in a live run: ${fixture}`).not.toContain(
        fixture,
      );
    }
  });

  it('made one request to the feed, not one per planned query', () => {
    const stats = app.get(FixedFeedPollCache).statsFor(SEC_FEED_URL);
    const issued = stats.requests - secRequestsBefore;

    // The regression, stated as the number the publisher would see. Before the poll cache this
    // was one per F1 query — per name form, per language, per jurisdiction — and unbounded
    // across runs.
    expect(issued, `the SEC feed was polled ${String(issued)} times in one search`).toBe(1);
    expect(stats.served).toBeGreaterThanOrEqual(stats.requests);
  });

  it('moved the source budget by the number of requests actually made', async () => {
    const after = await sourceHealthRecord();
    const spent = dailySpend(after) - secSpendBefore;

    // Every request the adapter puts on the wire spends one: the feed, `robots.txt` on a cold
    // process, and one per document fetched. A handful, and bounded — not forty.
    expect(spent).toBeGreaterThan(0);
    expect(spent, `one search spent ${String(spent)} of the SEC's budget`).toBeLessThanOrEqual(10);
    expect(text(after?.['lastSuccessAt'])).not.toBe('');
  });

  it('kept the result inside the tenant that ran it', async () => {
    const run = await db.collection('searchRuns').findOne({ searchId });
    expect(run?.['tenantId']).toBe(tenant.tenantId);

    // A second tenant, created the same way, must not be able to read it — 404, because a
    // tenant is not told that somebody else's record exists.
    const other = await onboard();
    const peek = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}`)
      .set('Authorization', `ApiKey ${other.liveKey}`);
    expect(peek.status).toBe(404);
  });
});
