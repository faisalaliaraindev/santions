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

// The FR-03 seed lexicon is imported from the built domain package rather than copied here.
// Copying it would put a second term list beside the one `auditLexicon` gates in CI (T79), and
// the copy is the one that acquires a protected-characteristic term nobody checks. `pnpm
// local:bootstrap` builds first, so the import always resolves.
import { SEED_LEXICON } from '../../packages/domain/dist/index.js';

import { log, waitFor } from '../lib/local-guard.mjs';
import { loadNameFrequency } from './name-frequency.mjs';

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
 *
 * **Expanded in D2 to the full FR-05 field list.** These carried nine fields until the
 * adapters existed; now the content of a source version is checked against
 * `sourceContentSchema` when it is submitted for approval and again when it is activated, so a
 * seeded source that did not conform would be one an administrator could look at but never put
 * through an approval — a registry entry that exists and cannot be administered. `sourceType`
 * became `connectorType`, which is the name the schema and the ports use; nothing read the old
 * one.
 *
 * `mode: 'MOCK'` is stamped on the envelope by the upsert below, not declared here. It is not
 * a content field: a source that could declare its own mode could declare a fixture live
 * (T55).
 */
const SEED_SOURCES = [
  {
    sourceId: 'fixture-newsroom',
    sourceName: 'Fixture Newsroom CR (mock)',
    publisher: 'Local fixture server',
    connectorType: 'FIXTURE_MOCK',
    authorityTier: 2,
    cascadeRung: 0,
    canonicalDomains: ['fixtures.local'],
    countries: ['CR'],
    languages: ['es', 'en'],
    credentialsRef: null,
    // A fixture server has no free tier to exhaust. Null is "no declared budget", which is the
    // honest value — zero would mean "no requests permitted" and stop the fixture working.
    freeTierHourlyBudget: null,
    freeTierDailyBudget: null,
    stabilityClass: 'DOCUMENTED_STABLE',
    parserVersion: 'fixture-1',
    licenceTermsVersion: 'fixture-local-1',
    // Not HONOURED: there is no robots.txt on a fixture server to honour, and claiming to have
    // honoured one would put a false statement in the record that the fetch gate reads.
    robotsPosition: 'NOT_ESTABLISHED',
    contentFormat: 'HTML',
    status: 'ACTIVE',
  },
  {
    sourceId: 'fixture-court',
    sourceName: 'Fixture Court Records CR (mock)',
    publisher: 'Local fixture server',
    connectorType: 'FIXTURE_MOCK',
    authorityTier: 1,
    cascadeRung: 1,
    canonicalDomains: ['fixtures.local'],
    countries: ['CR'],
    languages: ['es', 'en'],
    credentialsRef: null,
    freeTierHourlyBudget: null,
    freeTierDailyBudget: null,
    stabilityClass: 'DOCUMENTED_STABLE',
    parserVersion: 'fixture-1',
    licenceTermsVersion: 'fixture-local-1',
    robotsPosition: 'NOT_ESTABLISHED',
    // The real Costa Rican judicial publications are PDF, and the fixture matches that so the
    // extraction path a CR source would take is the one the fixture exercises.
    contentFormat: 'PDF',
    status: 'ACTIVE',
  },
  // The six D2 mock adapters, registered as what they are (Phase D step D5).
  //
  // **Why they have to be here.** D5 makes the pipeline ask `SourceHealthService.checkAccess`
  // before every call, and a source with no active version is *refused* — because an adapter
  // pointed at a source nobody approved is exactly what the registry exists to prevent. That
  // rule has to hold for the fixtures too, or the mock stack would be exercising a path the
  // live one does not have. So the fixtures are registered, approved and budgeted like any
  // other source, and the only thing that distinguishes them is `connectorType: 'FIXTURE_MOCK'`
  // and a `mode: 'MOCK'` stamp that T55 refuses to let them shed.
  ...[
    // The rung each mock is approved at, and it must match the rung its adapter actually
    // serves — the FR-05 ladder is built from the registry (D-045), so a mock seeded at the
    // wrong rung makes mock mode rehearse a ladder that does not exist. The web mock serves
    // rungs 5 and 6; it is approved at 5, and rung 6 honestly reports as unsearched because
    // no high-authority domain is approved for direct site search.
    ['src-mock-news-discovery', 'Mock news discovery', 2, 'XML_FEED'],
    ['src-mock-web-discovery', 'Mock web discovery', 5, 'JSON'],
    ['src-mock-primary', 'Mock primary source', 1, 'HTML'],
    ['src-mock-cr-registry', 'Mock company registry', 1, 'JSON'],
    ['src-mock-fetch', 'Mock evidence fetch', 0, 'HTML'],
    ['src-mock-extraction', 'Mock extraction model', 0, 'JSON'],
  ].map(([sourceId, sourceName, cascadeRung, contentFormat]) => ({
    sourceId,
    sourceName: `${sourceName} (fixture)`,
    publisher: 'Deterministic fixture',
    connectorType: 'FIXTURE_MOCK',
    authorityTier: 3,
    cascadeRung,
    canonicalDomains: ['fixtures.local'],
    countries: ['CR', 'GB'],
    languages: ['es', 'en'],
    credentialsRef: null,
    // Null, not zero. A fixture has no free tier to exhaust, and zero would mean "no requests
    // permitted" and stop every mock-mode run with an exhausted-budget coverage gap.
    freeTierHourlyBudget: null,
    freeTierDailyBudget: null,
    stabilityClass: 'DOCUMENTED_STABLE',
    parserVersion: 'fixture-1',
    licenceTermsVersion: 'fixture-local-1',
    // No end date: a fixture's terms do not expire, and inventing one would put a licence clock
    // into the registry that nobody agreed.
    licenceExpiresAt: null,
    robotsPosition: 'NOT_ESTABLISHED',
    contentFormat,
    status: 'ACTIVE',
  })),
];

/**
 * Phase D — per-jurisdiction capability coverage (D1).
 *
 * These rows are the D0 dossier's findings expressed as data the service enforces, and they
 * are the reason nothing in `packages/domain/src/capability` knows what Costa Rica is. Every
 * one of them can be revised through `PUT /v1/admin/coverage` by a source admin without a
 * deployment; what cannot be revised is the rule that anything other than SUPPORTED means an
 * empty result is NOT_ESTABLISHED rather than "no findings".
 */
const CAPABILITY_COVERAGE = [
  {
    jurisdiction: 'CR',
    capability: 'OFFICER_ASSOCIATIONS',
    status: 'UNKNOWN',
    rationale:
      'No free automatable officer-level source is known. The Registro Nacional publishes ' +
      'company representatives only behind free registration and a CAPTCHA, which this ' +
      'service does not go through by any path; api.hacienda.go.cr returns entity status and ' +
      'economic activity but no directors.',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md#1',
    blockedByDecision: 'D14',
  },
  {
    jurisdiction: 'CR',
    capability: 'COMPANY_REGISTRY',
    status: 'PARTIAL',
    rationale:
      'Entity existence and tax status are obtainable; ownership and officers are not. ' +
      'Sufficient to corroborate that a company is real, not to build an association graph.',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md#1',
    blockedByDecision: 'D14',
  },
  {
    jurisdiction: 'CR',
    capability: 'COURT_RECORDS',
    status: 'UNKNOWN',
    rationale:
      'Published judgments are probably depersonalised — the Poder Judicial operates a ' +
      'de-identification protocol and a repository of depersonalised judgments. Whether any ' +
      'class of judgment names the parties is not established.',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md#2',
    blockedByDecision: 'D15',
  },
  {
    jurisdiction: 'CR',
    capability: 'GAZETTE_NOTICES',
    status: 'UNKNOWN',
    rationale:
      'La Gaceta and the Boletin Judicial publish as dated PDFs and are the most promising ' +
      'named-person official channel, but no source has been reviewed or approved.',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md',
    blockedByDecision: 'D15',
  },
  {
    jurisdiction: 'CR',
    capability: 'REGULATOR_ENFORCEMENT',
    status: 'UNKNOWN',
    rationale:
      'The superintendencies hold sanctioning powers, but no standing public register of ' +
      'sanctioned parties was found; publication appears to route through the gazette.',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md',
    blockedByDecision: null,
  },
  {
    jurisdiction: 'CR',
    capability: 'PROSECUTOR_BULLETINS',
    status: 'UNKNOWN',
    rationale:
      'OIJ and Ministerio Publico publish bulletins, but whether they name people in full or ' +
      'by initials is not established, and nothing is approved.',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md',
    blockedByDecision: null,
  },
  {
    jurisdiction: 'CR',
    capability: 'NAME_FREQUENCY',
    status: 'UNKNOWN',
    rationale:
      'A national distribution is obtainable from the TSE electoral roll, under an ' +
      'aggregate-only restriction: derive the surname counts and discard the records. Not ' +
      'yet loaded, so no frequency prior applies and common surnames score as rare ones.',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md#3',
    blockedByDecision: null,
  },
  {
    jurisdiction: 'CR',
    capability: 'NEWS_DISCOVERY',
    status: 'UNKNOWN',
    rationale:
      'Spanish-language mastheads have not been enumerated or tiered, and the Spanish ' +
      'conduct lexicon has not been reviewed by a Spanish reader (D-010).',
    sourceIds: [],
    evidenceRef: 'docs/sources/cr-dossier.md',
    blockedByDecision: null,
  },
  {
    jurisdiction: 'CR',
    capability: 'SANCTIONS_DESIGNATIONS',
    status: 'UNKNOWN',
    rationale: 'Designation lists are leads only (FR-05) and none has been approved.',
    sourceIds: [],
    evidenceRef: null,
    blockedByDecision: null,
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
        // The D6 term list. Every term is `UNREVIEWED_AUTHORED` and nothing is machine
        // translated: no Spanish reader has reviewed the `es` half, the coverage statement says
        // so on every run that searches in Spanish, and `packages/domain/src/taxonomy/
        // seed-lexicon.ts` says what a reviewer should check first. See D-033.
        lexicon: SEED_LEXICON,
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
        // FR-02: a former-director search is selectable only under an **approved** historical
        // scope, and this is that approval. Granted to exactly one seeded tenant on purpose, so
        // both paths are exercised against the bootstrapped stack — granting it to both would
        // leave the refusal untested, and the refusal is the half that matters. A tenant who
        // asks for history and is silently given current-only has been answered a narrower
        // question than the one they asked, with nothing saying so.
        historicalScopeApproved: tenant.tenantId === 'tenant-beta',
        queryPlanCap: 200,
        // The FR-02 one-hop traversal bounds (Phase D step D4). Configuration, not constants:
        // a customer screening shell-company networks can have these raised through the D1
        // approval lifecycle without a deployment, and the run pins the version it used so an
        // old report keeps explaining its own truncation. `resolveGraphBounds` validates them
        // and falls back to documented defaults rather than failing a search over a typo.
        associationBounds: {
          maxOfficerCandidates: 25,
          maxCompaniesPerOfficer: 50,
          maxEdgesPerSnapshot: 500,
        },
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
    // The bootstrap is an upsert, so a field *removed* from `SEED_SOURCES` survives on a
    // database that was seeded before the change — `$set` never deletes. Two have been renamed
    // and both were still sitting on this machine's database: `approvalState` became `status`
    // in D1, and `sourceType` became `connectorType` in D2.
    //
    // That is not cosmetic now that D2 checks content against the FR-05 schema. A leftover
    // field lands in the version's *content*, the schema is `.strict()`, and the next person to
    // administer that source gets a conformance error naming a field nobody in the current code
    // has ever written. Unset explicitly here rather than left to a `local:reset` that somebody
    // may reasonably never run.
    await db
      .collection('sourceVersions')
      .updateOne(
        { sourceId: source.sourceId, version: 1 },
        { $unset: { sourceType: '', approvalState: '' } },
      );
  }

  for (const coverage of CAPABILITY_COVERAGE) {
    await upsert(
      'capabilityCoverage',
      { jurisdiction: coverage.jurisdiction, capability: coverage.capability },
      { ...coverage, assessedAt: new Date(now), declaredBy: 'bootstrap' },
    );
  }

  // FR-01 — the name-frequency prior. Loads nothing today and says so, loudly, every run:
  // the Costa Rican distribution is blocked on the SEC-05 approval for aggregate-only use of
  // the TSE padrón (D0, D-011). A silent no-op here would let the absence be forgotten, and the
  // absence is the reason a common Costa Rican name currently reaches a higher identity grade
  // than it should (FR-08, T71).
  await loadNameFrequency(db);

  log.info(`${String(TENANTS.length)} tenants, ${String(SEED_SOURCES.length)} mock sources`);
  log.info(
    `${String(CAPABILITY_COVERAGE.length)} CR capability rows: nothing is SUPPORTED, so an ` +
      'empty result is never reported as "no findings"',
  );
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
    // Shared, not tenant-owned: what the service can do in a country is a property of the
    // service and its approved sources, not of a customer.
    ['capabilityCoverage', { jurisdiction: 1, capability: 1 }, { unique: true }],
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
