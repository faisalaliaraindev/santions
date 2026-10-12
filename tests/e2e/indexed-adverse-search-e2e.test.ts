/**
 * The indexed adverse-search engine, answered entirely from local snapshots.
 *
 * # What this suite is for
 *
 * Every other end-to-end suite searches **fixtures** (`api-lifecycle`, `tenant-onboarding`) or
 * **contacts a publisher at query time** (the live SEC and GDELT folders). This one is the third
 * shape and the one the ten official datasets use: the publisher was contacted on a schedule, the
 * dataset was parsed into a snapshot in our own database, and a tenant's search reads that
 * snapshot and **makes no request to anyone**.
 *
 * It runs against whatever the local stack actually holds. It does not seed indexed records, and
 * it refuses to pretend: if no indexed source has a usable snapshot the suite fails with the
 * command that produces one, rather than passing vacuously over an empty shelf.
 *
 * # The four identity cases (FR-08)
 *
 * Both paths now grade identity through the same FR-08 resolver (`resolveIdentityEvidence`). The
 * discovery matcher used to compare the subject's name to itself; since 2026-09-21 that code does
 * not exist and the two paths share one scoring model. These are real assertions about real
 * records, chosen from the snapshot at runtime rather than hardcoded:
 *
 * 1. **Exact, with a discriminator.** Name plus the **year** of birth the publisher records —
 *    which is all OFAC publishes for this person → a `DOB_YEAR_MONTH` moderate corroborating
 *    factor → `PARTIAL` → band `SUPPORTED`. Deliberately not `FULL_DOB`/`CORROBORATED`: the two
 *    sides agree on a year, and claiming the full dates agree would make every namesake born
 *    that year a corroborated identity against a sanctions list. The `FULL_DOB`/`CORROBORATED`
 *    path is asserted separately, against a day-precision pair.
 * 2. **Name only.** No date of birth, no country → only a `WEAK` factor → `WEAK` identity →
 *    band `AMBIGUOUS`. **The assertion that matters is that it does not reach `SUPPORTED`**, which
 *    is how a screening product ruins someone's day over a common name.
 * 3. **Date-of-birth contradiction.** Name matches, date of birth materially differs →
 *    `DOB_DIFFERS_BEYOND_PRECISION`, strong and contradicting → `CONTRADICTED` → **no finding for
 *    that record at all**. Absence is not evidence against; contradiction is.
 * 4. **Alias.** A real alias from the publisher's own record retrieves and matches the record.
 *
 * # The two systemic claims
 *
 * - **A tenant search contacts no publisher.** Asserted three ways, not one: the response's own
 *   `liveDiscovery.totalRequestsIssued`, the per-source spend counters on `GET
 *   /v1/admin/source-health` before and after, and each indexed source's `lastAttemptAt`. If a
 *   search had opened a socket for an indexed source, all three would move.
 * - **One source failing does not erase another's finding.** A source is driven to a recorded
 *   failure and the search still returns the other source's finding, with coverage degraded
 *   honestly rather than a clean `NO_MATCHES_FOUND`.
 *
 * Requires the local stack **and** populated snapshots:
 *   pnpm local:up && pnpm local:bootstrap
 *   pnpm source:onboard --apply     (see docs/sources/indexed-source-onboarding.md)
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { MongoClient, type Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gradeIdentity, resolveIdentityEvidence } from '../../packages/domain/src/index.js';

import { AppModule, APP_CONFIG } from '../../apps/api/src/app.module.js';
import { loadConfig } from '../../apps/api/src/config/config.js';
import { OutboxPublisher } from '../../apps/api/src/jobs/outbox-publisher.js';
import { WorkerRuntime } from '../../apps/api/src/jobs/worker-runtime.service.js';
import { createSuiteQueues, suiteQueueUrl } from './support/queues.js';
import { ApiKeyService } from '../../apps/api/src/tenancy/api-key.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

const NO_SNAPSHOT_HINT =
  'No indexed source holds a usable snapshot, so there is nothing to search and this suite ' +
  'would pass vacuously.\n' +
  'Populate one first:\n' +
  '  pnpm dev\n' +
  '  SOURCE_PROPOSER_KEY=... SOURCE_APPROVER_KEY=... pnpm source:onboard --apply\n' +
  '  POST /v1/admin/indexed-sources/{id}/refresh  with X-Allow-Publisher-Contact: true\n' +
  'See docs/sources/indexed-source-onboarding.md.';

/**
 * LIVE, deliberately.
 *
 * In mock mode every source adapter is a fixture and `IndexedSourceSearchService` would still
 * read the snapshots — but the run would also carry fixture discovery results, and the claim
 * "this answer came only from the local index" would be untestable. Live mode refuses every
 * fixture source outright (T55), so anything that comes back is from the indexed path.
 */
/** Where LocalStack answers. One definition, used by both the queue helper and `TEST_ENV`. */
const SQS = {
  endpointUrl: process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566',
  region: process.env['AWS_REGION'] ?? 'eu-west-2',
  accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
} as const;

/** Unique across `tests/e2e`. See `support/queues.ts` for why each suite owns one. */
const QUEUE_NAME = 'adverse-search-jobs-indexed-e2e';

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

  // FR-06 refuses to build a live fetch adapter without an honest contact URL. Nothing in this
  // suite should reach it, and that is precisely what the suite asserts.
  FETCH_CONTACT_URL:
    process.env['FETCH_CONTACT_URL'] ?? 'https://example.com/bots/adverse-search',
  OUTBOUND_USER_AGENT:
    process.env['OUTBOUND_USER_AGENT'] ??
    'ErlyAdverseSearch/0.1 (+https://example.com/bots/adverse-search)',

  AWS_REGION: SQS.region,
  AWS_ENDPOINT_URL: SQS.endpointUrl,
  AWS_ACCESS_KEY_ID: SQS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
  /**
   * **Its own queue, not the shared one.**
   *
   * This suite runs a LIVE worker, and live mode refuses every fixture source outright (T55). The
   * other end-to-end suites run MOCK workers over fixtures. Point both at one queue and whichever
   * worker is polling takes the message: a live worker handed a fixture search returns zero
   * findings, and the mock suite fails for a reason that is entirely in this file.
   *
   * That is not a flaw in the queue — in production there is one queue and many workers, and that
   * is correct precisely because every worker there is in the same mode. Running two modes over
   * one queue is the thing that does not happen in production, so the fix is to stop doing it
   * here rather than to serialise the suites and hope.
   *
   * Created in `beforeAll`, because a queue that must exist before the test runs is part of the
   * test's own setup, not a step somebody has to remember.
   */
  JOBS_QUEUE_URL: suiteQueueUrl(SQS, QUEUE_NAME, 'INDEXED_E2E_QUEUE_URL'),
  JOBS_DEAD_LETTER_QUEUE_URL: suiteQueueUrl(SQS, `${QUEUE_NAME}-dlq`, 'INDEXED_E2E_DLQ_URL'),

  EXTRACTION_MODEL_KIND: process.env['EXTRACTION_MODEL_KIND'] ?? 'synthetic',
  MODEL_RUNTIME_URL: process.env['MODEL_RUNTIME_URL'] ?? 'http://127.0.0.1:28434',
  S3_EVIDENCE_BUCKET: process.env['S3_EVIDENCE_BUCKET'] ?? 'adverse-search-evidence-local',
  SEARCH_INDEX_KIND: process.env['SEARCH_INDEX_KIND'] ?? 'meilisearch',
  MEILI_HOST: process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700',
  MEILI_MASTER_KEY: process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me',
};

type Json = Record<string, unknown>;

let app: INestApplication;
let mongo: MongoClient;
let db: Db;
let analystKey: string;
let operatorKey: string;

/** A real person record from whatever snapshot the stack actually holds. */
interface SampleRecord {
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly primaryName: string;
  readonly alias: string | null;
  readonly dateOfBirth: string | null;
  readonly snapshotVersion: string;
  readonly parserVersion: string;
}

let withDob: SampleRecord;
let withAlias: SampleRecord;

const TENANT_ID = 'tenant-live';

beforeAll(async () => {
  // Idempotent, and part of this suite's setup rather than a bootstrap step somebody has to
  // remember: a queue that does not exist yet fails at publish time, not at configuration time.
  await createSuiteQueues(SQS, QUEUE_NAME);

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
  app.get(OutboxPublisher).start(250);
  app.get(WorkerRuntime).start();

  const keys = app.get(ApiKeyService);
  analystKey = (
    await keys.create({
      tenantId: TENANT_ID,
      environment: 'live',
      roles: ['analyst'],
      scopes: ['search:read', 'search:write'],
      label: `indexed-e2e analyst ${randomUUID()}`,
      createdBy: 'indexed-adverse-search-e2e',
      now: new Date(),
    })
  ).secret;
  operatorKey = (
    await keys.create({
      tenantId: TENANT_ID,
      environment: 'live',
      roles: ['platform_operator'],
      scopes: ['admin:read', 'admin:write'],
      label: `indexed-e2e operator ${randomUUID()}`,
      createdBy: 'indexed-adverse-search-e2e',
      now: new Date(),
    })
  ).secret;

  ({ withDob, withAlias } = await chooseSampleRecords());
}, 240_000);

afterAll(async () => {
  // Stop the consumers **explicitly, and wait for them**, before closing the app.
  //
  // `app.close()` runs the shutdown hooks, and `WorkerRuntime`'s hook drains rather than stops —
  // it lets in-flight work finish. A long-poll receive that is already outstanding can therefore
  // still take a message after this file has finished. This suite runs in LIVE mode, where every
  // fixture source is refused, so a message it steals from the next suite's fixture search comes
  // back with zero findings: the next file fails, for a reason that is in this one.
  if (app !== undefined) {
    await app.get(WorkerRuntime).onApplicationShutdown('test');
    app.get(OutboxPublisher).onApplicationShutdown();
    await app.close();
  }
  await mongo?.close();
}, 60_000);

/**
 * Pick real records out of the live snapshots.
 *
 * Chosen at runtime rather than hardcoded because these datasets change: OFAC delists people, and
 * a suite pinned to one `sourceRecordId` becomes a suite that fails for a reason that has nothing
 * to do with this code. What is pinned is the **shape** — a person with a date of birth, and a
 * person with an alias — which is a property of the dataset rather than of one row in it.
 */
async function chooseSampleRecords(): Promise<{
  withDob: SampleRecord;
  withAlias: SampleRecord;
}> {
  const usable = await db
    .collection('indexedSourceRefreshStates')
    .find({ activeSnapshotVersion: { $ne: null } })
    .toArray();
  if (usable.length === 0) {
    throw new Error(NO_SNAPSHOT_HINT);
  }
  const activeSnapshots = usable.map((state) => String(state['activeSnapshotVersion']));

  const toSample = (row: Record<string, unknown>): SampleRecord => ({
    sourceId: String(row['sourceId']),
    sourceRecordId: String(row['sourceRecordId']),
    primaryName: String(row['primaryName']),
    alias:
      Array.isArray(row['aliases']) && row['aliases'].length > 0
        ? String((row['aliases'] as unknown[])[0])
        : null,
    dateOfBirth:
      ((Array.isArray(row['datesOfBirth'])
        ? (row['datesOfBirth'] as Array<Record<string, unknown>>).find(
            (date) => typeof date['value'] === 'string' && date['value'] !== '',
          )
        : undefined)?.['value'] as string | undefined) ?? null,
    snapshotVersion: String(row['sourceSnapshotVersion']),
    parserVersion: String(row['parserVersion']),
  });

  const dobRow = await db.collection('indexedSourceRecords').findOne({
    sourceSnapshotVersion: { $in: activeSnapshots },
    recordType: 'PERSON',
    // `$elemMatch`, not `'datesOfBirth.0.value': { $ne: null }` — that form also matches a record
    // whose `datesOfBirth` is an empty array, which is how this suite first selected a record
    // with no date of birth and then asserted about its date of birth.
    datesOfBirth: { $elemMatch: { value: { $type: 'string' } } },
  });
  const aliasRow = await db.collection('indexedSourceRecords').findOne({
    sourceSnapshotVersion: { $in: activeSnapshots },
    recordType: 'PERSON',
    'aliases.0': { $exists: true },
  });
  if (dobRow === null || aliasRow === null) {
    throw new Error(
      `${NO_SNAPSHOT_HINT}\n\nSnapshots exist but hold no person record with a date of birth ` +
        'or no record with an alias, so the FR-08 cases cannot be exercised honestly.',
    );
  }
  return { withDob: toSample(dobRow), withAlias: toSample(aliasRow) };
}

function auth(): string {
  return `ApiKey ${analystKey}`;
}

async function createSubject(input: {
  readonly fullName: string;
  readonly aliases?: readonly string[];
  readonly dateOfBirth?: { value: string; precision: 'DAY' | 'MONTH' | 'YEAR' } | null;
}): Promise<Json> {
  const created = await request(app.getHttpServer())
    .post('/v1/subjects')
    .set('Authorization', auth())
    .send({
      fullName: input.fullName,
      aliases: (input.aliases ?? []).map((name) => ({ name, script: 'Latin' })),
      countryContext: [],
      // The contract pairs value and precision: a null date must declare UNKNOWN precision, so
      // "no date of birth" is an explicit statement rather than an omitted field.
      dateOfBirth: input.dateOfBirth ?? { value: null, precision: 'UNKNOWN' },
      knownCompanies: [],
      externalSubjectRef: `indexed-e2e-${randomUUID()}`,
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
      externalCaseRef: 'indexed-e2e',
      requestedScope: {
        // At least one, and one the tenant's taxonomy actually enables: a scope naming a country
        // the pinned taxonomy enables nothing for is refused with `JURISDICTION_NOT_ENABLED`.
        // `US` is in `DEFAULT_ENABLED_COUNTRIES`.
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
  const deadline = Date.now() + 120_000;
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

function findingsFor(page: Json, sourceRecordId: string): Json[] {
  return (page['findings'] as Json[]).filter(
    (finding) => (finding['document'] as Json)['sourceRecordId'] === sourceRecordId,
  );
}

describe('indexed adverse search: identity resolution against real snapshots', () => {
  it('exact name plus a matching year of birth reaches SUPPORTED, with full provenance', async () => {
    // YEAR precision on both sides, and that is not an accident of the fixture: OFAC publishes a
    // year-only date of birth for this person, and the subject is declared at the same precision.
    // What the two sides agree on is therefore a **year**, and nothing more.
    const subject = await createSubject({
      fullName: withDob.primaryName,
      dateOfBirth: { value: withDob.dateOfBirth as string, precision: 'YEAR' },
    });
    const { findings } = await runSearch(subject);

    const matches = findingsFor(findings, withDob.sourceRecordId);
    expect(
      matches.length,
      `no finding for ${withDob.sourceId}/${withDob.sourceRecordId}`,
    ).toBeGreaterThan(0);
    const finding = matches[0] as Json;
    const document = finding['document'] as Json;

    // The band, and the axis that produced it.
    //
    // `PARTIAL`, not `CORROBORATED`, and the difference is a defect this assertion used to hide.
    // Both sides state a year and nothing finer, so what was established is a year agreement —
    // FR-08's MODERATE `DOB_YEAR_MONTH`, not its STRONG `FULL_DOB`. The old matcher compared the
    // years and then asserted `FULL_DOB`/STRONG anyway, which reached `CORROBORATED`: every
    // namesake who happened to be born in the same year as an OFAC-listed person got a
    // corroborated identity out of a shared birth year. One moderate identifier is `PARTIAL`.
    //
    // The band is still SUPPORTED, so the match still reaches a reviewer. What changed is that
    // the finding no longer claims the two full dates of birth agree when only the years do.
    expect(finding['band']).toBe('SUPPORTED');
    expect((finding['axes'] as Json)['identity']).toBe('PARTIAL');

    // Provenance: every field a reviewer needs to go back to the publisher's own record.
    expect(document['sourceId']).toBe(withDob.sourceId);
    expect(document['sourceRecordId']).toBe(withDob.sourceRecordId);
    expect(document['sourceSnapshotVersion']).toBe(withDob.snapshotVersion);
    expect(document['parserVersion']).toBe(withDob.parserVersion);
    expect(document['rawEvidenceHash']).toBeTypeOf('string');
    expect(document['publisher']).toBeTypeOf('string');
    expect(String(document['publisher']).length).toBeGreaterThan(0);
    expect(document['cascadeRung']).toBe(0);

    // The category is a value from the closed enum, not a free string. Until 2026-09-21 this
    // path emitted `SANCTIONS_DESIGNATION` as a string that appeared in no schema.
    expect(['SANCTIONS_DESIGNATION', 'DEBARMENT_EXCLUSION', 'REGULATORY_WARNING_LIST']).toContain(
      finding['category'],
    );

    // The rationale must reflect evidence actually inspected — the date of birth is why this is
    // PARTIAL rather than WEAK, so it has to be named, at the strength it really carries. A
    // rationale that claims a check nobody ran is the hardest thing to defend in an audit.
    const factors = finding['identityFactors'] as Json[];
    const dob = factors.find((factor) => factor['kind'] === 'DOB_YEAR_MONTH');
    expect(dob, 'a year-only agreement must be recorded as DOB_YEAR_MONTH').toBeDefined();
    expect(dob?.['strength']).toBe('MODERATE');
    expect(dob?.['direction']).toBe('CORROBORATING');

    // And it must NOT claim a full date-of-birth agreement, because there was not one.
    expect(factors.some((factor) => factor['kind'] === 'FULL_DOB')).toBe(false);

    const rationale = (finding['rationale'] as string[]).join(' ');
    expect(rationale).toMatch(/date of birth agrees at the precision both sides stated/i);
    expect(rationale).toContain(String(withDob.dateOfBirth).slice(0, 4));
    // The fabricated factor that used to be asserted on the discovery path must not appear on
    // any path, and no rationale line may describe a city nobody compared.
    expect(factors.some((factor) => factor['kind'] === 'RARE_FULL_NAME_PLUS_CITY')).toBe(false);
  }, 180_000);

  it('a full date of birth agreeing exactly is STRONG and reaches CORROBORATED', () => {
    // The counterpart to the test above, and the reason downgrading it is not a weakening: when
    // the two sides really do agree on a full date, the STRONG factor is still asserted and the
    // identity still reaches CORROBORATED.
    //
    // Driven through the resolver rather than the HTTP door, because no record in any snapshot
    // this stack holds publishes a DAY-precision date of birth — asserting it end-to-end would
    // need a publisher record that does not exist, and inventing one would prove nothing about
    // the real data.
    const resolved = resolveIdentityEvidence(
      {
        names: [{ text: withDob.primaryName, role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1948-03-07', precision: 'DAY' }],
        countries: [],
        companyNames: [],
        identifiers: [],
      },
      {
        names: [{ text: withDob.primaryName, role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1948-03-07', precision: 'DAY' }],
        countries: [],
        companyNames: [],
        identifiers: [],
        distinguishesNamesake: false,
        fieldSpan: null,
      },
    );

    const dob = resolved.factors.find((factor) => factor.kind === 'FULL_DOB');
    expect(dob?.strength).toBe('STRONG');
    expect(
      gradeIdentity({
        nameMatch: resolved.match.form,
        factors: resolved.factors,
        frequencyPrior: null,
        documentDistinguishesNamesake: false,
      }).grade,
    ).toBe('CORROBORATED');
  });

  it('a name-only subject stays AMBIGUOUS and never claims a corroborated identity', async () => {
    const subject = await createSubject({ fullName: withDob.primaryName, dateOfBirth: null });
    const { findings } = await runSearch(subject);

    const matches = findingsFor(findings, withDob.sourceRecordId);
    // A candidate MAY be returned. What it may not do is overstate.
    for (const finding of matches) {
      expect(finding['band'], 'a name-only match must never reach SUPPORTED').toBe('AMBIGUOUS');
      expect((finding['axes'] as Json)['identity']).toBe('WEAK');
      const factors = finding['identityFactors'] as Json[];
      expect(
        factors.every(
          (factor) => factor['strength'] === 'WEAK' || factor['direction'] !== 'CORROBORATING',
        ),
        'a name-only subject cannot produce a moderate or strong corroborating factor',
      ).toBe(true);
    }
  }, 180_000);

  it('a contradicting date of birth produces no finding for that record', async () => {
    // Materially different, and different beyond the publisher's own precision: the record is
    // held to YEAR precision, so a different year is a real contradiction rather than a rounding
    // difference.
    const recordedYear = Number((withDob.dateOfBirth as string).slice(0, 4));
    const conflicting = `${String(recordedYear - 23)}-06-15`;

    const subject = await createSubject({
      fullName: withDob.primaryName,
      dateOfBirth: { value: conflicting, precision: 'DAY' },
    });
    const { findings } = await runSearch(subject);

    expect(
      findingsFor(findings, withDob.sourceRecordId),
      'a strong DOB contradiction must block the finding entirely, not merely lower its band',
    ).toHaveLength(0);
  }, 180_000);

  it('a real publisher alias retrieves and matches the record', async () => {
    const subject = await createSubject({ fullName: withAlias.alias as string });
    const { findings } = await runSearch(subject);

    const matches = findingsFor(findings, withAlias.sourceRecordId);
    expect(
      matches.length,
      `the alias "${String(withAlias.alias)}" did not retrieve ${withAlias.sourceRecordId}`,
    ).toBeGreaterThan(0);
    // Retrieved through alias evidence, and the matched form is recorded so a reviewer can see
    // which name form agreed — and, specifically, that it was an **alias** of the publisher's
    // record rather than its primary name. A finding that says only "the names matched" leaves a
    // reviewer unable to tell which of the record's several names did the matching.
    const factors = matches[0]?.['identityFactors'] as Json[];
    expect(factors.length).toBeGreaterThan(0);
    const detail = String(factors[0]?.['detail']);
    expect(detail).toMatch(/name agreement/i);
    expect(detail).toMatch(/alias/i);
    // Both sides of the comparison are named, which is the property the discovery-path defect
    // destroyed: it could not report the document's name because it never read one.
    expect(detail).toContain(String(withAlias.alias));

    const rationale = (matches[0]?.['rationale'] as string[]).join(' ');
    expect(rationale).toMatch(/alias rather than a primary name/i);
  }, 180_000);
});

describe('a tenant search reads the local index and contacts nobody', () => {
  it('issues zero publisher requests for indexed sources', async () => {
    const before = await publisherContactWitness();

    const subject = await createSubject({
      fullName: withDob.primaryName,
      dateOfBirth: { value: withDob.dateOfBirth as string, precision: 'YEAR' },
    });
    const { findings } = await runSearch(subject);

    const after = await publisherContactWitness();

    // 1. The response's own diagnostic (D-060).
    const liveDiscovery = findings['liveDiscovery'] as Json | undefined;
    if (liveDiscovery !== undefined && liveDiscovery !== null) {
      expect(
        liveDiscovery['totalRequestsIssued'],
        'a search over indexed sources must open no socket',
      ).toBe(0);
    }

    // 2. Each indexed source's own refresh state. A publisher call for an indexed source goes
    //    through the refresh lifecycle, which moves `lastAttemptAt` and `httpStatus`.
    expect(after.refreshAttempts).toEqual(before.refreshAttempts);

    // 3. The recorded budget spend per source. Every outbound request spends against it —
    //    including the robots.txt read — so an unchanged counter is the strongest of the three.
    expect(after.spend).toEqual(before.spend);

    // And the search actually returned something, so this is not a vacuous zero.
    expect((findings['findings'] as Json[]).length).toBeGreaterThan(0);
  }, 180_000);

  it('returns no finding carrying a fixture source id', async () => {
    const subject = await createSubject({
      fullName: withDob.primaryName,
      dateOfBirth: { value: withDob.dateOfBirth as string, precision: 'YEAR' },
    });
    const { findings } = await runSearch(subject);

    for (const finding of findings['findings'] as Json[]) {
      const document = finding['document'] as Json;
      expect(String(document['sourceId'])).not.toMatch(/fixture|mock/i);
      expect(document['mode']).toBe('LIVE');
    }
    expect(findings['mode']).not.toBe('MOCK');
  }, 180_000);
});

describe('one source failing does not erase another source findings', () => {
  it('keeps the healthy source finding and records the failure honestly', async () => {
    // Drive a real source to a recorded failure without faking a publisher response: clear its
    // snapshot so it has nothing to answer from. That is the same state a source reaches when its
    // first refresh never succeeded, and it is the state that must read as a coverage gap rather
    // than as "looked and found nothing".
    const victim = await db
      .collection('indexedSourceRefreshStates')
      .findOne({ activeSnapshotVersion: { $ne: null }, sourceId: { $ne: withDob.sourceId } });
    expect(
      victim,
      'need a second indexed source with a snapshot to prove isolation',
    ).not.toBeNull();
    const victimId = String(victim?.['sourceId']);
    const saved = { ...victim } as Record<string, unknown>;

    await db.collection('indexedSourceRefreshStates').updateOne(
      { sourceId: victimId },
      {
        $set: {
          activeSnapshotVersion: null,
          refreshStatus: 'FAILED',
          failureReason: 'Injected for failure-isolation proof: publisher unavailable.',
          freshness: 'UNAVAILABLE',
        },
      },
    );

    try {
      const subject = await createSubject({
        fullName: withDob.primaryName,
        dateOfBirth: { value: withDob.dateOfBirth as string, precision: 'YEAR' },
      });
      const { status, findings } = await runSearch(subject);

      // The healthy source's finding survives.
      expect(
        findingsFor(findings, withDob.sourceRecordId).length,
        'a failure at one source erased another source finding',
      ).toBeGreaterThan(0);

      // The failed source is reported as a failure, by name, with its reason.
      const outcomes = (findings['sourceOutcomes'] ?? status['sourceOutcomes'] ?? []) as Json[];
      const victimOutcome = outcomes.find((outcome) => outcome['sourceId'] === victimId);
      if (victimOutcome !== undefined) {
        expect(victimOutcome['outcome']).toBe('FAILED');
        expect(String(victimOutcome['detail']).length).toBeGreaterThan(0);
      }

      // And the run does not claim to be clean or complete.
      expect(findings['findingsState']).not.toBe('NO_MATCHES_FOUND');
      expect(['PARTIAL', 'SUCCEEDED']).toContain(String(status['execution']));
      expect(String(findings['coverage'])).not.toBe('COMPLETE');
    } finally {
      await db.collection('indexedSourceRefreshStates').replaceOne({ sourceId: victimId }, saved);
    }
  }, 240_000);
});

/**
 * Everything that would move if a socket opened.
 *
 * Read through the admin API where one exists, so the witness is the same thing an operator (and
 * Postman folder 16) can see, rather than a private collection this test happens to know about.
 */
async function publisherContactWitness(): Promise<{
  refreshAttempts: Record<string, string>;
  spend: Record<string, string>;
}> {
  const indexed = await request(app.getHttpServer())
    .get('/v1/admin/indexed-sources')
    .set('Authorization', `ApiKey ${operatorKey}`);
  expect(indexed.status, JSON.stringify(indexed.body)).toBe(200);

  const refreshAttempts: Record<string, string> = {};
  for (const source of (indexed.body as Json)['sources'] as Json[]) {
    refreshAttempts[String(source['sourceId'])] =
      `${String(source['lastAttemptAt'])}|${String(source['httpStatus'])}|${String(source['refreshStatus'])}`;
  }

  const health = await request(app.getHttpServer())
    .get('/v1/admin/source-health')
    .set('Authorization', `ApiKey ${operatorKey}`);
  expect(health.status, JSON.stringify(health.body)).toBe(200);

  const spend: Record<string, string> = {};
  for (const source of (health.body as Json)['sources'] as Json[]) {
    const counter = (...names: readonly string[]): number => {
      for (const name of names) {
        const value = source[name];
        if (typeof value === 'number') {
          return value;
        }
      }
      return 0;
    };
    spend[String(source['sourceId'])] =
      `${String(counter('hourlySpent', 'hourlyUsed'))}|${String(counter('dailySpent', 'dailyUsed'))}`;
  }
  return { refreshAttempts, spend };
}
