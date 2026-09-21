/**
 * `DISABLE_SOURCE_FOUR_EYES_FOR_TESTING` — what it narrows, and everything it does not.
 *
 * # Read this before changing anything here
 *
 * Four eyes (SEC-06) is enforced on `principal.subject`, not on role, and it exists so that the
 * source record the fetch gate reads names somebody who actually looked at it. This flag turns
 * that off for `SOURCE` versions. It was added deliberately, for one reason — a three-source live
 * test in a deployment that has no second named person behind its approver credential — and the
 * whole of its safety is in the list below being true.
 *
 * So the tests are written from the other direction. Nearly all of them assert what the flag
 * **fails** to relax:
 *
 * - default off, and refusing exactly as before when it is off;
 * - `SOURCE` only — a taxonomy still needs two people;
 * - the `source:approve` permission is still required, so it forgives an *identity*, never an
 *   authorisation;
 * - the lifecycle is unchanged: propose → submit → approve → activate, with the SEC-05 rights
 *   clearance still evaluated at activation;
 * - every approval taken under it is marked, twice and permanently — once in the version's own
 *   history, where nobody reading "who approved this?" can miss it, and once as its own audit
 *   action, so an auditor can list every such approval without reading prose.
 *
 * The production guard lives in `config.ts` and is asserted in
 * `apps/api/test/four-eyes-flag-config.test.ts`, which needs no database.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Principal, RightsPolicy } from '../../packages/domain/src/index.js';

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

let mongo: MongoClient;
let db: Db;
/** The default. Four eyes enforced, exactly as production runs. */
let enforcing: VersionedRecordService;
/** The flag on. Everything else identical, including the same audit service and transactions. */
let bypassing: VersionedRecordService;

const TENANT = `t-4eyes-${randomUUID()}`;
const NOW = new Date('2026-09-18T12:00:00.000Z');

function admin(subject: string, roles: Principal['roles']): Principal {
  return {
    subject,
    kind: 'HUMAN',
    tenantId: TENANT,
    roles,
    scopes: [],
    environment: 'live',
    breakGlass: null,
  };
}

/** One person, holding the proposer and approver permission — the situation the flag is for. */
const SOLO = admin('user-solo', ['source_admin', 'taxonomy_admin']);
const OTHER = admin('user-other', ['source_admin', 'taxonomy_admin']);
/** Authorised for nothing relevant. Used to prove the flag forgives identity, not permission. */
const UNAUTHORISED = admin('user-viewer', ['viewer']);

function policy(): RightsPolicy {
  return {
    policyId: 'test-policy-v1',
    jurisdiction: 'US',
    permittedOperations: ['COLLECT', 'PROCESS', 'STORE', 'DISPLAY'],
    permittedClassifications: ['PUBLIC_RECORD', 'PUBLISHED_CONTENT'],
    permittedIntendedUses: ['ADVERSE_SCREENING'],
    permittedCollectionMethods: ['PUBLISHED_FEED', 'HTML_FETCH'],
    permittedRegions: ['eu-west-2'],
    maxRetentionDays: 30,
    rawPersonalDataRetentionPermitted: false,
    approvalRequiredFor: [],
  };
}

function profile(): DataProfile {
  return {
    jurisdiction: 'US',
    classification: 'PUBLIC_RECORD',
    collectionMethod: 'PUBLISHED_FEED',
    intendedUse: 'ADVERSE_SCREENING',
    operations: ['COLLECT', 'PROCESS', 'STORE', 'DISPLAY'],
    requestedRetentionDays: 30,
    retainsRawPersonalData: false,
    processingRegion: 'eu-west-2',
    approval: null,
  };
}

function sourceContent(): Record<string, unknown> {
  return {
    sourceName: 'Four-eyes flag fixture',
    publisher: 'Test',
    connectorType: 'NEWS_DISCOVERY_RSS',
    canonicalDomains: ['example.test'],
    authorityTier: 3,
    cascadeRung: 1,
    countries: ['US'],
    languages: ['en'],
    credentialsRef: null,
    freeTierHourlyBudget: null,
    freeTierDailyBudget: null,
    stabilityClass: 'DOCUMENTED_STABLE',
    parserVersion: 'test-1',
    licenceTermsVersion: 'test-terms-1',
    licenceExpiresAt: null,
    robotsPosition: 'NOT_ESTABLISHED',
    contentFormat: 'HTML',
    accessPolicy: {
      requestCeilingPerSecond: null,
      pollFloorSeconds: null,
      endpointUrl: 'https://example.test/feed',
      endpointKind: 'FIXED_FEED',
      queryParam: null,
      conditionalGet: true,
      userAgentRequired: true,
      policyUrl: null,
      policySummary: 'Fixture.',
      stopConditions: {
        haltOnStatuses: [403],
        haltOnRateLimit: true,
        rateLimitCooldownSeconds: 600,
        serverErrorStreakToHalt: 3,
        requiresFreshApprovalOnHalt: true,
      },
      firstContactApproval: null,
      robotsException: null,
    },
  };
}

/** Propose and submit as `SOLO`, leaving a version awaiting approval. */
async function awaitingApproval(
  service: VersionedRecordService,
  kind: 'SOURCE' | 'TAXONOMY' = 'SOURCE',
): Promise<{ recordId: string; version: number; revision: number }> {
  // A taxonomy version is identified by its tenant, not by a free id — the service refuses any
  // other recordId for that kind.
  const recordId = kind === 'TAXONOMY' ? TENANT : `fx-${randomUUID()}`;
  const proposed = await service.propose({
    kind,
    principal: SOLO,
    recordId,
    content: sourceContent(),
    rightsPolicy: policy(),
    dataProfile: profile(),
    now: NOW,
  });
  const submitted = await service.transition({
    kind,
    principal: SOLO,
    recordId,
    version: proposed.version,
    action: 'SUBMIT',
    now: NOW,
  });
  return { recordId, version: proposed.version, revision: submitted.revision };
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongo.connect();
  db = mongo.db();
  const transactions = new TransactionRunner(mongo);
  const audit = new AuditService(db, new LocalAuditCheckpointWriter(db));
  enforcing = new VersionedRecordService(db, transactions, audit, 'mock', false);
  bypassing = new VersionedRecordService(db, transactions, audit, 'mock', true);
  await enforcing.ensureIndexes();
}, 30_000);

afterAll(async () => {
  await db.collection('sourceVersions').deleteMany({ proposedBy: { $in: ['user-solo'] } });
  await db.collection('taxonomyVersions').deleteMany({ tenantId: TENANT });
  // Source audit entries are written under the platform tenant, not the caller's, so both are
  // cleaned: the tenant-scoped taxonomy entries and this suite's source entries by target id.
  await db.collection('auditEvents').deleteMany({ tenantId: TENANT });
  await db.collection('auditEvents').deleteMany({ 'target.id': { $regex: '^fx-' } });
  await db.collection<{ _id: string; value: number }>('auditSequences').deleteMany({ _id: TENANT });
  await mongo.close();
});

describe('with the flag off, which is the default', () => {
  it('refuses the proposer approving their own source version', async () => {
    const { recordId, version, revision } = await awaitingApproval(enforcing);

    await expect(
      enforcing.transition({
        kind: 'SOURCE',
        principal: SOLO,
        recordId,
        version,
        action: 'APPROVE',
        reason: 'Trying to approve my own proposal.',
        expectedRevision: revision,
        now: NOW,
      }),
    ).rejects.toThrow(/proposer of a version may not approve it/iu);
  });

  it('is the default when the constructor is not told otherwise', async () => {
    // The production wiring passes `config.disableSourceFourEyesForTesting`; this asserts that a
    // caller who forgets the argument entirely still gets the enforcing behaviour.
    const defaulted = new VersionedRecordService(
      db,
      new TransactionRunner(mongo),
      new AuditService(db, new LocalAuditCheckpointWriter(db)),
      'mock',
    );
    const { recordId, version, revision } = await awaitingApproval(defaulted);

    await expect(
      defaulted.transition({
        kind: 'SOURCE',
        principal: SOLO,
        recordId,
        version,
        action: 'APPROVE',
        reason: 'Trying to approve my own proposal.',
        expectedRevision: revision,
        now: NOW,
      }),
    ).rejects.toThrow(/proposer of a version may not approve it/iu);
  });
});

describe('with the flag on', () => {
  it('lets one source_admin propose and approve, and marks the record permanently', async () => {
    const { recordId, version, revision } = await awaitingApproval(bypassing);

    const approved = await bypassing.transition({
      kind: 'SOURCE',
      principal: SOLO,
      recordId,
      version,
      action: 'APPROVE',
      reason: 'Approved for the three-source live test.',
      expectedRevision: revision,
      now: NOW,
    });

    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe('user-solo');

    // The marker is on the version's own history, not only in the audit log. Anybody who reads
    // "who approved this source?" reads, in the same sentence, that it was the proposer.
    const entry = approved.history.find((h) => h.action === 'APPROVE');
    expect(entry?.reason).toContain('Approved for the three-source live test.');
    expect(entry?.reason).toContain('FOUR-EYES BYPASSED FOR TESTING');
    expect(entry?.reason).toContain('NOT an independent second opinion');
  });

  it('writes a separately greppable audit event naming the bypass', async () => {
    const { recordId, version, revision } = await awaitingApproval(bypassing);
    await bypassing.transition({
      kind: 'SOURCE',
      principal: SOLO,
      recordId,
      version,
      action: 'APPROVE',
      reason: 'Approved for the three-source live test.',
      expectedRevision: revision,
      now: NOW,
    });

    const events = await db.collection('auditEvents').find({ 'target.id': recordId }).toArray();
    const actions = events.map((e) => e['action']);

    // Both: the ordinary approval entry is still written, and the marker is its own action.
    expect(actions).toContain('source:approve');
    expect(actions).toContain('source:four_eyes_bypassed_for_testing');

    const marker = events.find((e) => e['action'] === 'source:four_eyes_bypassed_for_testing');
    expect(marker?.['result']).toBe('ALLOWED');
    expect(String(marker?.['reason'])).toContain('DISABLE_SOURCE_FOUR_EYES_FOR_TESTING');
  });

  it('still refuses a principal without source:approve — it forgives identity, not permission', async () => {
    const { recordId, version, revision } = await awaitingApproval(bypassing);

    await expect(
      bypassing.transition({
        kind: 'SOURCE',
        principal: UNAUTHORISED,
        recordId,
        version,
        action: 'APPROVE',
        reason: 'I should not be able to do this.',
        expectedRevision: revision,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it('does not mark an approval that genuinely had two people behind it', async () => {
    const { recordId, version, revision } = await awaitingApproval(bypassing);

    const approved = await bypassing.transition({
      kind: 'SOURCE',
      principal: OTHER,
      recordId,
      version,
      action: 'APPROVE',
      reason: 'Reviewed independently.',
      expectedRevision: revision,
      now: NOW,
    });

    // A real second opinion must not be tarred with the marker just because the flag was on.
    const entry = approved.history.find((h) => h.action === 'APPROVE');
    expect(entry?.reason).toBe('Reviewed independently.');

    const events = await db.collection('auditEvents').find({ 'target.id': recordId }).toArray();
    expect(events.map((e) => e['action'])).not.toContain('source:four_eyes_bypassed_for_testing');
  });

  it('still requires a reason, because the audit trail is not relaxed', async () => {
    const { recordId, version, revision } = await awaitingApproval(bypassing);

    await expect(
      bypassing.transition({
        kind: 'SOURCE',
        principal: SOLO,
        recordId,
        version,
        action: 'APPROVE',
        reason: '   ',
        expectedRevision: revision,
        now: NOW,
      }),
    ).rejects.toThrow(/requires a reason/iu);
  });

  it('does not extend to a taxonomy, which still needs two people', async () => {
    const { recordId, version, revision } = await awaitingApproval(bypassing, 'TAXONOMY');

    await expect(
      bypassing.transition({
        kind: 'TAXONOMY',
        principal: SOLO,
        recordId,
        version,
        action: 'APPROVE',
        reason: 'Trying to approve my own taxonomy.',
        expectedRevision: revision,
        now: NOW,
      }),
    ).rejects.toThrow(/proposer of a version may not approve it/iu);
  });

  it('leaves the lifecycle and the SEC-05 rights gate intact through to ACTIVE', async () => {
    const { recordId, version, revision } = await awaitingApproval(bypassing);
    const approved = await bypassing.transition({
      kind: 'SOURCE',
      principal: SOLO,
      recordId,
      version,
      action: 'APPROVE',
      reason: 'Approved for the three-source live test.',
      expectedRevision: revision,
      now: NOW,
    });

    const { record, clearance } = await bypassing.activate({
      kind: 'SOURCE',
      principal: SOLO,
      recordId,
      version,
      expectedRevision: approved.revision,
      now: NOW,
    });

    // Activation still evaluated the rights clearance and still recorded it on the version.
    expect(clearance.verdict).toBe('ALLOW');
    expect(record.status).toBe('ACTIVE');
    expect(record.rightsClearance?.policyId).toBe('test-policy-v1');
    // And the whole path is still on the record: propose → submit → approve → activate.
    const actions = record.history.map((h) => h.action);
    expect(actions).toContain('SUBMIT');
    expect(actions).toContain('APPROVE');
    expect(actions).toContain('COMPLETE_ACTIVATION');
  });
});
