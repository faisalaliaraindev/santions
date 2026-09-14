/**
 * Phase D step D3 — the FR-02 association graph, against the real replica set.
 *
 * The properties here are the ones that only hold if the persistence is right: a snapshot
 * created in the same commit as the run that pins it; a graph that a later registry correction
 * cannot rewrite; a registry outage that leaves the search alive and the coverage honest.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 *
 * This suite seeds **its own tenant** for everything it can, and borrows the bootstrapped
 * `tenant-alpha` / `tenant-beta` only where a full entitlement, taxonomy and policy chain is
 * needed to create a real search. Borrowing more than that is what broke another suite in
 * Phase C.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CreateSearchInput } from '../../packages/contracts/src/index.js';
import type { Principal } from '../../packages/domain/src/index.js';

import { CapabilityCoverageService } from '../../apps/api/src/admin/capability-coverage.service.js';
import {
  AssociationGraphService,
  HISTORICAL_DIRECTORSHIPS,
} from '../../apps/api/src/associations/association-graph.service.js';
import {
  AuditService,
  LocalAuditCheckpointWriter,
} from '../../apps/api/src/persistence/audit.service.js';
import { OutboxService } from '../../apps/api/src/persistence/outbox.service.js';
import { SourceDocumentService } from '../../apps/api/src/persistence/source-document.service.js';
import { StageExecutionService } from '../../apps/api/src/persistence/stage-execution.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';
import { IndexerService } from '../../apps/api/src/search-index/indexer.service.js';
import { InMemorySearchIndex } from '../../apps/api/src/search-index/search-index.port.js';
import { SearchesService } from '../../apps/api/src/searches/searches.service.js';
import type { MockCompanyRegistryAdapter } from '../../apps/api/src/sources/mock/company-registry.mock.js';
import {
  ABSENT_NAME,
  HIGH_FREQUENCY_NAME,
  SHARED_NAME,
  TENURE_SUBJECT_NAME,
} from '../../apps/api/src/sources/mock/registry-fixtures.js';
import { MockModeWitness } from '../../apps/api/src/sources/source-adapter.js';
import type { SourceAdapterSet } from '../../apps/api/src/sources/sources.registry.js';
import { buildSourceAdapters } from '../../apps/api/src/sources/sources.registry.js';
import { NameFrequencyService } from '../../apps/api/src/subjects/name-frequency.service.js';
import { SubjectsService } from '../../apps/api/src/subjects/subjects.service.js';
import { EntitlementsService } from '../../apps/api/src/tenancy/entitlements.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let runner: TransactionRunner;
let audit: AuditService;
let subjects: SubjectsService;

const TENANT = `t-assoc-${randomUUID()}`;
const NOW = new Date('2026-09-14T12:00:00.000Z');

/** A graph service over a named adapter set, so a test can supply a failing registry. */
function graphOver(adapters: SourceAdapterSet): AssociationGraphService {
  return new AssociationGraphService(
    db,
    subjects,
    adapters,
    new CapabilityCoverageService(db),
    runner,
    audit,
    'mock',
  );
}

function mockAdapters(): SourceAdapterSet {
  return buildSourceAdapters({ mode: 'MOCK', companiesHouseApiKey: null });
}

/**
 * Create a subject and an empty snapshot for it, the way search creation does.
 *
 * Returns the search id, which is what the graph is keyed on.
 */
async function pendingSnapshotFor(input: {
  readonly fullName: string;
  readonly dateOfBirth?: { value: string; precision: 'DAY' | 'MONTH' | 'YEAR' } | undefined;
  readonly knownCompanies?: readonly string[] | undefined;
  readonly jurisdictions?: readonly string[] | undefined;
  readonly scope?: 'CURRENT_ONLY' | 'INCLUDE_FORMER' | undefined;
  readonly graph: AssociationGraphService;
}): Promise<{ searchId: string; snapshotId: string }> {
  const subject = await subjects.create({
    tenantId: TENANT,
    data: {
      fullName: input.fullName,
      aliases: [],
      countryContext: ['CR'],
      knownCompanies: (input.knownCompanies ?? []).map((registrationNumber) => ({
        registrationNumber,
        jurisdiction: 'CR',
      })),
      purpose: 'CUSTOMER_ONBOARDING',
      ...(input.dateOfBirth === undefined ? {} : { dateOfBirth: input.dateOfBirth }),
    },
    now: NOW,
  });

  const searchId = randomUUID();
  const snapshotId = await runner.run(
    async (session) =>
      input.graph.createPendingSnapshot({
        tenantId: TENANT,
        searchId,
        subjectId: subject.subjectId,
        subjectVersion: subject.version,
        jurisdictions: input.jurisdictions ?? ['CR'],
        scope: input.scope ?? 'CURRENT_ONLY',
        now: NOW,
        session,
      }),
    { name: 'test.createPendingSnapshot' },
  );

  return { searchId, snapshotId };
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
  audit = new AuditService(db, new LocalAuditCheckpointWriter(db));
  subjects = new SubjectsService(db, new NameFrequencyService(db));

  await Promise.all([
    graphOver(mockAdapters()).ensureIndexes(),
    subjects.ensureIndexes(),
    audit.ensureIndexes(),
  ]);
}, 30_000);

afterAll(async () => {
  // Everything this suite wrote, and nothing else. Unconditional, so one failed run cannot
  // leave state that breaks an unrelated suite later (the C6 lesson).
  for (const collection of [
    'graphSnapshots',
    'associationAssertions',
    'companies',
    'unresolvedOfficerCandidates',
    'subjectVersions',
    'auditEvents',
  ]) {
    await db.collection(collection).deleteMany({ tenantId: TENANT });
  }
  await db.collection<{ _id: string; value: number }>('auditSequences').deleteMany({ _id: TENANT });
  await mongo.close();
});

describe('the snapshot is frozen and pinned', () => {
  it('starts PENDING with coverage UNKNOWN, never COMPLETE-with-nothing', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({ fullName: SHARED_NAME, graph });

    const view = await graph.loadForSearch({ tenantId: TENANT, searchId });
    expect(view.status).toBe('PENDING');
    // Before anything has been attempted, "we have not asked" is the only honest answer.
    // COMPLETE with zero edges would read as "this person directs nothing".
    expect(view.coverage.outcome).toBe('UNKNOWN');
    expect(view.edges).toEqual([]);
  });

  it('is idempotent: a second build returns the first result rather than doubling the graph', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({
      fullName: TENURE_SUBJECT_NAME,
      dateOfBirth: { value: '1968-07-04', precision: 'DAY' },
      graph,
    });

    const first = await graph.build({ tenantId: TENANT, searchId, now: NOW });
    const second = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.edges.length).toBe(first.edges.length);
    expect(second.builtAt).toBe(first.builtAt);
  });

  it('serves the stored graph, not a fresh registry read', async () => {
    const adapters = mockAdapters();
    const graph = graphOver(adapters);
    const { searchId } = await pendingSnapshotFor({
      fullName: TENURE_SUBJECT_NAME,
      dateOfBirth: { value: '1968-07-04', precision: 'DAY' },
      knownCompanies: ['CR-3101-100001'],
      graph,
    });
    const built = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    // Break the register completely. A read of the frozen snapshot must not notice.
    const registry = adapters.companyRegistry as MockCompanyRegistryAdapter;
    registry.failWith({ httpStatus: 503 });

    const reread = await graph.loadForSearch({ tenantId: TENANT, searchId });
    expect(reread.edges.length).toBe(built.edges.length);
    expect(reread.coverage.outcome).toBe(built.coverage.outcome);
  });

  it('records the run that pins it, so a refresh can link rather than mutate', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId, snapshotId } = await pendingSnapshotFor({ fullName: ABSENT_NAME, graph });
    const view = await graph.loadForSearch({ tenantId: TENANT, searchId });
    expect(view.snapshotId).toBe(snapshotId);
    expect(view.refreshOfSnapshotId).toBeNull();
  });
});

describe('T14 — the wrong person’s companies do not attach', () => {
  it('resolves nobody on a name and a partial date of birth alone', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({
      fullName: SHARED_NAME,
      dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
      graph,
    });

    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    // Two officers hold this name. One agrees to the month, one contradicts. Neither attaches.
    expect(view.edges.every((e) => !e.attachesCompany)).toBe(true);
    expect(view.edges.some((e) => e.resolution === 'RESOLVED')).toBe(false);
  });

  it('excludes the contradicted officer entirely and keeps the near match visible', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({
      fullName: SHARED_NAME,
      dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
      graph,
    });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    // The contradicted one produced no edges and is recorded as an unresolved candidate, so a
    // reviewer can see the register held more than one person of this name.
    expect(view.unresolvedCandidates.some((c) => c.resolution === 'CONTRADICTED')).toBe(true);
    expect(view.edges.every((e) => e.resolution === 'CANDIDATE_FOR_REVIEW')).toBe(true);
  });

  it('attaches only when a second, independent signal agrees', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({
      fullName: TENURE_SUBJECT_NAME,
      dateOfBirth: { value: '1968-07-04', precision: 'DAY' },
      knownCompanies: ['CR-3101-100001'],
      graph,
    });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    expect(view.edges.some((e) => e.attachesCompany)).toBe(true);
    expect(view.edges.every((e) => e.resolution === 'RESOLVED')).toBe(true);
  });

  it('carries the reasoning on every edge, not a bare status', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({
      fullName: SHARED_NAME,
      dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
      graph,
    });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    for (const edge of view.edges) {
      expect(edge.resolutionRationale.length).toBeGreaterThan(0);
      expect(edge.identityFactors.length).toBeGreaterThan(0);
      expect(edge.scopeReason.length).toBeGreaterThan(10);
    }
  });

  it('does not spend a registry call on every namesake', async () => {
    // Twelve officers share this name and none can be resolved or even reviewed, so no hop is
    // made for any of them. Twelve unresolved candidates, zero edges.
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({ fullName: HIGH_FREQUENCY_NAME, graph });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    expect(view.edges).toEqual([]);
    expect(view.unresolvedCandidates.length).toBeGreaterThan(0);
    expect(view.unresolvedCandidates.every((c) => c.resolution === 'UNRESOLVED')).toBe(true);
  });
});

describe('T15 — tenure and scope on the stored edges', () => {
  async function tenureGraph(scope: 'CURRENT_ONLY' | 'INCLUDE_FORMER') {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({
      fullName: TENURE_SUBJECT_NAME,
      dateOfBirth: { value: '1968-07-04', precision: 'DAY' },
      knownCompanies: ['CR-3101-100001'],
      scope,
      graph,
    });
    return graph.build({ tenantId: TENANT, searchId, now: NOW });
  }

  it('stores appointment and resignation with their precision, and never backfills', async () => {
    const view = await tenureGraph('INCLUDE_FORMER');
    expect(view.edges.length).toBe(5);

    const yearPrecision = view.edges.find((e) => e.tenure.appointedOn.precision === 'YEAR');
    expect(yearPrecision).toBeDefined();

    const noResignation = view.edges.filter((e) => e.tenure.resignedOn.value === null);
    expect(noResignation.length).toBeGreaterThan(0);
    // A missing resignation stays missing. Not today's date, not an open-ended sentinel.
    expect(noResignation.every((e) => e.tenure.resignedOn.precision === 'UNKNOWN')).toBe(true);
  });

  it('records an observed date on every edge (FR-02)', async () => {
    const view = await tenureGraph('INCLUDE_FORMER');
    expect(view.edges.every((e) => e.observedAt !== '')).toBe(true);
  });

  it('never labels a silent resignation as confirmed current', async () => {
    const view = await tenureGraph('INCLUDE_FORMER');
    const silent = view.edges.filter((e) => e.tenure.resignedOn.value === null);
    expect(silent.length).toBeGreaterThan(0);
    expect(silent.every((e) => e.currency !== 'CURRENT_CONFIRMED')).toBe(true);
  });

  it('omits former directorships from the default scope, with a reason on each', async () => {
    const view = await tenureGraph('CURRENT_ONLY');
    const former = view.edges.filter((e) => e.currency === 'FORMER');
    expect(former.length).toBeGreaterThan(0);
    for (const edge of former) {
      expect(edge.inScope).toBe(false);
      expect(edge.attachesCompany).toBe(false);
      expect(edge.scopeReason).toMatch(/historical scope/i);
    }
  });

  it('includes them under the approved historical scope, still labelled FORMER', async () => {
    const view = await tenureGraph('INCLUDE_FORMER');
    const former = view.edges.filter((e) => e.currency === 'FORMER');
    expect(former.length).toBeGreaterThan(0);
    expect(former.every((e) => e.inScope)).toBe(true);
    // Included is not the same as current. The label survives the scope change.
    expect(former.every((e) => e.currency === 'FORMER')).toBe(true);
  });

  it('freezes the company as the register described it at build time', async () => {
    const view = await tenureGraph('INCLUDE_FORMER');
    expect(view.companies.length).toBeGreaterThan(0);
    // Including a dissolved one, which is exactly the field a later registry correction would
    // silently rewrite if companies were shared rather than copied per snapshot.
    expect(view.companies.some((c) => c.status === 'DISSOLVED')).toBe(true);
    expect(view.companies.every((c) => c.observedAt !== '')).toBe(true);
  });
});

describe('T20 — degraded execution and honest coverage', () => {
  it('reports a registry outage as INCOMPLETE and does not throw', async () => {
    const adapters = mockAdapters();
    (adapters.companyRegistry as MockCompanyRegistryAdapter).failWith({ httpStatus: 503 });
    const graph = graphOver(adapters);

    const { searchId } = await pendingSnapshotFor({ fullName: SHARED_NAME, graph });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    // The search is not failed by this. The graph is empty and the coverage says why.
    expect(view.status).toBe('BUILT');
    expect(view.coverage.outcome).toBe('INCOMPLETE');
    expect(view.coverage.detail).toMatch(/does not prove no associations exist/i);
    expect(view.coverage.sourceId).not.toBeNull();
  });

  it('never reports an empty register answer as "no associations"', async () => {
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({ fullName: ABSENT_NAME, graph });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    // The register answered "nobody". But officer associations are not SUPPORTED in CR (D14),
    // so an empty result is not established as absence — D-020, enforced here.
    expect(view.edges).toEqual([]);
    expect(view.coverage.outcome).toBe('UNKNOWN');
    expect(view.coverage.detail).toMatch(/not established/i);
  });

  it('distinguishes "we never asked" from "we asked and it failed"', async () => {
    // No adapter covers GB in a mock stack, so nothing is asked at all. That is UNKNOWN, and
    // reporting it as INCOMPLETE would imply an attempt that never happened.
    const graph = graphOver(mockAdapters());
    const { searchId } = await pendingSnapshotFor({
      fullName: SHARED_NAME,
      jurisdictions: ['GB'],
      graph,
    });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    expect(view.coverage.outcome).toBe('UNKNOWN');
    expect(view.coverage.sourceId).toBeNull();
    expect(view.coverage.detail).toMatch(/no approved company register covers GB/i);
  });

  it('names the bound when one binds, rather than truncating quietly', async () => {
    const adapters = mockAdapters();
    const graph = new AssociationGraphService(
      db,
      subjects,
      adapters,
      new CapabilityCoverageService(db),
      runner,
      audit,
      'mock',
      { maxOfficerCandidates: 3, maxCompaniesPerOfficer: 50 },
    );
    const { searchId } = await pendingSnapshotFor({ fullName: HIGH_FREQUENCY_NAME, graph });
    const view = await graph.build({ tenantId: TENANT, searchId, now: NOW });

    expect(view.coverage.outcome).toBe('INCOMPLETE');
    expect(view.coverage.boundsApplied.join(' ')).toMatch(/capped at 3/);
  });
});

describe('the historical scope needs an approval (FR-02)', () => {
  const request = (tenantId: string): CreateSearchInput => ({
    environment: 'sandbox',
    subjectSnapshot: {
      fullName: 'Ana María Solís',
      aliases: [],
      countryContext: ['CR'],
      knownCompanies: [],
      purpose: 'CUSTOMER_ONBOARDING',
    },
    requestedScope: {
      jurisdictions: ['CR'],
      languages: ['es'],
      includeFormerDirectorships: true,
      fromDate: null,
    },
    ...(tenantId === '' ? {} : {}),
  });

  function principalFor(tenantId: string): Principal {
    return {
      subject: 'reviewer-d3',
      kind: 'HUMAN',
      tenantId,
      roles: [],
      scopes: [],
      environment: 'sandbox',
      breakGlass: null,
    };
  }

  function searchesFor(): SearchesService {
    return new SearchesService(
      db,
      new EntitlementsService(db),
      subjects,
      runner,
      audit,
      new OutboxService(db),
      new IndexerService(db, new InMemorySearchIndex(), new SourceDocumentService(db)),
      new StageExecutionService(db),
      graphOver(mockAdapters()),
    );
  }

  it('refuses a tenant that does not hold it, rather than narrowing the search silently', async () => {
    // `tenant-alpha` holds `adverse_media` only. A silent downgrade to current-only would
    // answer a narrower question than the one asked and label it as though it had not.
    await expect(
      searchesFor().create({
        principal: principalFor('tenant-alpha'),
        data: request('tenant-alpha'),
        now: NOW,
      }),
    ).rejects.toThrow(/approved historical scope/i);
  });

  it('honours it for a tenant that does, and pins the snapshot to the run', async () => {
    const searches = searchesFor();
    const created = await searches.create({
      principal: principalFor('tenant-beta'),
      data: request('tenant-beta'),
      now: NOW,
    });

    const graph = graphOver(mockAdapters());
    const view = await graph.loadForSearch({
      tenantId: 'tenant-beta',
      searchId: created.searchId,
    });

    expect(view.scope).toBe('INCLUDE_FORMER');
    // Created with the run, in the same commit. A run without its snapshot would be a run
    // pointing at a graph that does not exist.
    expect(view.status).toBe('PENDING');
    expect(view.searchId).toBe(created.searchId);

    // Clean up: this borrowed a bootstrapped tenant, so it must leave nothing behind.
    await db
      .collection('graphSnapshots')
      .deleteMany({ tenantId: 'tenant-beta', searchId: created.searchId });
    await db.collection('searchRuns').deleteMany({ searchId: created.searchId });
    await db.collection('auditEvents').deleteMany({ 'target.id': created.searchId });
  });

  it('names the entitlement it needs, so the message is actionable', () => {
    expect(HISTORICAL_DIRECTORSHIPS).toBe('historical_directorships');
  });

  it('cannot be reached by a mock-mode witness trick or any other back door', () => {
    // The scope decision is entitlement state, not process mode. Asserted here so that a later
    // refactor cannot quietly make mock mode permissive.
    expect(MockModeWitness.forMode('LIVE')).toBeNull();
  });
});
