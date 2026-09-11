/**
 * Phase D step D1 — the versioned approval lifecycle and the SEC-05 rights gate, against the
 * real replica set.
 *
 * Not unit tests over a mocked collection. Every property here is a property of what MongoDB
 * actually did: a transaction that wrote the state, the audit entry and the supersede together;
 * an `ACTIVE` version that a second activation replaced without a moment of two live versions;
 * a refused activation that left the clearance behind to explain itself.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 *
 * This suite seeds **its own tenant** and deletes it afterwards. Borrowing `tenant-alpha` is
 * what broke `transactions.test.ts` during Phase C — these suites run in parallel against one
 * database, and shared fixture state makes some other file fail.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Principal, RightsPolicy } from '../../packages/domain/src/index.js';

import { CapabilityCoverageService } from '../../apps/api/src/admin/capability-coverage.service.js';
import {
  VersionedRecordService,
  type DataProfile,
} from '../../apps/api/src/admin/versioned-record.service.js';
import {
  AuditService,
  LocalAuditCheckpointWriter,
} from '../../apps/api/src/persistence/audit.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let records: VersionedRecordService;
let coverage: CapabilityCoverageService;
let audit: AuditService;

const TENANT = `t-admin-${randomUUID()}`;
const NOW = new Date('2026-09-11T12:00:00.000Z');

/** Two different people, both authorised. Four-eyes is about identity, not role. */
function admin(subject: string): Principal {
  return {
    subject,
    kind: 'HUMAN',
    tenantId: TENANT,
    roles: ['source_admin', 'taxonomy_admin'],
    scopes: [],
    environment: 'live',
    breakGlass: null,
  };
}

const PROPOSER = admin('user-proposer');
const APPROVER = admin('user-approver');

function policy(overrides: Partial<RightsPolicy> = {}): RightsPolicy {
  return {
    policyId: 'cr-news-v1',
    jurisdiction: 'CR',
    permittedOperations: ['COLLECT', 'PROCESS', 'STORE'],
    permittedClassifications: ['PUBLISHED_CONTENT'],
    permittedIntendedUses: ['ADVERSE_SCREENING'],
    permittedCollectionMethods: ['PUBLISHED_FEED'],
    permittedRegions: ['us-east-1'],
    maxRetentionDays: 30,
    rawPersonalDataRetentionPermitted: true,
    approvalRequiredFor: [],
    ...overrides,
  };
}

function profile(overrides: Partial<DataProfile> = {}): DataProfile {
  return {
    jurisdiction: 'CR',
    classification: 'PUBLISHED_CONTENT',
    collectionMethod: 'PUBLISHED_FEED',
    intendedUse: 'ADVERSE_SCREENING',
    operations: ['COLLECT', 'PROCESS', 'STORE'],
    requestedRetentionDays: 30,
    retainsRawPersonalData: false,
    processingRegion: 'us-east-1',
    approval: null,
    ...overrides,
  };
}

/** Propose → submit → approve, leaving a version that is ready to activate. */
async function approvedSource(input?: {
  policy?: RightsPolicy;
  profile?: DataProfile;
}): Promise<{ recordId: string; version: number; revision: number }> {
  const recordId = `src-${randomUUID()}`;
  const proposed = await records.propose({
    kind: 'SOURCE',
    principal: PROPOSER,
    recordId,
    content: { sourceName: 'Test source', connectorType: 'NEWS_DISCOVERY_RSS' },
    rightsPolicy: input?.policy ?? policy(),
    dataProfile: input?.profile ?? profile(),
    now: NOW,
  });

  const submitted = await records.transition({
    kind: 'SOURCE',
    principal: PROPOSER,
    recordId,
    version: proposed.version,
    action: 'SUBMIT',
    now: NOW,
  });

  const approved = await records.transition({
    kind: 'SOURCE',
    principal: APPROVER,
    recordId,
    version: proposed.version,
    action: 'APPROVE',
    reason: 'Reviewed licence terms and rate limits.',
    expectedRevision: submitted.revision,
    now: NOW,
  });

  return { recordId, version: approved.version, revision: approved.revision };
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
  db = mongo.db();

  const transactions = new TransactionRunner(mongo);
  audit = new AuditService(db, new LocalAuditCheckpointWriter(db));
  // 'mock' explicitly: every record this suite writes is a fixture and must be labelled as
  // one (T55), exactly as the running service labels what it writes.
  records = new VersionedRecordService(db, transactions, audit, 'mock');
  coverage = new CapabilityCoverageService(db);

  await records.ensureIndexes();
  await coverage.ensureIndexes();
}, 30_000);

afterAll(async () => {
  // Everything this suite wrote, and nothing else.
  await db.collection('sourceVersions').deleteMany({ proposedBy: { $in: ['user-proposer'] } });
  await db.collection('taxonomyVersions').deleteMany({ tenantId: TENANT });
  await db.collection('policyVersions').deleteMany({ tenantId: TENANT });
  await db.collection('auditEvents').deleteMany({ tenantId: TENANT });
  await db.collection<{ _id: string; value: number }>('auditSequences').deleteMany({ _id: TENANT });
  await db.collection('capabilityCoverage').deleteMany({ jurisdiction: 'ZZ' });
  await mongo.close();
});

describe('the propose → approve → activate lifecycle', () => {
  it('activates a version that clears the rights gate', async () => {
    const { recordId, version, revision } = await approvedSource();

    const result = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      expectedRevision: revision,
      now: NOW,
    });

    expect(result.clearance.verdict).toBe('ALLOW');
    expect(result.record.status).toBe('ACTIVE');
    expect(result.record.activatedAt).not.toBeNull();
    // The clearance is stored, not just returned: "why is this live?" has an answer later.
    expect(result.record.rightsClearance?.verdict).toBe('ALLOW');
    expect(result.record.history.map((h) => h.to)).toEqual([
      'AWAITING_APPROVAL',
      'APPROVED',
      'ACTIVATING',
      'ACTIVE',
    ]);
  });

  it('refuses to approve the version its own proposer wrote (T45)', async () => {
    const recordId = `src-${randomUUID()}`;
    const proposed = await records.propose({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      content: {},
      rightsPolicy: policy(),
      dataProfile: profile(),
      now: NOW,
    });
    const submitted = await records.transition({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      version: proposed.version,
      action: 'SUBMIT',
      now: NOW,
    });

    await expect(
      records.transition({
        kind: 'SOURCE',
        principal: PROPOSER,
        recordId,
        version: proposed.version,
        action: 'APPROVE',
        reason: 'Approving my own work.',
        expectedRevision: submitted.revision,
        now: NOW,
      }),
    ).rejects.toThrow(/proposer of a version may not approve it/);

    const after = await records.findVersion({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      version: proposed.version,
    });
    expect(after.status).toBe('AWAITING_APPROVAL');
    expect(after.approvedBy).toBeNull();
  });

  it('records the refused approval in the audit trail, not just a 403', async () => {
    const entries = await audit.list({ tenantId: TENANT, limit: 100 });
    const denied = entries.filter((e) => e.result === 'DENIED' && e.action === 'source:approve');
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]?.reason).toContain('Four-eyes');
  });

  it('refuses to edit a version once it has been submitted', async () => {
    const recordId = `src-${randomUUID()}`;
    const proposed = await records.propose({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      content: { sourceName: 'first' },
      rightsPolicy: policy(),
      dataProfile: profile(),
      now: NOW,
    });
    await records.transition({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      version: proposed.version,
      action: 'SUBMIT',
      now: NOW,
    });

    await expect(
      records.updateDraft({
        kind: 'SOURCE',
        principal: PROPOSER,
        recordId,
        version: proposed.version,
        content: { sourceName: 'switched after approval was requested' },
        now: NOW,
      }),
    ).rejects.toThrow(/cannot be edited/);
  });

  it('supersedes the previous active version in the same transaction', async () => {
    const first = await approvedSource();
    await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId: first.recordId,
      version: first.version,
      now: NOW,
    });

    // A second version of the same source.
    const second = await records.propose({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId: first.recordId,
      content: { sourceName: 'revised' },
      rightsPolicy: policy(),
      dataProfile: profile(),
      now: NOW,
    });
    await records.transition({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId: first.recordId,
      version: second.version,
      action: 'SUBMIT',
      now: NOW,
    });
    const approved = await records.transition({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId: first.recordId,
      version: second.version,
      action: 'APPROVE',
      reason: 'Revised parser version.',
      now: NOW,
    });
    await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId: first.recordId,
      version: approved.version,
      now: NOW,
    });

    const active = await db
      .collection('sourceVersions')
      .find({ sourceId: first.recordId, status: 'ACTIVE' })
      .toArray();
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(2);

    const superseded = await db
      .collection('sourceVersions')
      .findOne({ sourceId: first.recordId, version: 1 });
    expect(superseded?.status).toBe('SUPERSEDED');
    expect(superseded?.supersededAt).not.toBeNull();
  });
});

describe('the SEC-05 gate in front of ACTIVE', () => {
  it('refuses activation of a CAPTCHA-gated source, and says why', async () => {
    const { recordId, version } = await approvedSource({
      policy: policy({ permittedCollectionMethods: ['PUBLISHED_FEED', 'CAPTCHA_GATED'] }),
      profile: profile({ collectionMethod: 'CAPTCHA_GATED' }),
    });

    const result = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      now: NOW,
    });

    expect(result.clearance.verdict).toBe('DENY');
    expect(result.record.status).toBe('APPROVED');
    expect(result.record.activatedAt).toBeNull();
    const codes = result.clearance.perOperation.flatMap((o) =>
      o.decision.reasons.map((r) => r.code),
    );
    expect(codes).toContain('COLLECTION_METHOD_PROHIBITED');
    // The refusal is retained on the record, so an administrator can read it later.
    expect(result.record.rightsClearance?.verdict).toBe('DENY');
  });

  it('blocks activation when an approval is outstanding, without calling it a denial', async () => {
    const { recordId, version } = await approvedSource({
      policy: policy({
        permittedOperations: ['COLLECT', 'PROCESS', 'STORE', 'MODEL_DISCLOSURE'],
        approvalRequiredFor: ['MODEL_DISCLOSURE'],
      }),
      profile: profile({ operations: ['COLLECT', 'MODEL_DISCLOSURE'] }),
    });

    const result = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      now: NOW,
    });

    expect(result.clearance.verdict).toBe('REQUIRES_APPROVAL');
    expect(result.record.status).toBe('APPROVED');
  });

  it('refuses retention longer than the source permits', async () => {
    const { recordId, version } = await approvedSource({
      policy: policy({ maxRetentionDays: 30 }),
      profile: profile({ requestedRetentionDays: 365 }),
    });

    const result = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      now: NOW,
    });

    expect(result.clearance.verdict).toBe('DENY');
    const codes = result.clearance.perOperation.flatMap((o) =>
      o.decision.reasons.map((r) => r.code),
    );
    expect(codes).toContain('RETENTION_EXCEEDS_MAXIMUM');
  });

  it('carries the aggregate-only restriction through to the stored clearance', async () => {
    const { recordId, version } = await approvedSource({
      policy: policy({
        permittedClassifications: ['BULK_PERSONAL_DATA'],
        permittedIntendedUses: ['AGGREGATE_STATISTICS'],
        permittedCollectionMethods: ['BULK_DOWNLOAD'],
        rawPersonalDataRetentionPermitted: false,
        maxRetentionDays: null,
      }),
      profile: profile({
        classification: 'BULK_PERSONAL_DATA',
        intendedUse: 'AGGREGATE_STATISTICS',
        collectionMethod: 'BULK_DOWNLOAD',
        retainsRawPersonalData: false,
        requestedRetentionDays: null,
      }),
    });

    const result = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      now: NOW,
    });

    expect(result.clearance.verdict).toBe('ALLOW');
    expect(result.record.status).toBe('ACTIVE');
    const restrictions = result.record.rightsClearance?.restrictions.map((r) => r.code) ?? [];
    expect(restrictions).toContain('AGGREGATE_ONLY');
    expect(restrictions).toContain('NO_RAW_RECORD_RETENTION');
  });

  it('cannot activate a source that declares no rights policy at all', async () => {
    const recordId = `src-${randomUUID()}`;
    const proposed = await records.propose({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      content: { sourceName: 'undeclared' },
      now: NOW,
    });
    await records.transition({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      version: proposed.version,
      action: 'SUBMIT',
      now: NOW,
    });
    await records.transition({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version: proposed.version,
      action: 'APPROVE',
      reason: 'Looks fine.',
      now: NOW,
    });

    const result = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version: proposed.version,
      now: NOW,
    });

    // An undeclared data profile is an unanswered question, and SEC-05 answers those with "no".
    expect(result.clearance.verdict).toBe('DENY');
    expect(result.record.status).toBe('APPROVED');
  });
});

describe('suspension and restoration', () => {
  it('suspends without a second person, and the version stops being active', async () => {
    const { recordId, version } = await approvedSource();
    const activated = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      now: NOW,
    });

    const suspended = await records.transition({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      action: 'SUSPEND',
      reason: 'Licence expired.',
      expectedRevision: activated.record.revision,
      now: NOW,
    });

    expect(suspended.status).toBe('SUSPENDED');
    expect(await records.findActive({ kind: 'SOURCE', tenantId: null, recordId })).toBeNull();
  });

  it('requires a reason to suspend', async () => {
    const { recordId, version } = await approvedSource();
    await records.activate({ kind: 'SOURCE', principal: APPROVER, recordId, version, now: NOW });

    await expect(
      records.transition({
        kind: 'SOURCE',
        principal: APPROVER,
        recordId,
        version,
        action: 'SUSPEND',
        now: NOW,
      }),
    ).rejects.toThrow(/requires a reason/);
  });

  it('sends a restore back through the gate rather than straight to ACTIVE', async () => {
    const { recordId, version } = await approvedSource();
    await records.activate({ kind: 'SOURCE', principal: APPROVER, recordId, version, now: NOW });
    await records.transition({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      action: 'SUSPEND',
      reason: 'Suspected parse failure.',
      now: NOW,
    });

    const restored = await records.transition({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      action: 'RESTORE',
      reason: 'Parser fixed and re-reviewed.',
      now: NOW,
    });

    // Not ACTIVE yet: restoring re-enters at ACTIVATING so the rights position is re-evaluated.
    expect(restored.status).toBe('ACTIVATING');
    expect(await records.findActive({ kind: 'SOURCE', tenantId: null, recordId })).toBeNull();

    const result = await records.activate({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      expectedRevision: restored.revision,
      now: NOW,
    });
    expect(result.record.status).toBe('ACTIVE');
  });

  it('will not let the proposer restore their own version — restoring needs four eyes', async () => {
    const { recordId, version } = await approvedSource();
    await records.activate({ kind: 'SOURCE', principal: APPROVER, recordId, version, now: NOW });
    await records.transition({
      kind: 'SOURCE',
      principal: APPROVER,
      recordId,
      version,
      action: 'SUSPEND',
      reason: 'Checking something.',
      now: NOW,
    });

    // Suspending needed nobody's agreement; putting it back does.
    await expect(
      records.transition({
        kind: 'SOURCE',
        principal: PROPOSER,
        recordId,
        version,
        action: 'RESTORE',
        reason: 'Back on.',
        now: NOW,
      }),
    ).rejects.toThrow(/proposer of a version may not approve it/);
  });

  it('accepts no action at all once retired', async () => {
    const { recordId, version } = await approvedSource();
    const retired = await records.transition({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      version,
      action: 'RETIRE',
      reason: 'Publisher shut the feed down.',
      now: NOW,
    });
    expect(retired.status).toBe('RETIRED');

    await expect(
      records.transition({
        kind: 'SOURCE',
        principal: APPROVER,
        recordId,
        version,
        action: 'RESTORE',
        reason: 'Changed my mind.',
        now: NOW,
      }),
    ).rejects.toThrow(/not permitted from RETIRED/);

    await expect(
      records.activate({
        kind: 'SOURCE',
        principal: APPROVER,
        recordId,
        version,
        now: NOW,
      }),
    ).rejects.toThrow(/not permitted from RETIRED/);
  }, 15_000);
});

describe('concurrency', () => {
  it('refuses a transition taken against a stale revision, with a recovery path', async () => {
    const recordId = `src-${randomUUID()}`;
    const proposed = await records.propose({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      content: {},
      rightsPolicy: policy(),
      dataProfile: profile(),
      now: NOW,
    });

    await records.transition({
      kind: 'SOURCE',
      principal: PROPOSER,
      recordId,
      version: proposed.version,
      action: 'SUBMIT',
      expectedRevision: proposed.revision,
      now: NOW,
    });

    // A second administrator still holding the revision from before the submit.
    await expect(
      records.transition({
        kind: 'SOURCE',
        principal: APPROVER,
        recordId,
        version: proposed.version,
        action: 'APPROVE',
        reason: 'Approving from a stale read.',
        expectedRevision: proposed.revision,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
});

describe('tenant-owned kinds', () => {
  it('identifies a taxonomy by its tenant, and refuses to address a different one', async () => {
    const proposed = await records.propose({
      kind: 'TAXONOMY',
      principal: PROPOSER,
      recordId: TENANT,
      content: { categories: [] },
      now: NOW,
    });
    expect(proposed.tenantId).toBe(TENANT);
    expect(proposed.recordId).toBe(TENANT);

    // The filter is built from the principal, never from the request, so naming another
    // tenant's id is rejected outright rather than quietly scoped to the caller's own.
    await expect(
      records.findVersion({
        kind: 'TAXONOMY',
        principal: PROPOSER,
        recordId: 't-someone-else',
        version: proposed.version,
      }),
    ).rejects.toThrow(/identified by its tenant/);

    const otherTenant: Principal = { ...PROPOSER, tenantId: `t-other-${randomUUID()}` };
    await expect(
      records.findVersion({
        kind: 'TAXONOMY',
        principal: otherTenant,
        recordId: otherTenant.tenantId ?? '',
        version: proposed.version,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('activates a taxonomy version with a clearance that evaluated no data operations', async () => {
    const recordId = TENANT;
    const proposed = await records.propose({
      kind: 'TAXONOMY',
      principal: PROPOSER,
      recordId,
      content: { categories: [] },
      now: NOW,
    });
    await records.transition({
      kind: 'TAXONOMY',
      principal: PROPOSER,
      recordId,
      version: proposed.version,
      action: 'SUBMIT',
      now: NOW,
    });
    await records.transition({
      kind: 'TAXONOMY',
      principal: APPROVER,
      recordId,
      version: proposed.version,
      action: 'APPROVE',
      reason: 'Lexicon reviewed.',
      now: NOW,
    });

    const result = await records.activate({
      kind: 'TAXONOMY',
      principal: APPROVER,
      recordId,
      version: proposed.version,
      now: NOW,
    });

    expect(result.record.status).toBe('ACTIVE');
    // Visibly nothing evaluated, rather than a clearance pretending an evaluation happened.
    expect(result.clearance.perOperation).toEqual([]);
    expect(result.clearance.policyId).toBe('not-applicable');
  });
});

describe('capability coverage', () => {
  it('defaults an unrecorded jurisdiction to UNKNOWN, never to supported', async () => {
    const statement = await coverage.statementFor({
      jurisdiction: 'ZZ',
      capabilities: ['OFFICER_ASSOCIATIONS', 'COURT_RECORDS'],
      asOf: NOW,
    });

    expect(statement.outcome).toBe('UNKNOWN');
    for (const entry of statement.capabilities) {
      expect(entry.status).toBe('UNKNOWN');
      expect(entry.emptyResultMeans).toBe('NOT_ESTABLISHED');
    }
    expect(statement.gaps).toHaveLength(2);
  });

  it('reports Costa Rica the way D0 established it', async () => {
    const statement = await coverage.statementFor({
      jurisdiction: 'CR',
      capabilities: ['OFFICER_ASSOCIATIONS', 'COMPANY_REGISTRY', 'COURT_RECORDS'],
      asOf: NOW,
    });

    const officers = statement.capabilities.find((c) => c.capability === 'OFFICER_ASSOCIATIONS');
    expect(officers?.status).toBe('UNKNOWN');
    expect(officers?.emptyResultMeans).toBe('NOT_ESTABLISHED');
    expect(officers?.blockedByDecision).toBe('D14');

    const registry = statement.capabilities.find((c) => c.capability === 'COMPANY_REGISTRY');
    expect(registry?.status).toBe('PARTIAL');
    // PARTIAL is not a licence to report a clean result either.
    expect(registry?.emptyResultMeans).toBe('NOT_ESTABLISHED');

    expect(statement.outcome).not.toBe('COMPLETE');
    expect(statement.gaps.length).toBeGreaterThanOrEqual(3);
  });

  it('records a revised status with who declared it and what it rests on', async () => {
    await coverage.declare({
      jurisdiction: 'ZZ',
      capability: 'NEWS_DISCOVERY',
      status: 'SUPPORTED',
      rationale: 'Two approved mastheads.',
      sourceIds: ['src-a', 'src-b'],
      evidenceRef: 'review-2026-09',
      declaredBy: 'user-approver',
      now: NOW,
    });

    const status = await coverage.statusOf('ZZ', 'NEWS_DISCOVERY', NOW);
    expect(status.status).toBe('SUPPORTED');
    expect(status.sourceIds).toEqual(['src-a', 'src-b']);
    expect(status.evidenceRef).toBe('review-2026-09');

    const statement = await coverage.statementFor({
      jurisdiction: 'ZZ',
      capabilities: ['NEWS_DISCOVERY'],
      asOf: NOW,
    });
    expect(statement.outcome).toBe('COMPLETE');
    expect(statement.capabilities[0]?.emptyResultMeans).toBe('NO_FINDINGS');
    expect(statement.gaps).toEqual([]);
  });
});
