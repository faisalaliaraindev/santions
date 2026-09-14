/**
 * Phase D step D6 — the lexicon audit on the **activation path**, against the real replica set.
 *
 * `assertLexiconClean` already fails CI, and CI catches a term an engineer commits. It catches
 * nothing a `taxonomy_admin` types into the admin API at three in the afternoon. These tests are
 * about that second path: a taxonomy edited at runtime must meet the same bar the build enforces,
 * the refusal must leave an audit entry behind, and the version must not become `ACTIVE`.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 *
 * Seeds its own tenant and its own source, and deletes both afterwards.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEED_LEXICON, type Principal } from '../../packages/domain/src/index.js';

import { TaxonomyService } from '../../apps/api/src/admin/taxonomy.service.js';
import { VersionedRecordService } from '../../apps/api/src/admin/versioned-record.service.js';
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

const TENANT = `t-taxon-${randomUUID()}`;
const SOURCE = `src-taxon-${randomUUID()}`;
const NOW = new Date('2026-09-14T12:00:00.000Z');

function admin(subject: string): Principal {
  return {
    subject,
    kind: 'HUMAN',
    tenantId: TENANT,
    roles: ['taxonomy_admin'],
    scopes: [],
    environment: 'live',
    breakGlass: null,
  };
}

const PROPOSER = admin('taxon-proposer');
const APPROVER = admin('taxon-approver');

/** Categories enabled for CR, which the seeded source covers. */
function categories(): unknown[] {
  return [
    { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['CR'] },
    { category: 'BRIBERY_CORRUPTION', severityWeight: 5, enabledCountries: ['CR'] },
  ];
}

const UNMEASURED = [
  { language: 'es', measuredRecall: null, measuredByEvaluationRunId: null },
  { language: 'en', measuredRecall: null, measuredByEvaluationRunId: null },
];

/** Propose → submit → approve a taxonomy version, leaving it ready to activate. */
async function approvedTaxonomy(content: Record<string, unknown>): Promise<number> {
  const proposed = await records.propose({
    kind: 'TAXONOMY',
    principal: PROPOSER,
    recordId: TENANT,
    content,
    now: NOW,
  });
  const submitted = await records.transition({
    kind: 'TAXONOMY',
    principal: PROPOSER,
    recordId: TENANT,
    version: proposed.version,
    action: 'SUBMIT',
    now: NOW,
  });
  await records.transition({
    kind: 'TAXONOMY',
    principal: APPROVER,
    recordId: TENANT,
    version: proposed.version,
    action: 'APPROVE',
    reason: 'Reviewed the category list.',
    expectedRevision: submitted.revision,
    now: NOW,
  });
  return proposed.version;
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
  const audit = new AuditService(db, new LocalAuditCheckpointWriter(db));
  records = new VersionedRecordService(db, transactions, audit, 'mock');
  await records.ensureIndexes();
  await audit.ensureIndexes();

  // One approved active source covering CR, so the category-coverage rule has something to find.
  await db.collection('sourceVersions').insertOne({
    sourceId: SOURCE,
    version: 1,
    status: 'ACTIVE',
    mode: 'MOCK',
    countries: ['CR'],
    sourceName: 'Taxonomy fixture source',
  });
}, 30_000);

afterAll(async () => {
  await db.collection('sourceVersions').deleteMany({ sourceId: SOURCE });
  await db.collection('taxonomyVersions').deleteMany({ tenantId: TENANT });
  await db.collection('auditEvents').deleteMany({ tenantId: TENANT });
  await db.collection<{ _id: string }>('auditSequences').deleteMany({ _id: TENANT });
  await mongo.close();
});

describe('a protected-characteristic term is refused at activation (T79)', () => {
  it('refuses, leaves the version unactivated, and audits the denial', async () => {
    const version = await approvedTaxonomy({
      categories: categories(),
      languages: UNMEASURED,
      lexicon: [
        {
          term: 'muslim businessman fraud',
          language: 'en',
          kind: 'CONDUCT',
          category: 'FRAUD_FINANCIAL_CRIME',
          rank: 1,
          reviewState: 'UNREVIEWED_AUTHORED',
        },
      ],
    });

    await expect(
      records.activate({
        kind: 'TAXONOMY',
        principal: APPROVER,
        recordId: TENANT,
        version,
        now: NOW,
      }),
    ).rejects.toThrow(/cannot be activated/i);

    const stored = await db.collection('taxonomyVersions').findOne({ tenantId: TENANT, version });
    // Not ACTIVE. The refusal is the whole point, and a version that activated anyway would put
    // a protected characteristic into an outbound query.
    expect(stored?.['status']).not.toBe('ACTIVE');

    const denial = await db
      .collection('auditEvents')
      .findOne({ tenantId: TENANT, action: 'taxonomy:activate', result: 'DENIED' });
    expect(denial).not.toBeNull();
    expect(String(denial?.['reason'])).toContain('PROTECTED_CHARACTERISTIC_TERM');
  });

  it('refuses a machine-translated term (D-010)', async () => {
    const version = await approvedTaxonomy({
      categories: categories(),
      languages: UNMEASURED,
      lexicon: [
        {
          term: 'acusado de estafa',
          language: 'es',
          kind: 'CONDUCT',
          category: 'FRAUD_FINANCIAL_CRIME',
          rank: 1,
          reviewState: 'MACHINE_TRANSLATED',
        },
      ],
    });

    await expect(
      records.activate({
        kind: 'TAXONOMY',
        principal: APPROVER,
        recordId: TENANT,
        version,
        now: NOW,
      }),
    ).rejects.toThrow(/cannot be activated/i);
  });
});

describe('a language cannot be enabled by an administrative edit', () => {
  it('refuses a recall figure typed into the admin API', async () => {
    const version = await approvedTaxonomy({
      categories: categories(),
      languages: [
        { language: 'es', measuredRecall: 0.88, measuredByEvaluationRunId: 'eval-i-made-up' },
        { language: 'en', measuredRecall: null, measuredByEvaluationRunId: null },
      ],
      lexicon: [],
    });

    await expect(
      records.activate({
        kind: 'TAXONOMY',
        principal: APPROVER,
        recordId: TENANT,
        version,
        now: NOW,
      }),
    ).rejects.toThrow(/cannot be activated/i);

    const denial = await db
      .collection('auditEvents')
      .find({ tenantId: TENANT, action: 'taxonomy:activate', result: 'DENIED' })
      .sort({ sequence: -1 })
      .limit(1)
      .toArray();
    expect(String(denial[0]?.['reason'])).toContain('RECALL_NOT_SET_BY_EVALUATION');
  });
});

describe('a category cannot be enabled where nothing can look for it', () => {
  it('refuses a country with no approved active source', async () => {
    const version = await approvedTaxonomy({
      categories: [
        { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['CR', 'ZZ'] },
      ],
      languages: UNMEASURED,
      lexicon: [],
    });

    await expect(
      records.activate({
        kind: 'TAXONOMY',
        principal: APPROVER,
        recordId: TENANT,
        version,
        now: NOW,
      }),
    ).rejects.toThrow(/cannot be activated/i);
  });
});

describe('a clean version activates, seed lexicon and all', () => {
  it('activates and becomes the tenant active version', async () => {
    const version = await approvedTaxonomy({
      categories: categories(),
      languages: UNMEASURED,
      lexicon: [...SEED_LEXICON],
    });

    const result = await records.activate({
      kind: 'TAXONOMY',
      principal: APPROVER,
      recordId: TENANT,
      version,
      now: NOW,
    });

    expect(result.record.status).toBe('ACTIVE');
    expect(result.clearance.verdict).toBe('ALLOW');

    // Readable by the same service the pipeline uses, which is the half that would otherwise
    // silently not hold: the bootstrap writes taxonomy fields flat and this service nests them
    // under `content`, so a version activated through the admin API must still load.
    const loaded = await new TaxonomyService(db).loadPinned(TENANT, version);
    // 155 hand-authored terms, none machine-translated, none protected.
    expect(loaded.lexicon.length).toBe(SEED_LEXICON.length);
    expect(loaded.categories.length).toBe(2);
    expect(loaded.languages.every((l) => l.measuredRecall === null)).toBe(true);
  });
});
