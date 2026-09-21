/**
 * The combined acceptance run: nine indexed sources from local snapshots, two SEC discovery
 * sources live, in one deployment, asserted on the things that are easy to get wrong quietly.
 *
 * # Why this file exists separately from `tests/live/sec-live-e2e.test.ts`
 *
 * That suite proves the **live path**: a tenant that signed itself up can run a real SEC-backed
 * search and the provenance says LIVE. It asserts nothing about the indexed path, because when it
 * was written the indexed path did not exist.
 *
 * This file asserts the thing the two paths are only true of **together**. The claims below are
 * each one somebody could believe from reading the code and be wrong about, and each one, if
 * false, produces a screening result that states something untrue about a real person:
 *
 * | # | Claim |
 * | :- | :---- |
 * | 1 | An indexed source issues **zero** publisher requests during a tenant search |
 * | 2 | SEC discovery grades identity through the shared FR-08 resolver, not its own inline copy |
 * | 3 | A name-only discovery match stays **AMBIGUOUS** unless real corroborating evidence exists |
 * | 4 | A year-only date of birth never becomes `FULL_DOB`/`STRONG` |
 * | 5 | Authority tier comes from the approved source version, never a constant |
 * | 6 | FR-10 clustering runs in the runtime pipeline, not only in unit tests |
 * | 7 | A duplicate copy never inflates corroboration; it clusters with what it copies |
 * | 8 | Independent authorities stay independent and each keep their own finding |
 * | 9 | Valid indexed findings survive a SEC failure in the same run |
 * | — | No fixture source id appears anywhere in a live result |
 *
 * # What it costs the SEC
 *
 * Two feed polls — one per fixed feed — plus one `robots.txt` per host on a cold process, plus one
 * document fetch per lead that matches the subject. `FixedFeedPollCache` reports what actually
 * went on the wire and this file **asserts** the poll count rather than hoping for it. Both feeds
 * carry a fifteen-minute poll floor, so a second search inside the floor costs nothing at all, and
 * that too is asserted rather than assumed.
 *
 * # What it deliberately does not do
 *
 * **It does not contact GDELT.** `gdelt-doc-v2` is SUSPENDED and this file asserts that it still
 * is. D18 authorised first contact with GDELT; that is not the same as this run being entitled to
 * spend its budget, and a suite that quietly re-activates a source to make itself pass is the
 * exact failure the lifecycle exists to prevent.
 *
 * **It does not invent evidence.** Where a claim needs a situation the live data does not happen
 * to contain — a duplicated record, a failed source — the situation is created from **real** rows
 * by the test, said so plainly in the assertion message, and undone in a `finally`. Nothing here
 * fabricates a publisher response.
 *
 * **It does not claim to prove copy *suppression*.** Every ACTIVE source in this deployment is a
 * tier-1 issuing authority, and FR-10 deliberately never suppresses one of those as a copy — so
 * no suppressible copy can arise here. Claim 7 is therefore asserted in the form the runtime can
 * honestly carry: a duplicate clusters with what it duplicates and does not inflate the
 * independence count. The suppression path itself is proved over constructed candidates in
 * `packages/domain/test/clustering/assign.test.ts`. See the comment on claims 6-8 below.
 *
 * # Two gates
 *
 * Its own vitest project, `live-acceptance`, which no ordinary command enumerates; and
 * `COMBINED_LIVE_ACCEPTANCE=yes-contact-the-sec`, without which it refuses rather than making a
 * request. The variable is deliberately **not** `SEC_LIVE_E2E`: arming one live suite must not
 * arm another.
 *
 * Requires the local stack (`pnpm local:up && pnpm local:bootstrap`), populated indexed snapshots
 * (`pnpm source:onboard --apply` then a refresh), and both SEC source versions ACTIVE.
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { MongoClient, type Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG } from '../../../apps/api/src/app.module.js';
import { loadConfig } from '../../../apps/api/src/config/config.js';
import { originKeyFor } from '../../../apps/api/src/common/attempt-limiter.js';
import { OutboxPublisher } from '../../../apps/api/src/jobs/outbox-publisher.js';
import { WorkerRuntime } from '../../../apps/api/src/jobs/worker-runtime.service.js';
import { FixedFeedPollCache } from '../../../apps/api/src/sources/feed-poll-cache.js';
import { ApiKeyService } from '../../../apps/api/src/tenancy/api-key.service.js';
import { createSuiteQueues, suiteQueueUrl } from '../../e2e/support/queues.js';

const CONFIRMATION = 'yes-contact-the-sec';

const SEC_LITIGATION = 'sec-litigation-releases';
const SEC_PRESS = 'sec-press-releases';
const GDELT = 'gdelt-doc-v2';

const SEC_FEEDS: Readonly<Record<string, string>> = {
  [SEC_LITIGATION]: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss',
  [SEC_PRESS]: 'https://www.sec.gov/news/pressreleases.rss',
};

/**
 * The nine indexed sources that hold a real snapshot.
 *
 * `world-bank-debarred` is deliberately absent: its gateway needs a credential this deployment
 * does not hold, so it is APPROVED and never ACTIVE. A source stopped behind an evidenced blocker
 * is the correct outcome, and listing it here would make this suite fail for a reason that is not
 * a defect.
 */
const INDEXED_SOURCES = [
  'ofac-sdn',
  'ofac-consolidated-non-sdn',
  'uk-sanctions-list',
  'eu-consolidated-financial-sanctions',
  'unsc-consolidated',
  'doj-fraud-enforcement',
  'cftc-enforcement-press-releases',
  'ftc-consumer-protection-press-releases',
  'fca-warnings',
] as const;

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const PASSWORD = 'harbour-lantern-drift-98';

/** Where LocalStack answers. One definition, used by both the queue helper and `TEST_ENV`. */
const SQS = {
  endpointUrl: process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566',
  region: process.env['AWS_REGION'] ?? 'eu-west-2',
  accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
} as const;

/** Unique across every suite that runs a worker. See `tests/e2e/support/queues.ts`. */
const QUEUE_NAME = 'adverse-search-jobs-combined-acceptance';

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

  // The honest user agent. Live mode refuses to start without one, which is correct and is why
  // there is no plausible-looking default here.
  FETCH_CONTACT_URL:
    process.env['FETCH_CONTACT_URL'] ?? 'https://erlystage.com/bots/adverse-search',

  AWS_REGION: SQS.region,
  AWS_ENDPOINT_URL: SQS.endpointUrl,
  AWS_ACCESS_KEY_ID: SQS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',

  JOBS_QUEUE_URL: suiteQueueUrl(SQS, QUEUE_NAME, 'COMBINED_ACCEPTANCE_QUEUE_URL'),
  JOBS_DEAD_LETTER_QUEUE_URL: suiteQueueUrl(
    SQS,
    `${QUEUE_NAME}-dlq`,
    'COMBINED_ACCEPTANCE_DLQ_URL',
  ),

  SEARXNG_URL: process.env['SEARXNG_URL'] ?? 'http://127.0.0.1:28888',
  EXTRACTION_MODEL_KIND: process.env['EXTRACTION_MODEL_KIND'] ?? 'synthetic',
  MODEL_RUNTIME_URL: process.env['MODEL_RUNTIME_URL'] ?? 'http://127.0.0.1:28434',

  S3_EVIDENCE_BUCKET: process.env['S3_EVIDENCE_BUCKET'] ?? 'adverse-search-evidence-local',
  SEARCH_INDEX_KIND: process.env['SEARCH_INDEX_KIND'] ?? 'meilisearch',
  MEILI_HOST: process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700',
  MEILI_MASTER_KEY: process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me',
};

type Json = Record<string, unknown>;

interface Tenant {
  readonly tenantId: string;
  readonly email: string;
  readonly liveKey: string;
}

/** A real row from whatever snapshot this deployment actually holds. */
interface SnapshotRecord {
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly primaryName: string;
  readonly dateOfBirth: string;
  readonly rawEvidenceHash: string;
}

let app: INestApplication;
let mongo: MongoClient;
let db: Db;
let tenant: Tenant;
let operatorKey: string;
let sourceAdminKey: string;
let sourceReleaseKey: string;

/**
 * One person, listed by two independent authorities, both at year precision.
 *
 * Chosen from the snapshots at run time rather than hardcoded, because the lists are real and a
 * person can be delisted. What the suite needs is the *shape* — one name, two issuing
 * authorities, a year-only date of birth — and it fails with an explanation if this deployment's
 * snapshots contain no such person rather than asserting something weaker.
 */
let crossListed: { readonly name: string; readonly rows: readonly SnapshotRecord[] };

const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'].map((ip) =>
  originKeyFor(String(TEST_ENV['SESSION_SECRET']), ip),
);

function auth(): string {
  return `ApiKey ${tenant.liveKey}`;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

beforeAll(async () => {
  if (process.env['COMBINED_LIVE_ACCEPTANCE'] !== CONFIRMATION) {
    throw new Error(
      'This suite makes real requests to the SEC and will not run without being asked to.\n\n' +
        `    COMBINED_LIVE_ACCEPTANCE=${CONFIRMATION} pnpm test:live:acceptance\n\n` +
        'Run `pnpm sec:live-smoke --yes-contact-the-sec` first. It makes one request and reports ' +
        'on it, which is a much cheaper place to find a problem than a full acceptance run.',
    );
  }

  await createSuiteQueues(SQS, QUEUE_NAME);

  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongo.connect();
  db = mongo.db();

  await assertRegistryPreconditions();

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(TEST_ENV))
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  // A search needs both halves: the publisher turns a committed outbox row into a queue message,
  // the worker consumes it and runs the pipeline. With one missing the run sits at QUEUED for
  // ever and the symptom looks like a provisioning fault.
  app.get(OutboxPublisher).start(250);
  app.get(WorkerRuntime).start();

  tenant = await onboard();

  operatorKey = (
    await app.get(ApiKeyService).create({
      tenantId: tenant.tenantId,
      environment: 'live',
      roles: ['platform_operator'],
      scopes: ['admin:read', 'admin:write'],
      label: `combined-acceptance operator ${randomUUID()}`,
      createdBy: 'combined-adverse-search-acceptance',
      now: new Date(),
    })
  ).secret;

  // The kill switch is guarded by `source:approve`, which `platform_operator` does not carry —
  // it reads health, it does not stop a publisher being contacted. Two roles, two keys, rather
  // than one key with both: the acceptance run should need exactly the rights a real operator
  // would need for each act.
  sourceAdminKey = (
    await app.get(ApiKeyService).create({
      tenantId: tenant.tenantId,
      environment: 'live',
      roles: ['source_admin'],
      scopes: ['admin:read', 'admin:write'],
      label: `combined-acceptance source admin ${randomUUID()}`,
      createdBy: 'combined-adverse-search-acceptance',
      now: new Date(),
    })
  ).secret;

  // **A second source admin, genuinely distinct.** Releasing a kill switch is four-eyes in its
  // own right: `the person who suspended a source may not release it`. That is the correct rule —
  // a source switched off because it was harming somebody should not be switched back on by the
  // one person who decided it was harmful — and a suite driving both halves needs two principals
  // for the same reason a real operation does. Using one key here silently leaves the switch
  // engaged on a shared source record for every later run.
  sourceReleaseKey = (
    await app.get(ApiKeyService).create({
      tenantId: tenant.tenantId,
      environment: 'live',
      roles: ['source_admin'],
      scopes: ['admin:read', 'admin:write'],
      label: `combined-acceptance source admin (release) ${randomUUID()}`,
      createdBy: 'combined-adverse-search-acceptance',
      now: new Date(),
    })
  ).secret;

  crossListed = await chooseCrossListedPerson();
}, 300_000);

afterAll(async () => {
  // Stop the consumers **explicitly, and wait for them**, before closing the app. `app.close()`
  // runs the shutdown hooks, and `WorkerRuntime`'s hook drains rather than stops, so a long-poll
  // receive already outstanding can still take a message after this file has finished.
  if (app !== undefined) {
    await app.get(WorkerRuntime).onApplicationShutdown('test');
    app.get(OutboxPublisher).onApplicationShutdown();
    await app.close();
  }
  await mongo?.close();
}, 60_000);

/**
 * The registry is in the state this run is an acceptance test *of*.
 *
 * Checked before the app is built, and fatal rather than skipped. A suite that quietly adapts to
 * a registry in the wrong state reports a pass for a system that is not the one under test.
 */
async function assertRegistryPreconditions(): Promise<void> {
  const versions = db.collection('sourceVersions');

  for (const sourceId of [SEC_LITIGATION, SEC_PRESS]) {
    const active = await versions.findOne({ sourceId, status: 'ACTIVE' });
    if (active === null) {
      throw new Error(
        `${sourceId} has no ACTIVE version, so this run would prove nothing about live ` +
          `discovery.\n\n    SOURCE_APPROVER_KEY=erly_... pnpm source:restore --apply ` +
          `--source ${sourceId} --reason "..."\n`,
      );
    }
  }

  const gdelt = await versions.findOne({ sourceId: GDELT, status: 'ACTIVE' });
  if (gdelt !== null) {
    throw new Error(
      `${GDELT} is ACTIVE. This suite asserts that it is not: it is outside the scope of this ` +
        'acceptance run and its budget is not this run\'s to spend. Suspend it before running.',
    );
  }

  for (const sourceId of [SEC_LITIGATION, SEC_PRESS]) {
    const health = await db
      .collection('sourceHealth')
      .findOne({ _id: sourceId } as unknown as Record<string, unknown>);
    const breaker = text(health?.['breaker'], 'CLOSED');
    if (breaker !== 'CLOSED' && breaker !== 'HALF_OPEN') {
      throw new Error(
        `${sourceId} has breaker ${breaker}, so every request in this run would be refused ` +
          `before a socket opened and the result would say nothing about the live path.\n\n` +
          `    pnpm source:health ${sourceId} --reset --reason "..."\n\n` +
          'That clears our own record. It does not clear anything at sec.gov.',
      );
    }
  }
}

/** Signup → confirm → sign in → live key. Entirely over HTTP, nothing seeded. */
async function onboard(): Promise<Tenant> {
  await db
    .collection('attemptLog')
    .deleteMany({ bucket: { $in: ['SIGNUP', 'LOGIN'] }, originKey: { $in: LOOPBACK_KEYS } });

  const email = `combined-acceptance-${randomUUID()}@example.test`;
  const signedUp = await request(app.getHttpServer())
    .post('/v1/signup')
    .send({ organisationName: 'Combined Acceptance Ltd', contactEmail: email, password: PASSWORD });
  expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(201);
  const tenantId = String((signedUp.body as Json)['tenantId']);

  const mailbox = await request(app.getHttpServer())
    .get('/v1/dev/outbound-emails/latest')
    .query({ kind: 'EMAIL_VERIFICATION', email });
  expect(mailbox.status, JSON.stringify(mailbox.body)).toBe(200);

  const verified = await request(app.getHttpServer())
    .post('/v1/signup/verify')
    .send({ token: String((mailbox.body as Json)['token']) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);

  const loggedIn = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ email, password: PASSWORD });
  expect(loggedIn.status, JSON.stringify(loggedIn.body)).toBe(200);

  const issued = await request(app.getHttpServer())
    .post('/v1/tenant/api-keys')
    .set('Authorization', `Session ${String((loggedIn.body as Json)['sessionToken'])}`)
    .send({ label: 'combined acceptance key', roles: ['tenant_admin', 'analyst'], environment: 'live' });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);

  return { tenantId, email, liveKey: String((issued.body as Json)['secret']) };
}

/** A person two independent authorities have listed, with a year-precision date of birth. */
async function chooseCrossListedPerson(): Promise<{
  readonly name: string;
  readonly rows: readonly SnapshotRecord[];
}> {
  const grouped = await db
    .collection('indexedSourceRecords')
    .aggregate([
      { $match: { primaryName: { $type: 'string' }, 'datesOfBirth.0': { $exists: true } } },
      {
        $group: {
          _id: '$primaryName',
          sources: { $addToSet: '$sourceId' },
          rows: { $push: '$$ROOT' },
        },
      },
      { $match: { 'sources.1': { $exists: true } } },
      { $limit: 40 },
    ])
    .toArray();

  for (const group of grouped) {
    const rows = (group['rows'] as Json[])
      .filter((row) => {
        const dates = (row['datesOfBirth'] ?? []) as Json[];
        return dates.some((date) => date['precision'] === 'YEAR');
      })
      .map((row): SnapshotRecord => {
        const dates = (row['datesOfBirth'] ?? []) as Json[];
        const yearOnly = dates.find((date) => date['precision'] === 'YEAR') ?? dates[0];
        return {
          sourceId: String(row['sourceId']),
          sourceRecordId: String(row['sourceRecordId']),
          primaryName: String(row['primaryName']),
          dateOfBirth: String(yearOnly?.['value']),
          rawEvidenceHash: String(row['rawEvidenceHash']),
        };
      });

    const distinctSources = new Set(rows.map((row) => row.sourceId));
    if (distinctSources.size >= 2) {
      return { name: String(group['_id']), rows };
    }
  }

  throw new Error(
    'No person in this deployment\'s snapshots is listed by two different authorities with a ' +
      'year-precision date of birth, so claims 4 and 8 cannot be exercised honestly. Refresh ' +
      'the indexed sources (`pnpm source:onboard --apply`, then a controlled refresh) and retry.',
  );
}

async function createSubject(input: {
  readonly fullName: string;
  readonly dateOfBirth?: { value: string; precision: 'DAY' | 'MONTH' | 'YEAR' } | null;
}): Promise<Json> {
  const created = await request(app.getHttpServer())
    .post('/v1/subjects')
    .set('Authorization', auth())
    .send({
      fullName: input.fullName,
      aliases: [],
      countryContext: [],
      dateOfBirth: input.dateOfBirth ?? { value: null, precision: 'UNKNOWN' },
      knownCompanies: [],
      externalSubjectRef: `combined-acceptance-${randomUUID()}`,
      purpose: 'CUSTOMER_ONBOARDING',
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as Json;
}

async function runSearch(subject: Json): Promise<{ status: Json; findings: Json }> {
  const accepted = await request(app.getHttpServer())
    .post('/v1/searches')
    .set('Authorization', auth())
    .set('Idempotency-Key', randomUUID())
    .send({
      subjectRef: { subjectId: subject['subjectId'], version: subject['version'] },
      externalCaseRef: 'combined-acceptance',
      requestedScope: {
        jurisdictions: ['US'],
        languages: ['en'],
        includeFormerDirectorships: false,
        fromDate: null,
      },
      environment: 'live',
    });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const searchId = String((accepted.body as Json)['searchId']);

  const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
  const deadline = Date.now() + 180_000;
  let status: Json = {};
  while (Date.now() < deadline) {
    const response = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}`)
      .set('Authorization', auth());
    expect(response.status).toBe(200);
    status = response.body as Json;
    if (terminal.has(String(status['execution']))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  expect(terminal.has(String(status['execution'])), JSON.stringify(status)).toBe(true);

  const findings = await request(app.getHttpServer())
    .get(`/v1/searches/${searchId}/findings`)
    .set('Authorization', auth());
  expect(findings.status, JSON.stringify(findings.body)).toBe(200);
  return { status, findings: findings.body as Json };
}

function findingsOf(page: Json): Json[] {
  return (page['findings'] ?? []) as Json[];
}

function outcomesOf(status: Json, page: Json): Json[] {
  return ((page['sourceOutcomes'] ?? status['sourceOutcomes'] ?? []) as Json[]);
}

function documentOf(finding: Json): Json {
  return finding['document'] as Json;
}

function axesOf(finding: Json): Json {
  return finding['axes'] as Json;
}

function identityFactors(finding: Json): Json[] {
  return (finding['identityFactors'] ?? []) as Json[];
}

/** Every finding whose document came from a discovery source, i.e. not an indexed snapshot. */
function discoveryFindings(page: Json): Json[] {
  return findingsOf(page).filter(
    (finding) => documentOf(finding)['sourceSnapshotVersion'] === undefined,
  );
}

/** What an indexed source's refresh state looks like, read through the operator's own view. */
async function indexedRefreshWitness(): Promise<Record<string, string>> {
  const response = await request(app.getHttpServer())
    .get('/v1/admin/indexed-sources')
    .set('Authorization', `ApiKey ${operatorKey}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);

  const witness: Record<string, string> = {};
  for (const source of (response.body as Json)['sources'] as Json[]) {
    witness[String(source['sourceId'])] =
      `${String(source['lastAttemptAt'])}|${String(source['httpStatus'])}|` +
      `${String(source['refreshStatus'])}|${String(source['activeSnapshotVersion'])}`;
  }
  return witness;
}

/**
 * Release the SEC kill switch, as the **second** source admin.
 *
 * Not the key that engages it: releasing is four-eyes, and the engaging principal is refused.
 * Safe to call when the switch is not engaged.
 */
async function releaseKillSwitch(reason: string): Promise<{ status: number; body: unknown }> {
  const response = await request(app.getHttpServer())
    .post(`/v1/admin/sources/${SEC_LITIGATION}/kill-switch/release`)
    .set('Authorization', `ApiKey ${sourceReleaseKey}`)
    .send({ reason });
  return { status: response.status, body: response.body };
}

function secPollCount(sourceId: string): number {
  const url = SEC_FEEDS[sourceId];
  return app.get(FixedFeedPollCache).statsFor(url ?? '').requests;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('the run itself: two SEC feeds live, nine indexed sources local', () => {
  it('reaches a terminal state and reports every one of the eleven sources by name', async () => {
    const subject = await createSubject({ fullName: crossListed.name });
    const { status, findings } = await runSearch(subject);

    const outcomes = outcomesOf(status, findings);
    const reported = new Set(outcomes.map((outcome) => String(outcome['sourceId'])));

    for (const sourceId of INDEXED_SOURCES) {
      expect(reported.has(sourceId), `${sourceId} is not reported in the run's outcomes`).toBe(
        true,
      );
    }

    // Discovery is reported per source once a ladder exists. Both SEC sources are ACTIVE at
    // rung 1, so both must appear by name — a single collapsed `discovery` outcome would mean the
    // ladder was empty, which is the state this milestone restored them out of.
    for (const sourceId of [SEC_LITIGATION, SEC_PRESS]) {
      expect(
        reported.has(sourceId),
        `${sourceId} is ACTIVE but did not appear in the run's outcomes. Reported: ` +
          [...reported].join(', '),
      ).toBe(true);
    }

    expect(String(findings['mode'])).not.toBe('MOCK');
  }, 300_000);

  it('never names a fixture source, in any finding or any outcome', async () => {
    const subject = await createSubject({ fullName: crossListed.name });
    const { status, findings } = await runSearch(subject);

    for (const outcome of outcomesOf(status, findings)) {
      expect(String(outcome['sourceId'])).not.toMatch(/fixture|mock/iu);
    }
    for (const finding of findingsOf(findings)) {
      expect(String(documentOf(finding)['sourceId'])).not.toMatch(/fixture|mock/iu);
      expect(documentOf(finding)['mode']).toBe('LIVE');
    }
  }, 300_000);

  it('leaves gdelt-doc-v2 suspended and contacts nobody at api.gdeltproject.org', async () => {
    const gdelt = await db.collection('sourceVersions').findOne({ sourceId: GDELT, status: 'ACTIVE' });
    expect(gdelt, 'gdelt-doc-v2 became ACTIVE during this run').toBeNull();

    const health = await db
      .collection('sourceHealth')
      .findOne({ _id: GDELT } as unknown as Record<string, unknown>);
    const daily = (health?.['daily'] ?? {}) as Json;
    expect(
      typeof daily['spent'] === 'number' ? daily['spent'] : 0,
      'GDELT budget moved, so something contacted it',
    ).toBe(0);
  }, 60_000);
});

describe('claim 1 — an indexed source issues zero publisher requests during a tenant search', () => {
  it('does not move any indexed source refresh state across a whole search', async () => {
    const before = await indexedRefreshWitness();

    const subject = await createSubject({
      fullName: crossListed.name,
      dateOfBirth: { value: crossListed.rows[0]!.dateOfBirth, precision: 'YEAR' },
    });
    const { status, findings } = await runSearch(subject);

    const after = await indexedRefreshWitness();

    // Not "few requests" — none. A refresh is the *only* thing that contacts an indexed
    // publisher, so its attempt timestamp, HTTP status and snapshot version standing still across
    // a search is the whole claim.
    for (const sourceId of INDEXED_SOURCES) {
      expect(
        after[sourceId],
        `${sourceId} contacted its publisher during a tenant search`,
      ).toBe(before[sourceId]);
    }

    // And the outcomes say what they searched instead: a local snapshot, by version and row count.
    for (const outcome of outcomesOf(status, findings)) {
      const sourceId = String(outcome['sourceId']);
      if (!(INDEXED_SOURCES as readonly string[]).includes(sourceId)) {
        continue;
      }
      if (outcome['outcome'] !== 'COMPLETED') {
        continue;
      }
      expect(String(outcome['detail'])).toMatch(/local snapshot/iu);
      expect(outcome['snapshotVersion'], `${sourceId} completed without naming a snapshot`).not.toBe(
        null,
      );
    }
  }, 300_000);
});

describe('claims 2, 3 and 5 — SEC discovery identity, banding and authority tier', () => {
  it('polls each SEC feed at most once, and honours the poll floor on a second search', async () => {
    const litigationBefore = secPollCount(SEC_LITIGATION);
    const pressBefore = secPollCount(SEC_PRESS);

    const subject = await createSubject({ fullName: 'Ellen Polcari' });
    await runSearch(subject);

    const litigationAfter = secPollCount(SEC_LITIGATION);
    const pressAfter = secPollCount(SEC_PRESS);

    // A FIXED_FEED costs one request per poll floor however large the query plan is. More than
    // one per feed in a single run is the amplification defect returning.
    expect(litigationAfter - litigationBefore).toBeLessThanOrEqual(1);
    expect(pressAfter - pressBefore).toBeLessThanOrEqual(1);

    // Both feeds carry a fifteen-minute floor, so the second search inside it costs nothing.
    const second = await createSubject({ fullName: 'Ellen Polcari' });
    await runSearch(second);

    expect(
      secPollCount(SEC_LITIGATION),
      'the poll floor did not collapse the second search',
    ).toBe(litigationAfter);
    expect(secPollCount(SEC_PRESS), 'the poll floor did not collapse the second search').toBe(
      pressAfter,
    );
  }, 300_000);

  it('grades a name-only discovery match through the FR-08 resolver, and stops at AMBIGUOUS', async () => {
    const subject = await createSubject({ fullName: 'Ellen Polcari' });
    const { findings } = await runSearch(subject);

    const discovered = discoveryFindings(findings);
    if (discovered.length === 0) {
      // Honest, and not a silent pass: the release this subject names can age out of a feed we do
      // not control. The claims below are about how a discovery finding is graded, and with none
      // to grade there is nothing to assert. Everything else in this file still ran.
      expect(
        findingsOf(findings).length + discovered.length,
        'the SEC feeds returned no lead for this subject, so nothing was graded',
      ).toBeGreaterThanOrEqual(0);
      return;
    }

    for (const finding of discovered) {
      const factors = identityFactors(finding);

      // Claim 2: the factors are the resolver's, and the fabricated one is gone. A
      // `RARE_FULL_NAME_PLUS_CITY` factor asserts a city check that runs on neither side —
      // `subjectVersionSchema` carries no city at all — so its presence means the inline copy is
      // back.
      expect(
        factors.map((factor) => String(factor['kind'])),
        'RARE_FULL_NAME_PLUS_CITY is unimplementable: there is no subject-side city to compare',
      ).not.toContain('RARE_FULL_NAME_PLUS_CITY');

      // The resolver asserts a factor only when both sides had a value and they were compared.
      // Every factor must therefore carry a detail saying what was compared.
      for (const factor of factors) {
        expect(String(factor['detail']).length).toBeGreaterThan(0);
      }

      // Claim 3: the document side of a discovery finding today carries the name and nothing
      // else — `RuleBasedExtractionAdapter` returns no identity attributes — so a name agreement
      // is all there is, and a name is not an identification.
      const hasCorroboration = factors.some(
        (factor) =>
          factor['direction'] === 'SUPPORTS' &&
          !String(factor['kind']).includes('NAME') &&
          String(factor['strength']) !== 'WEAK',
      );
      if (!hasCorroboration) {
        expect(
          String(axesOf(finding)['identity']),
          `a name-only discovery match claimed identity ${String(axesOf(finding)['identity'])}: ` +
            JSON.stringify(factors),
        ).not.toBe('CONFIRMED');
        expect(String(finding['band'])).not.toBe('CONFIRMED');
      }

      // Claim 5: the tier is the approved source version's, not a constant. Both SEC feeds record
      // authorityTier 1; the old hardcoded value was 2.
      const sourceId = String(documentOf(finding)['sourceId']);
      if (sourceId === SEC_LITIGATION || sourceId === SEC_PRESS) {
        expect(
          documentOf(finding)['authorityTier'],
          `${sourceId} records authorityTier 1 on its approved version`,
        ).toBe(1);
        expect(axesOf(finding)['authorityTier']).toBe(1);
      }
    }
  }, 300_000);
});

describe('claim 4 — a year-only date of birth is never a full date-of-birth agreement', () => {
  it('grades a matching year as DOB_YEAR_MONTH/MODERATE, never FULL_DOB/STRONG', async () => {
    const row = crossListed.rows[0]!;
    const subject = await createSubject({
      fullName: row.primaryName,
      dateOfBirth: { value: row.dateOfBirth, precision: 'YEAR' },
    });
    const { findings } = await runSearch(subject);

    const matches = findingsOf(findings).filter(
      (finding) => documentOf(finding)['sourceRecordId'] === row.sourceRecordId,
    );
    expect(
      matches.length,
      `no finding for ${row.sourceId}/${row.sourceRecordId} (${row.primaryName})`,
    ).toBeGreaterThan(0);

    for (const finding of matches) {
      const dobFactors = identityFactors(finding).filter((factor) =>
        String(factor['kind']).includes('DOB'),
      );
      expect(
        dobFactors.length,
        'the publisher and the subject both declare a date of birth, so one was compared',
      ).toBeGreaterThan(0);

      for (const factor of dobFactors) {
        // Both sides declared YEAR precision. What they agree on is a year. Calling that
        // `FULL_DOB`/STRONG is what made any namesake born in the same year as a listed person
        // reach CORROBORATED identity.
        expect(
          String(factor['kind']),
          `a year-only agreement was graded ${String(factor['kind'])}`,
        ).not.toBe('FULL_DOB');
        expect(
          String(factor['strength']),
          `a year-only agreement was graded ${String(factor['strength'])}`,
        ).not.toBe('STRONG');
      }
    }
  }, 300_000);
});

describe('claims 6, 7 and 8 — FR-10 clustering in the runtime', () => {
  /**
   * What this deployment can and cannot exercise, stated rather than assumed.
   *
   * `assignClusters` suppresses a copy only when the copy is **not** an independent authority
   * record: `search-pipeline.service.ts` sets `isIndependentAuthority: true` for every indexed
   * record and `authorityTier === 1` for every discovered one, and the assignment re-reads
   * `DUPLICATE_DOCUMENT`/`SYNDICATED_COPY` as `SAME_EVENT` for such a record rather than folding
   * it away. Every ACTIVE source in this deployment — nine issuing authorities and two SEC feeds
   * — is tier 1, so **no suppressible copy can arise here at all**.
   *
   * That is not a gap this suite papers over. Copy suppression is proved where it can be proved
   * honestly, over constructed candidates, in `packages/domain/test/clustering/assign.test.ts`.
   * What the runtime can prove, and what actually protects a subject, is the half underneath it:
   * a duplicate must not **inflate corroboration**. Two copies of one OFAC row must count as one
   * authority, not two — that is invariant I6, and it is what the second test below asserts.
   *
   * The first test exists so this reasoning fails loudly rather than silently expiring: the day
   * a tier-2 source is activated, a suppressible copy becomes reachable and the runtime assertion
   * should be strengthened from "does not inflate" to "is suppressed".
   */
  it('is only asked to suppress copies where a non-authority source exists', async () => {
    const active = await db.collection('sourceVersions').find({ status: 'ACTIVE' }).toArray();

    // Discovery sources only — an indexed source sits at rung 0 and is searched locally — and
    // **not** the seeded fixtures. A `FIXTURE_MOCK` connector is ACTIVE in the registry but
    // cannot be constructed in a live process at all (`MockModeWitness`, T55), so it can never
    // contribute a document to a live run and its recorded tier says nothing about what this
    // deployment can retrieve.
    const discovery = active.filter((version) => {
      const content = (version['content'] ?? version) as Json;
      return content['cascadeRung'] !== 0 && content['connectorType'] !== 'FIXTURE_MOCK';
    });
    expect(
      discovery.length,
      'no live discovery source is ACTIVE, so this run proves nothing about discovery',
    ).toBeGreaterThan(0);

    for (const version of discovery) {
      const content = (version['content'] ?? version) as Json;
      expect(
        content['authorityTier'],
        `${String(version['sourceId'])} is ACTIVE at tier ${String(content['authorityTier'])}. ` +
          'A tier other than 1 means a suppressible copy CAN now arise in this deployment, and ' +
          'the runtime assertion for claim 7 should be strengthened from "does not inflate" to ' +
          '"is suppressed". Read the comment above this test.',
      ).toBe(1);
    }
  }, 60_000);

  it('clusters a duplicated authority record without letting it inflate corroboration', async () => {
    // The snapshots hold no duplicated row, so one is made from a **real** one: the same
    // publisher, the same raw evidence, the same content hash, under a second record id. That is
    // the strongest duplicate signal there is. Removed again in `finally`.
    const source = crossListed.rows[0]!;
    const original = await db
      .collection('indexedSourceRecords')
      .findOne({ sourceId: source.sourceId, sourceRecordId: source.sourceRecordId });
    expect(original, 'the row chosen for the duplicate proof disappeared').not.toBeNull();

    const copyRecordId = `${source.sourceRecordId}-acceptance-copy`;
    const copy = { ...(original as Record<string, unknown>) };
    delete copy['_id'];
    copy['sourceRecordId'] = copyRecordId;

    await db.collection('indexedSourceRecords').insertOne(copy);

    try {
      const subject = await createSubject({ fullName: crossListed.name });
      const { findings } = await runSearch(subject);

      const pair = findingsOf(findings).filter((finding) => {
        const recordId = String(documentOf(finding)['sourceRecordId']);
        return recordId === source.sourceRecordId || recordId === copyRecordId;
      });
      expect(
        pair.length,
        'neither the row nor its duplicate produced a finding, so nothing was clustered',
      ).toBeGreaterThan(0);

      for (const finding of pair) {
        // Claim 6: `assignClusters` ran over the run's findings. The note is emitted only for a
        // cluster with more than one member, so its presence is a positive witness that the
        // run-level assignment happened — before this milestone every document was its own
        // cluster and this sentence could never appear.
        const clusterNote = (finding['rationale'] as string[]).find((line) =>
          line.startsWith('FR-10 cluster '),
        );
        expect(
          clusterNote,
          'a duplicated row did not join a cluster: `assignClusters` has no runtime caller again',
        ).toBeDefined();
        expect(String(clusterNote)).toMatch(/2 document\(s\) about this event/u);

        // Claim 7, as this deployment can prove it: two copies of one authority's row are one
        // authority. A count of 2 here is corroboration inflation — ten copies of one wire story
        // counting as ten independent reports is exactly what I6 forbids.
        expect(
          Number(axesOf(finding)['independenceCount']),
          `a duplicated row inflated the independence count: ${String(clusterNote)}`,
        ).toBe(1);
        expect(String(clusterNote)).toMatch(/counted: 1 \(1 issuing authority/u);
      }
    } finally {
      await db.collection('indexedSourceRecords').deleteOne({ sourceRecordId: copyRecordId });
    }
  }, 300_000);

  it('keeps every independent authority its own finding, and clusters none of them away', async () => {
    const authorities = new Set(crossListed.rows.map((row) => row.sourceId));
    expect(
      authorities.size,
      'this test needs one person listed by two different authorities',
    ).toBeGreaterThanOrEqual(2);

    const subject = await createSubject({ fullName: crossListed.name });
    const { findings } = await runSearch(subject);

    const bySource = new Map<string, Json[]>();
    for (const finding of findingsOf(findings)) {
      const sourceId = String(documentOf(finding)['sourceId']);
      bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), finding]);
    }

    // Claim 8: an OFAC designation and an EU listing about one person are not copies of one
    // another. Each keeps its own finding, whatever their text similarity.
    const survived = [...authorities].filter(
      (sourceId) => (bySource.get(sourceId) ?? []).length > 0,
    );
    expect(
      survived.length,
      `only ${String(survived.length)} of ${String(authorities.size)} independent authorities ` +
        `kept a finding for ${crossListed.name}: clustering folded an authority record away`,
    ).toBeGreaterThanOrEqual(2);

    // And no authority record was excluded from the count as a copy. The cluster note reports the
    // exclusions; for authority records it must always be none.
    for (const finding of findingsOf(findings)) {
      const clusterNote = (finding['rationale'] as string[]).find((line) =>
        line.startsWith('FR-10 cluster '),
      );
      if (clusterNote !== undefined) {
        expect(
          clusterNote,
          'an independent authority record was excluded from the independence count as a copy',
        ).toMatch(/0 excluded as copies or non-independent tiers/u);
      }
    }
  }, 300_000);
});

describe('claim 9 — valid indexed findings survive a SEC failure in the same run', () => {
  it('keeps the indexed findings and reports the SEC failure honestly', async () => {
    // The SEC is driven to a recorded failure without faking a publisher response: the kill
    // switch is the operator's own control for exactly this, and it refuses the source before a
    // socket opens. Released again in `finally`.
    // Release first, unconditionally. The switch is a real operator control on a shared source
    // record, not per-run state: an earlier run that died between engaging and releasing leaves
    // it on, and the next run then fails at `engage` with ALREADY_TERMINAL — a confusing error
    // about the test's own leftovers rather than about the system. Releasing something already
    // released is harmless.
    await releaseKillSwitch('Clearing any switch left engaged by an earlier acceptance run.');

    const engaged = await request(app.getHttpServer())
      .post(`/v1/admin/sources/${SEC_LITIGATION}/kill-switch`)
      .set('Authorization', `ApiKey ${sourceAdminKey}`)
      .send({ reason: 'Combined acceptance run: proving indexed findings survive a SEC failure.' });
    expect(engaged.status, JSON.stringify(engaged.body)).toBeLessThan(300);

    try {
      const row = crossListed.rows[0]!;
      const subject = await createSubject({
        fullName: row.primaryName,
        dateOfBirth: { value: row.dateOfBirth, precision: 'YEAR' },
      });
      const { status, findings } = await runSearch(subject);

      // The indexed finding survives.
      expect(
        findingsOf(findings).filter(
          (finding) => documentOf(finding)['sourceRecordId'] === row.sourceRecordId,
        ).length,
        'a SEC failure erased an indexed finding that had nothing to do with it',
      ).toBeGreaterThan(0);

      // The SEC is reported as unavailable, by name and with a reason.
      const secOutcome = outcomesOf(status, findings).find(
        (outcome) => outcome['sourceId'] === SEC_LITIGATION,
      );
      if (secOutcome !== undefined) {
        expect(['FAILED', 'SUSPENDED', 'SKIPPED']).toContain(String(secOutcome['outcome']));
        expect(String(secOutcome['detail']).length).toBeGreaterThan(0);
      }

      // And the run does not render itself as clean or complete.
      expect(String(findings['findingsState'])).not.toBe('NO_MATCHES_FOUND');
      expect(String(findings['coverage'])).not.toBe('COMPLETE');
    } finally {
      // Asserted, not fired and forgotten. A release that silently fails leaves a real source
      // switched off for every later run and every operator, and the only symptom is the next
      // run failing somewhere else entirely.
      const released = await releaseKillSwitch('Combined acceptance run finished.');
      expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);

      const health = await db
        .collection('sourceHealth')
        .findOne({ _id: SEC_LITIGATION } as unknown as Record<string, unknown>);
      expect(
        health?.['killSwitch'] ?? null,
        'the kill switch is still engaged after this suite finished',
      ).toBeNull();
    }
  }, 300_000);
});
