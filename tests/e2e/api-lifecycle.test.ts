/**
 * The API end-to-end suite — a search from an HTTP request to an HTTP answer.
 *
 * # What makes this different from the integration suite
 *
 * `tests/integration/pipeline.test.ts` drives `SearchJobHandler.execute` directly, which is the
 * right shape for what it asserts. Nothing before this file went **in through the HTTP door and
 * out through it**, so nothing proved the pieces are joined: the guard chain, the controller, the
 * transaction, the outbox, the real queue, the worker consuming it, the pipeline, and the read
 * path back.
 *
 * So this suite does exactly that, and touches no service class in between:
 *
 * ```
 * POST /v1/subjects      →  201
 * POST /v1/searches      →  202 + searchId
 *      (the real outbox publishes to the real SQS queue in LocalStack)
 *      (a real WorkerRuntime consumes it and runs the real pipeline)
 * GET  /v1/searches/{id} →  poll until terminal
 * GET  /v1/searches/{id}/findings → findings AND coverage
 * ```
 *
 * The only thing constructed by hand is the API key, because there is no endpoint that issues
 * one — decision **D-007** defers self-service keys and `pnpm key:issue` is the operator path.
 *
 * # What this suite is NOT
 *
 * **It is not the browser end-to-end suite.** That one belongs to gate **G8** and mostly lives in
 * `adverse-search-frontend`; `pnpm test:e2e` stays unimplemented until then and
 * `verify:local` keeps reporting it as unverified. Letting an API-level suite satisfy that entry
 * would be a gate going green without being met, which is the exact failure `verify-local.mjs`
 * says it exists to prevent.
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG } from '../../apps/api/src/app.module.js';
import { loadConfig } from '../../apps/api/src/config/config.js';
import { OutboxPublisher } from '../../apps/api/src/jobs/outbox-publisher.js';
import { WorkerRuntime } from '../../apps/api/src/jobs/worker-runtime.service.js';
import { ApiKeyService, type IssuedApiKey } from '../../apps/api/src/tenancy/api-key.service.js';
import { createSuiteQueues, suiteQueueUrl } from './support/queues.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

/**
 * A tenant `local:bootstrap` seeds, with an active entitlement, taxonomy and policy.
 *
 * Borrowed rather than invented, deliberately — and it is the one place this suite does borrow.
 * A fresh tenant has no active taxonomy version, so every search would 422 for a reason that has
 * nothing to do with the path under test.
 */
const SEEDED_TENANT = 'tenant-alpha';

/** Where LocalStack answers. One definition, used by both the queue helper and `TEST_ENV`. */
const SQS = {
  endpointUrl: process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566',
  region: process.env['AWS_REGION'] ?? 'eu-west-2',
  accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
} as const;

/** Unique across `tests/e2e`. See `support/queues.ts` for why each suite owns one. */
const QUEUE_NAME = 'adverse-search-jobs-api-lifecycle-e2e';

/**
 * The name the seeded discovery fixtures respond to.
 *
 * Accents included, and that matters: the fixture match folds accents, so a name that arrives
 * mangled folds to something else and matches nothing. That is a real failure mode — a request
 * body sent as anything but UTF-8 produces an honest `NO_MATCHES_FOUND` that looks like a
 * matching bug — and asserting on findings here is what would catch it.
 */
const FIXTURE_SUBJECT = 'María Fernanda Solís Rojas';

/**
 * The environment the app under test is configured with.
 *
 * **The queue settings are the part that is easy to leave out, and leaving them out fails
 * silently.** The security suite omits them and is right to: it never needs a search to finish.
 * This suite does, and without a queue URL the outbox has nowhere to publish — so every search
 * sits at `QUEUED` with nothing in the logs saying why. That is the same symptom as a stopped
 * worker, which is what makes it worth a comment rather than a line.
 *
 * Read from the process environment where it is set, with the `.env.example` local values as the
 * fallback, so this follows a relocated stack instead of pinning ports that moved.
 */
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

  AWS_REGION: SQS.region,
  AWS_ENDPOINT_URL: SQS.endpointUrl,
  AWS_ACCESS_KEY_ID: SQS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',

  /**
   * **This suite's own queue, not the stack's.**
   *
   * A `pnpm dev` worker polls `adverse-search-jobs` from `.env` for as long as somebody leaves it
   * running, in whatever mode and whatever build it booted with. It took this suite's messages on
   * 2026-09-21 and the failure looked like a pipeline defect. `tests/e2e/support/queues.ts` has
   * the full account and the reasoning.
   */
  JOBS_QUEUE_URL: suiteQueueUrl(SQS, QUEUE_NAME, 'API_LIFECYCLE_E2E_QUEUE_URL'),
  JOBS_DEAD_LETTER_QUEUE_URL: suiteQueueUrl(
    SQS,
    `${QUEUE_NAME}-dlq`,
    'API_LIFECYCLE_E2E_DLQ_URL',
  ),

  // The evidence store and the index are real too — a search writes to both, and substituting
  // in-memory versions here would make this suite prove less than the integration suite does.
  S3_EVIDENCE_BUCKET: process.env['S3_EVIDENCE_BUCKET'] ?? 'adverse-search-evidence-local',
  /**
   * The fixture server, and it is NOT optional.
   *
   * In mock mode every source adapter is a fixture that reads from this host. Without it the
   * adapters are constructed, discovery runs, and every rung answers with nothing — so the run
   * settles with zero findings, which reads like a matching bug and is a missing address.
   * `tenant-onboarding-e2e.test.ts` has carried this value and a comment naming this file as
   * missing it since it was written; this closes that.
   */
  FIXTURE_SERVER_URL: process.env['FIXTURE_SERVER_URL'] ?? 'http://127.0.0.1:28090',
  SEARCH_INDEX_KIND: process.env['SEARCH_INDEX_KIND'] ?? 'meilisearch',
  MEILI_HOST: process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700',
  MEILI_MASTER_KEY: process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me',
};

let app: INestApplication;
let mongo: MongoClient;
let key: IssuedApiKey;

function auth(): string {
  return `ApiKey ${key.secret}`;
}

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

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(TEST_ENV))
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  // **Both halves of the real arrangement**, because either one alone leaves every search at
  // QUEUED and the symptom is identical:
  //
  // - `OutboxPublisher` turns a committed `search.queued` row into an SQS message. `main.ts`
  //   starts it; the worker deliberately does not, because two publishers over the same rows is
  //   contention for no benefit.
  // - `WorkerRuntime` consumes that message and runs the pipeline. `worker-main.ts` starts it.
  //
  // The first version of this suite started only the worker, and every search sat at QUEUED
  // with nothing in the logs to say why — which is exactly what an operator sees when one of the
  // two processes is missing in a real deployment.
  app.get(OutboxPublisher).start(250);
  app.get(WorkerRuntime).start();

  const apiKeys = new ApiKeyService(mongo.db());
  await apiKeys.ensureIndexes();
  key = await apiKeys.create({
    tenantId: SEEDED_TENANT,
    environment: 'sandbox',
    label: `e2e ${randomUUID()}`,
    roles: ['analyst'],
    // Scopes narrow a machine key below its roles and never widen it. An empty list is refused
    // on every scope-gated route — `POST /v1/searches` needs `search:write`.
    scopes: ['search:read', 'search:write'],
    createdBy: 'tests/e2e',
  });
}, 120_000);

afterAll(async () => {
  // `app.close()` triggers `onApplicationShutdown`, which is how the runtime drains — the same
  // path SIGTERM takes in production. Stopping it by hand first would exercise a path nothing
  // else uses.
  //
  // The generous timeout is not padding. The consumer long-polls SQS with `WaitTimeSeconds: 20`
  // — a deliberate cost decision, because short polling bills an API call per empty poll and on
  // an idle queue that is the entire bill — so a drain can take that long before it returns.
  // Vitest's 10s default cut it off and failed the file while every test in it passed.
  await app?.close();
  await mongo?.close();
}, 60_000);

/** Poll the real status endpoint until the run settles, or fail with what it was still doing. */
async function waitForTerminal(searchId: string): Promise<Record<string, unknown>> {
  const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
  const deadline = Date.now() + 90_000;
  let last: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    const response = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}`)
      .set('Authorization', auth());
    expect(response.status).toBe(200);
    last = response.body as Record<string, unknown>;
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

describe('a search, from an HTTP request to an HTTP answer', () => {
  it('accepts, runs and returns findings with their coverage', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', auth())
      .send({
        fullName: FIXTURE_SUBJECT,
        aliases: [],
        countryContext: ['CR'],
        dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
        knownCompanies: [{ registrationNumber: 'CR-3101-100001', jurisdiction: 'CR' }],
        externalSubjectRef: `e2e-${randomUUID()}`,
        purpose: 'CUSTOMER_ONBOARDING',
      });
    expect(created.status).toBe(201);

    const subjectId = String((created.body as Record<string, unknown>)['subjectId']);
    const version = Number((created.body as Record<string, unknown>)['version']);

    const accepted = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', auth())
      .set('Idempotency-Key', randomUUID())
      .send({
        subjectRef: { subjectId, version },
        externalCaseRef: 'e2e-case',
        requestedScope: {
          jurisdictions: ['CR'],
          languages: ['es', 'en'],
          includeFormerDirectorships: false,
          fromDate: null,
        },
        environment: 'sandbox',
      });

    // 202, not 200. A submitted search is a receipt, not an answer.
    expect(accepted.status).toBe(202);
    const searchId = String((accepted.body as Record<string, unknown>)['searchId']);
    expect((accepted.body as Record<string, unknown>)['execution']).toBe('QUEUED');

    const settled = await waitForTerminal(searchId);

    const page = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}/findings`)
      .set('Authorization', auth());
    expect(page.status).toBe(200);
    const body = page.body as Record<string, unknown>;
    expectPipelineRan(settled, body);

    // The fixtures respond to this subject, so this run finds things. That the count is
    // non-zero is what proves the discovery, fetch, extraction and banding stages all ran —
    // an empty result here would pass a weaker assertion while proving nothing.
    const findings = body['findings'] as unknown[];
    expect(findings.length).toBeGreaterThan(0);

    // Fixture data must be unmistakable in a record (T55).
    expect(body['mode']).toBe('MOCK');
  }, 180_000);

  it('returns findings and coverage together, never findings alone', async () => {
    // There is deliberately no endpoint that serves findings without their coverage. This
    // asserts the shape rather than the values: a reviewer reading a narrow result has to be
    // able to see that it was narrow.
    const searchId = await runSearch();
    const page = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}/findings`)
      .set('Authorization', auth());

    const body = page.body as Record<string, unknown>;
    for (const field of [
      'execution',
      'findingsState',
      'coverage',
      'noMatchStatement',
      'findings',
      'rejectedLeads',
      'sourceOutcomes',
      'unmeasuredLanguages',
      'mode',
    ]) {
      expect(body, `findings page is missing ${field}`).toHaveProperty(field);
    }
  }, 180_000);

  it('reports every language as unmeasured, because none has a measured recall figure', async () => {
    // FR-03. This will keep being true until G10 measures recall, and the day it stops being
    // true it must be because a measurement exists — not because somebody removed the warning.
    const searchId = await runSearch();
    const page = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}/findings`)
      .set('Authorization', auth());

    const unmeasured = (page.body as Record<string, unknown>)['unmeasuredLanguages'] as string[];
    expect(unmeasured).toContain('es');
  }, 180_000);

  it('never renders an incomplete run as a clean result', async () => {
    const searchId = await runSearch();
    const page = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}/findings`)
      .set('Authorization', auth());
    const body = page.body as Record<string, unknown>;

    // The statement that accompanies an empty or narrow result must never read as an all-clear.
    const statement = JSON.stringify(body['noMatchStatement'] ?? {}).toLowerCase();
    for (const forbidden of ['no adverse media', 'clear of', 'clean']) {
      expect(statement, `noMatchStatement must not say "${forbidden}"`).not.toContain(forbidden);
    }
  }, 180_000);
});

describe('the receipt is idempotent', () => {
  it('returns the same search for a repeated Idempotency-Key, not a second one', async () => {
    const subject = await createSubject();
    const idempotencyKey = randomUUID();

    const first = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', auth())
      .set('Idempotency-Key', idempotencyKey)
      .send(searchBody(subject));
    expect(first.status).toBe(202);

    const second = await request(app.getHttpServer())
      .post('/v1/searches')
      .set('Authorization', auth())
      .set('Idempotency-Key', idempotencyKey)
      .send(searchBody(subject));

    // 200, not 202: this is a replay of an accepted request, not a new acceptance.
    expect(second.status).toBe(200);
    expect((second.body as Record<string, unknown>)['searchId']).toBe(
      (first.body as Record<string, unknown>)['searchId'],
    );
  }, 180_000);
});

describe('the door is shut to everyone else', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await request(app.getHttpServer()).get('/v1/searches');
    expect(response.status).toBe(401);
  });

  it('refuses a subject with no recorded purpose', async () => {
    // The service will not hold a person's name without a reason for screening them.
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', auth())
      .send({ fullName: 'Someone Without A Purpose' });
    expect([400, 422]).toContain(response.status);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    // Strict schemas. A client typo fails loudly instead of silently narrowing a search.
    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', auth())
      .send({
        fullName: 'Typo Tester',
        purpose: 'CUSTOMER_ONBOARDING',
        contryContext: ['CR'],
      });
    expect([400, 422]).toContain(response.status);
  });

  it('answers a reserved endpoint with 501 and a reason, not 404', async () => {
    // D-007. A documented endpoint that 404s looks like something to work around; one that
    // 501s with a reason is a gap an integrator can see.
    const response = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', auth());
    expect([403, 501]).toContain(response.status);
  });

  it('refuses a search belonging to another tenant', async () => {
    const otherKey = await new ApiKeyService(mongo.db()).create({
      tenantId: 'tenant-beta',
      environment: 'sandbox',
      label: `e2e cross-tenant ${randomUUID()}`,
      roles: ['analyst'],
      scopes: ['search:read', 'search:write'],
      createdBy: 'tests/e2e',
    });

    const searchId = await runSearch();
    const response = await request(app.getHttpServer())
      .get(`/v1/searches/${searchId}`)
      .set('Authorization', `ApiKey ${otherKey.secret}`);

    // 404, not 403: a tenant learns nothing about what exists outside its own scope.
    expect([403, 404]).toContain(response.status);
  }, 180_000);
});

/** Create a subject the fixtures respond to. */
async function createSubject(): Promise<{ subjectId: string; version: number }> {
  const created = await request(app.getHttpServer())
    .post('/v1/subjects')
    .set('Authorization', auth())
    .send({
      fullName: FIXTURE_SUBJECT,
      aliases: [],
      countryContext: ['CR'],
      knownCompanies: [],
      externalSubjectRef: `e2e-${randomUUID()}`,
      purpose: 'CUSTOMER_ONBOARDING',
    });
  expect(created.status).toBe(201);
  const body = created.body as Record<string, unknown>;
  return { subjectId: String(body['subjectId']), version: Number(body['version']) };
}

function searchBody(subject: { subjectId: string; version: number }): Record<string, unknown> {
  return {
    subjectRef: { subjectId: subject.subjectId, version: subject.version },
    requestedScope: {
      jurisdictions: ['CR'],
      languages: ['es', 'en'],
      includeFormerDirectorships: false,
      fromDate: null,
    },
    environment: 'sandbox',
  };
}

/** A whole search, run to completion. Returns its id. */
async function runSearch(): Promise<string> {
  const subject = await createSubject();
  const accepted = await request(app.getHttpServer())
    .post('/v1/searches')
    .set('Authorization', auth())
    .set('Idempotency-Key', randomUUID())
    .send(searchBody(subject));
  expect(accepted.status).toBe(202);

  const searchId = String((accepted.body as Record<string, unknown>)['searchId']);
  await waitForTerminal(searchId);
  return searchId;
}

/**
 * The fixture pipeline ran, and any degradation is a source with nothing on its shelf.
 *
 * This used to be `expect(execution).toBe('SUCCEEDED')`, and that assertion silently encoded an
 * assumption about the *environment* rather than about the API: that the only sources in the
 * registry are the fixtures this suite seeds. Once the ten real indexed sources were onboarded,
 * a deployment legitimately carried one — `world-bank-debarred` — that is APPROVED, holds no
 * snapshot because its gateway needs a credential this deployment does not have, and is
 * therefore reported as a **coverage gap at rung 0**. The run became `PARTIAL`, correctly, and
 * an assertion about fixtures started failing for a reason that has nothing to do with fixtures.
 *
 * So the check is now the precise one. `FAILED` is still refused — it is terminal too and would
 * pass a weaker assertion. `PARTIAL` is accepted **only** when every degraded source is an
 * indexed source with no snapshot, which is exactly the honest coverage gap. A fixture that
 * broke, or a source that failed for any other reason, still fails this test.
 */
function expectPipelineRan(settled: Record<string, unknown>, page?: Record<string, unknown>): void {
  const execution = String(settled['execution']);
  expect(['SUCCEEDED', 'PARTIAL'], JSON.stringify(settled)).toContain(execution);
  if (execution === 'SUCCEEDED') {
    return;
  }
  const outcomes = ((page?.['sourceOutcomes'] ?? settled['sourceOutcomes'] ?? []) as Array<
    Record<string, unknown>
  >).filter((outcome) => outcome['outcome'] === 'FAILED' || outcome['outcome'] === 'PARTIAL');
  expect(outcomes.length, 'PARTIAL with no degraded source named').toBeGreaterThan(0);
  for (const outcome of outcomes) {
    expect(
      outcome['cascadeRung'],
      `only an indexed source with no snapshot may degrade this run; ${String(outcome['sourceId'])} did: ${String(outcome['detail'])}`,
    ).toBe(0);
  }
}
