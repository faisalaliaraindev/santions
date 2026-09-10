/**
 * A4 — seed the local MongoDB.
 *
 * Everything seeded here is **mock** and carries `mode: 'MOCK'` on the record. Test T55
 * requires that a fixture can never appear as a live result, and the cheapest way to keep
 * that true is for the label to live on the data rather than in a config flag someone can
 * flip.
 *
 * Idempotent throughout: every write is an upsert keyed on a stable id.
 */

import { log, waitFor } from '../lib/local-guard.mjs';

/**
 * Two tenants, matching the `tenant_id` attributes in the Keycloak realm. Two, not one,
 * because test T04 checks that tenant A cannot reach tenant B — and that test cannot be
 * written honestly against a single seeded tenant.
 */
const TENANTS = [
  { tenantId: 'tenant-alpha', name: 'Alpha Compliance (mock)', environment: 'sandbox' },
  { tenantId: 'tenant-beta', name: 'Beta Screening (mock)', environment: 'sandbox' },
];

/**
 * FR-15: `adverse_media` is the only capability. The entitlement version is pinned to every
 * search so a historical run can explain why it was permitted at the time.
 */
const CAPABILITIES = [{ capabilityId: 'adverse_media', name: 'Adverse media search' }];

/**
 * Taxonomy version 1 — all seventeen categories enabled (decision D-009 closes D3).
 *
 * All-on is the right default for a first deployment: it is far easier to notice an
 * irrelevant finding and switch a category off than to discover months later that a whole
 * class of conduct was never searched for. The FR-03 exclusion list still applies at
 * classification time regardless, so 'all categories' never means 'anything goes'.
 */
const SEED_TAXONOMY_CATEGORIES = [
  'FRAUD_FINANCIAL_CRIME',
  'MONEY_LAUNDERING_TF',
  'BRIBERY_CORRUPTION',
  'MARKET_ABUSE',
  'SANCTIONS_EVASION_EXPORT_CONTROL',
  'TAX_OFFENCES',
  'ORGANISED_CRIME',
  'DRUG_OFFENCES',
  'HUMAN_TRAFFICKING_MODERN_SLAVERY',
  'TERRORISM_VIOLENT_EXTREMISM',
  'VIOLENT_CRIME',
  'CYBERCRIME',
  'REGULATORY_PROFESSIONAL_MISCONDUCT',
  'ENVIRONMENTAL_HEALTH_SAFETY',
  'CONSUMER_HARM_MISSELLING',
  'INSOLVENCY_MISCONDUCT',
  'GOVERNANCE_INTEGRITY',
];

/** Decision D-010 closes D1: Costa Rica first, in Spanish and English. */
const SEED_COUNTRIES = ['CR'];

/**
 * Requested languages. NOT the same as enabled languages.
 *
 * FR-03: a language is enabled only once it carries a measured recall figure from the
 * evaluation set. Neither Spanish nor English has one yet, so both are seeded with
 * measuredRecall null and every coverage statement must declare them unmeasured. Phase H
 * (G10) measures them; until then this records intent, not capability.
 */
const SEED_LANGUAGES = ['es', 'en'];

/**
 * Evidence retention, in days (decision D-012 closes D8).
 *
 * Configurable per policy version rather than compiled in, so it can be revised without a
 * deployment. Thirty days is the agreed starting figure, not a legal conclusion: a legal
 * hold overrides it, and deletion must propagate to the search index and to exports, not
 * only to the primary record (SEC-05).
 */
const SEED_EVIDENCE_RETENTION_DAYS = 30;
/**
 * Source registry entries pointing at the local fixture server only. No live source is
 * configured, and none may be activated without the Phase H (G10) measurement.
 */
const SEED_SOURCES = [
  {
    sourceId: 'fixture-newsroom',
    sourceName: 'Fixture Newsroom CR (mock)',
    sourceType: 'NEWS_DISCOVERY',
    authorityTier: 2,
    cascadeRung: 0,
    canonicalDomains: ['fixtures.local'],
    countries: ['CR'],
    languages: ['es', 'en'],
    approvalState: 'ACTIVE',
  },
  {
    sourceId: 'fixture-court',
    sourceName: 'Fixture Court Records CR (mock)',
    sourceType: 'PRIMARY_SOURCE',
    authorityTier: 1,
    cascadeRung: 1,
    canonicalDomains: ['fixtures.local'],
    countries: ['CR'],
    languages: ['es', 'en'],
    approvalState: 'ACTIVE',
  },
];

export async function seedData(db) {
  log.step('Seed data (MongoDB)');

  const now = new Date().toISOString();
  const mock = { mode: 'MOCK', seededAt: now };

  const upsert = async (collection, key, doc) => {
    const result = await db
      .collection(collection)
      .updateOne(
        key,
        { $set: { ...doc, ...mock }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    const label = Object.values(key).join('/');
    if (result.upsertedCount > 0) {
      log.created(`${collection} ${label}`);
    } else {
      log.exists(`${collection} ${label}`);
    }
  };

  for (const capability of CAPABILITIES) {
    await upsert('serviceCapabilities', { capabilityId: capability.capabilityId }, capability);
  }

  for (const tenant of TENANTS) {
    await upsert('tenants', { tenantId: tenant.tenantId }, tenant);

    await upsert(
      'tenantEntitlementVersions',
      { tenantId: tenant.tenantId, version: 1 },
      {
        tenantId: tenant.tenantId,
        version: 1,
        capabilities: ['adverse_media'],
        environments: ['sandbox'],
        status: 'ACTIVE',
        activatedAt: now,
      },
    );

    await upsert(
      'taxonomyVersions',
      { tenantId: tenant.tenantId, version: 1 },
      {
        tenantId: tenant.tenantId,
        version: 1,
        status: 'ACTIVE',
        categories: SEED_TAXONOMY_CATEGORIES.map((category) => ({
          category,
          severityWeight: 3,
          enabledCountries: [...SEED_COUNTRIES],
        })),
        // FR-03: a language is enabled only with a measured recall figure. Neither is measured
        // yet, so both carry null and every coverage statement must declare them unmeasured.
        // Phase H (G10) fills these in.
        languages: SEED_LANGUAGES.map((language) => ({
          language,
          measuredRecall: null,
          measuredByEvaluationRunId: null,
        })),
        lexicon: [],
        proposedBy: 'bootstrap',
        approvedBy: 'bootstrap',
        decisionRef:
          'Categories: all seventeen (D-009). Jurisdiction: Costa Rica (D-010). Languages es+en requested but NOT enabled until measured at G10.',
        activatedAt: now,
      },
    );

    await upsert(
      'policyVersions',
      { tenantId: tenant.tenantId, version: 1 },
      {
        tenantId: tenant.tenantId,
        version: 1,
        status: 'ACTIVE',
        historicalScopeApproved: false,
        queryPlanCap: 200,
        outcomeUnknownAfterDays: 180,
        // D-012: configurable, revisable without a deployment. A legal hold overrides it.
        evidenceRetentionDays: SEED_EVIDENCE_RETENTION_DAYS,
        archiveHorizon: null,
        assumption:
          'Archive horizon is null because no source has been measured. Open decision D2 closes at G10.',
        activatedAt: now,
      },
    );
  }

  for (const source of SEED_SOURCES) {
    await upsert(
      'sourceVersions',
      { sourceId: source.sourceId, version: 1 },
      { ...source, version: 1 },
    );
  }

  log.info(`${String(TENANTS.length)} tenants, ${String(SEED_SOURCES.length)} mock sources`);
  log.info('every seeded record carries mode=MOCK (test T55)');
}

/** Indexes that must exist for tenant-scoped lookups. Tenant context leads every key. */
export async function ensureIndexes(db) {
  log.step('MongoDB indexes');

  const specs = [
    ['tenants', { tenantId: 1 }, { unique: true }],
    ['serviceCapabilities', { capabilityId: 1 }, { unique: true }],
    ['tenantEntitlementVersions', { tenantId: 1, version: -1 }, { unique: true }],
    ['taxonomyVersions', { tenantId: 1, version: -1 }, { unique: true }],
    ['policyVersions', { tenantId: 1, version: -1 }, { unique: true }],
    ['sourceVersions', { sourceId: 1, version: -1 }, { unique: true }],
  ];

  for (const [collection, keys, options] of specs) {
    await db.collection(collection).createIndex(keys, options);
  }
  log.info(`${String(specs.length)} indexes ensured`);
}

export async function connectMongo(uri) {
  const { MongoClient } = await import('mongodb');

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

  await waitFor(
    'MongoDB replica set primary',
    async () => {
      await client.connect();
      // A standalone mongod cannot do transactions, and the outbox commit needs them. So the
      // check is specifically that a primary has been elected, not merely that it responds.
      const status = await client.db('admin').command({ hello: 1 });
      return status.isWritablePrimary === true;
    },
    { timeoutMs: 90_000 },
  );

  return client;
}
