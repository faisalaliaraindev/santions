/**
 * Phase E — a search that actually runs, end to end, against the real replica set.
 *
 * This is the test that did not exist for four phases. Everything before it proved a *part*
 * worked: the consumer dedupes, the graph freezes, the bands are right. Nothing proved that an
 * accepted search becomes a result, because until the job handler existed it could not.
 *
 * It drives `SearchJobHandler.execute` directly rather than through a queue, which is the same
 * arrangement `jobs.test.ts` uses: the handler performs no transport call, so the interesting
 * behaviour is assertable without one, and the consumer's own guarantees are tested separately.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 *
 * Seeds **its own tenant** — the C6 lesson. Borrowing a bootstrapped tenant is how a suite
 * starts failing for reasons that have nothing to do with what it tests.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Principal } from '../../packages/domain/src/index.js';

import { CapabilityCoverageService } from '../../apps/api/src/admin/capability-coverage.service.js';
import { TaxonomyService } from '../../apps/api/src/admin/taxonomy.service.js';
import { AssociationGraphService } from '../../apps/api/src/associations/association-graph.service.js';
import type { JobContext } from '../../apps/api/src/jobs/job-handler.js';
import { JOB_ENVELOPE_VERSION } from '../../apps/api/src/jobs/queue.port.js';
import {
  AuditService,
  LocalAuditCheckpointWriter,
} from '../../apps/api/src/persistence/audit.service.js';
import { OutboxService } from '../../apps/api/src/persistence/outbox.service.js';
import { RetentionService } from '../../apps/api/src/persistence/retention.service.js';
import { SourceDocumentService } from '../../apps/api/src/persistence/source-document.service.js';
import { StageExecutionService } from '../../apps/api/src/persistence/stage-execution.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';
import { FetchGateService } from '../../apps/api/src/sources/fetch-gate.service.js';
import { SourceHealthService } from '../../apps/api/src/sources/source-health.service.js';
import { SourceVersionService } from '../../apps/api/src/sources/source-version.service.js';
import { FindingsService } from '../../apps/api/src/pipeline/findings.service.js';
import { SearchJobHandler } from '../../apps/api/src/pipeline/search-job.handler.js';
import { CascadeService } from '../../apps/api/src/pipeline/cascade.service.js';
import { LadderBuilder } from '../../apps/api/src/pipeline/ladder.builder.js';
import { SearchPipeline } from '../../apps/api/src/pipeline/search-pipeline.service.js';
import { IndexerService } from '../../apps/api/src/search-index/indexer.service.js';
import { InMemorySearchIndex } from '../../apps/api/src/search-index/search-index.port.js';
import { SearchesService } from '../../apps/api/src/searches/searches.service.js';
import { SHARED_NAME } from '../../apps/api/src/sources/mock/registry-fixtures.js';
import { buildSourceAdapters } from '../../apps/api/src/sources/sources.registry.js';
import { EvidenceStagingService } from '../../apps/api/src/storage/evidence-staging.service.js';
import { InMemoryObjectStore } from '../../apps/api/src/storage/object-store.port.js';
import { NameFrequencyService } from '../../apps/api/src/subjects/name-frequency.service.js';
import { SubjectsService } from '../../apps/api/src/subjects/subjects.service.js';
import { EntitlementsService } from '../../apps/api/src/tenancy/entitlements.service.js';
import { PolicyService } from '../../apps/api/src/tenancy/policy.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let runner: TransactionRunner;
let searches: SearchesService;
let handler: SearchJobHandler;
let findings: FindingsService;
let sourceHealth: SourceHealthService;

const TENANT = `t-pipe-${randomUUID()}`;

const PRINCIPAL: Principal = {
  subject: 'reviewer-e1',
  kind: 'HUMAN',
  tenantId: TENANT,
  roles: [],
  scopes: [],
  environment: 'sandbox',
  breakGlass: null,
};

/** Everything a tenant needs before a search can be accepted, matching the bootstrap. */
async function seedTenant(): Promise<void> {
  const now = new Date().toISOString();
  await db
    .collection('tenants')
    .insertOne({ tenantId: TENANT, name: 'Pipeline suite', status: 'ACTIVE', createdAt: now });
  await db.collection('tenantEntitlementVersions').insertOne({
    tenantId: TENANT,
    version: 1,
    capabilities: ['adverse_media'],
    environments: ['sandbox'],
    status: 'ACTIVE',
    activatedAt: now,
  });
  await db.collection('taxonomyVersions').insertOne({
    tenantId: TENANT,
    version: 1,
    status: 'ACTIVE',
    categories: [
      // One category, enabled for CR. The extractor may only produce a category the tenant has
      // enabled, so this is what makes a finding possible at all.
      { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['CR'] },
    ],
    // Deliberately unmeasured, matching the seeded tenants and the real state of the world:
    // no language has a measured recall figure, so none is enabled (FR-03). The run must
    // still work and must say so.
    languages: [{ language: 'es', measuredRecall: null, measuredByEvaluationRunId: null }],
    lexicon: [],
    proposedBy: 'pipeline.test',
    approvedBy: 'pipeline.test',
    activatedAt: now,
  });
  await db.collection('policyVersions').insertOne({
    tenantId: TENANT,
    version: 1,
    status: 'ACTIVE',
    historicalScopeApproved: false,
    queryPlanCap: 200,
    evidenceRetentionDays: 30,
    activatedAt: now,
  });
}

/** A job context that behaves like the consumer's, without a queue. */
function contextFor(searchId: string): JobContext {
  return {
    tenantId: TENANT,
    runId: searchId,
    stageKey: `search:execute:${searchId}`,
    attempt: 1,
    heartbeat: async () => Promise.resolve(true),
    envelope: {
      envelopeVersion: JOB_ENVELOPE_VERSION,
      eventId: randomUUID(),
      eventType: 'search.queued',
      tenantId: TENANT,
      aggregateType: 'SearchRun',
      aggregateId: searchId,
      aggregateRevision: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      payload: {},
    },
  };
}

/** Create a search for the fixture subject and run it to completion. */
async function runSearchFor(fullName: string): Promise<string> {
  const created = await searches.create({
    principal: PRINCIPAL,
    data: {
      environment: 'sandbox',
      subjectSnapshot: {
        fullName,
        aliases: [],
        countryContext: ['CR'],
        // The client-supplied company is what lets the graph resolve the officer, which is what
        // lets F2/F6 anchor. Without it the officer stays a candidate for review (T14).
        knownCompanies: [{ registrationNumber: 'CR-3101-100001', jurisdiction: 'CR' }],
        dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
        purpose: 'CUSTOMER_ONBOARDING',
      },
      requestedScope: {
        jurisdictions: ['CR'],
        languages: ['es'],
        includeFormerDirectorships: false,
        fromDate: null,
      },
    },
    now: new Date(),
  });

  await handler.execute(contextFor(created.searchId));
  return created.searchId;
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
  db = mongo.db();

  runner = new TransactionRunner(mongo);
  const audit = new AuditService(db, new LocalAuditCheckpointWriter(db));
  const subjects = new SubjectsService(db, new NameFrequencyService(db));
  const taxonomies = new TaxonomyService(db);
  const policies = new PolicyService(db);
  const documents = new SourceDocumentService(db);
  findings = new FindingsService(db);
  sourceHealth = new SourceHealthService(db, audit, runner);

  const adapters = buildSourceAdapters({
    mode: 'MOCK',
    companiesHouseApiKey: null,
    fetchContactUrl: null,
  });
  const graph = new AssociationGraphService(
    db,
    subjects,
    adapters,
    new CapabilityCoverageService(db),
    runner,
    audit,
    policies,
    'mock',
  );

  searches = new SearchesService(
    db,
    new EntitlementsService(db),
    subjects,
    runner,
    audit,
    new OutboxService(db),
    new IndexerService(db, new InMemorySearchIndex(), documents),
    new StageExecutionService(db),
    graph,
    findings,
    taxonomies,
    sourceHealth,
    'mock',
  );

  const pipeline = new SearchPipeline(
    subjects,
    graph,
    taxonomies,
    policies,
    adapters,
    // An in-process object store: this suite is about the pipeline, not about S3, and
    // `evidence-storage.test.ts` already exercises the real one against LocalStack.
    new EvidenceStagingService(
      new InMemoryObjectStore(),
      documents,
      new RetentionService(db),
      'eu-west-2',
    ),
    findings,
    sourceHealth,
    // The Phase E step 2 fetch gate. It reads the shared `sourceVersions` collection the
    // bootstrap seeds, which is where the fixture sources' approvals live — so this suite
    // exercises the same derivation a live process would, against fixture approvals.
    new FetchGateService(new SourceVersionService(db), 'MOCK', {
      mode: 'MOCK',
      contactUrl: null,
    }),
    'mock',
    // The FR-05 ladder, built from the same seeded registry the fetch gate reads. So this suite
    // walks the rungs the fixtures are actually approved at — and reports the rungs nothing is
    // approved for as unsearched, which is what the bootstrap really leaves behind.
    new LadderBuilder(db, adapters),
    new CascadeService(sourceHealth),
  );

  handler = new SearchJobHandler(db, pipeline, findings, runner);

  await Promise.all([
    subjects.ensureIndexes(),
    searches.ensureIndexes(),
    graph.ensureIndexes(),
    findings.ensureIndexes(),
    audit.ensureIndexes(),
    documents.ensureIndexes(),
  ]);
  await seedTenant();
}, 60_000);

afterAll(async () => {
  // Unconditional, so one failed run cannot leave state that breaks an unrelated suite later.
  for (const collection of [
    'tenants',
    'tenantEntitlementVersions',
    'taxonomyVersions',
    'policyVersions',
    'subjectVersions',
    'searchRuns',
    'graphSnapshots',
    'associationAssertions',
    'companies',
    'unresolvedOfficerCandidates',
    'findings',
    'rejectedLeads',
    'sourceDocumentVersions',
    'auditEvents',
    'outboxEvents',
    'stageExecutions',
  ]) {
    await db.collection(collection).deleteMany({ tenantId: TENANT });
  }
  await db.collection<{ _id: string; value: number }>('auditSequences').deleteMany({ _id: TENANT });
  await mongo.close();
});

describe('an accepted search becomes a result', () => {
  it('runs end to end and completes the run', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const run = await searches.findById(TENANT, searchId);

    // The thing that was impossible for four phases: a run that is no longer QUEUED.
    expect(run.execution).not.toBe('QUEUED');
    expect(run.progress.stagesCompleted).toBe(6);
    expect(run.progress.cascadeRungReached).not.toBeNull();
  }, 60_000);

  it('produces findings, each carrying the reasoning behind its band', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const page = await searches.findingsFor({ tenantId: TENANT, searchId });

    expect(page.findings.length).toBeGreaterThan(0);
    for (const finding of page.findings) {
      // A band never arrives alone. FR-08 requires the four axis values verbatim beside it and
      // FR-13 requires the reviewer be able to see why.
      expect(finding.rationale.length).toBeGreaterThan(0);
      expect(finding.axes.identity).toBeTruthy();
      expect(finding.axes.attribution).toBeTruthy();
      // Spans point back into the document. A claim with no span cannot be checked.
      expect(finding.subjectMentionSpans.length).toBeGreaterThan(0);
      expect(finding.document.url).toMatch(/^https:/);
    }
  }, 60_000);

  it('never returns a numeric risk score (invariant I9)', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const page = await searches.findingsFor({ tenantId: TENANT, searchId });
    const serialised = JSON.stringify(page);

    for (const forbidden of ['riskScore', 'score', 'confidence', 'probability']) {
      expect(serialised).not.toContain(forbidden);
    }
  }, 60_000);

  it('stamps every record MOCK, because no live source was contacted (T55)', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const page = await searches.findingsFor({ tenantId: TENANT, searchId });

    expect(page.mode).toBe('MOCK');
    expect(page.findings.every((finding) => finding.document.mode === 'MOCK')).toBe(true);
  }, 60_000);

  it('says the language is unmeasured rather than implying coverage it has not measured', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const page = await searches.findingsFor({ tenantId: TENANT, searchId });
    const run = await searches.findById(TENANT, searchId);

    // FR-03: a language is enabled only with a measured recall figure, and none has one. The
    // run still executes — refusing would mean the service does nothing until Phase H — but
    // the omission is never silent.
    expect(page.unmeasuredLanguages).toContain('es');
    expect(run.progress.warnings.join(' ')).toMatch(/no measured recall/i);
  }, 60_000);

  it('records the leads it rejected, with a reason for each (FR-06)', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const page = await searches.findingsFor({ tenantId: TENANT, searchId });

    // The fixture corpus includes an article that never names the subject and one with no
    // snippet. Whatever does not survive must be visible with its reason, not discarded.
    expect(page.rejectedLeads.length).toBeGreaterThan(0);
    for (const lead of page.rejectedLeads) {
      expect(lead.reason.length).toBeGreaterThan(20);
      expect(['FETCH', 'EXTRACTION', 'CLASSIFICATION']).toContain(lead.stage);
    }
  }, 60_000);

  it('reports coverage alongside the findings, never findings alone', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const page = await searches.findingsFor({ tenantId: TENANT, searchId });

    expect(page.execution).toBeTruthy();
    expect(page.findingsState).toBeTruthy();
    expect(page.coverage).toBeTruthy();
    expect(page.sourceOutcomes.length).toBeGreaterThan(0);
  }, 60_000);

  it('is idempotent: re-running replaces the findings rather than doubling them', async () => {
    const searchId = await runSearchFor(SHARED_NAME);
    const first = await searches.findingsFor({ tenantId: TENANT, searchId });

    await handler.execute(contextFor(searchId));
    const second = await searches.findingsFor({ tenantId: TENANT, searchId });

    // A redelivery that got past the fence must not make a reviewer see the same article twice.
    expect(second.findings.length).toBe(first.findings.length);
  }, 60_000);
});

describe('a subject nobody has written about', () => {
  it('returns a qualified no-match statement, never "clear"', async () => {
    const searchId = await runSearchFor('Wilberth Zamora Quesada');
    const page = await searches.findingsFor({ tenantId: TENANT, searchId });

    expect(page.findings).toEqual([]);
    expect(page.noMatchStatement).not.toBeNull();

    const statement = JSON.stringify(page.noMatchStatement).toLowerCase();
    // FR-13: the words "clear", "clean" and "no adverse media" are never produced.
    expect(statement).not.toMatch(/\bclear\b/);
    expect(statement).not.toMatch(/\bclean\b/);
    expect(statement).not.toMatch(/no adverse media/);
    // It must instead say what was searched and what that does not mean.
    expect(statement).toMatch(/not established|unmeasured|did not find/);
  }, 60_000);
});
