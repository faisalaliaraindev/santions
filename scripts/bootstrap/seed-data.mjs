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

// The rung 2 and rung 4 discovery templates, imported from the built API package for the same
// reason the lexicon is imported above: a second copy of a registry record is a second thing to
// keep in step, and the copy that drifts is the one nobody is reading.
import {
  BING_NEWS_RSS_TEMPLATE,
  GOOGLE_NEWS_RSS_TEMPLATE,
} from '../../apps/api/dist/sources/registry/discovery-rungs.js';
// The four records a tenant is made of, from the one place that defines them. `POST /v1/signup`
// builds a tenant with this same function, so the bootstrap cannot drift from what a real
// customer is provisioned with.
import { buildTenantProvisioning } from '../../apps/api/dist/tenancy/provisioning.js';

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
  // A third tenant, provisioned for LIVE. Entitlement to the live environment is a commercial
  // act by the provider, not something a caller can ask for — `assertCapability` refuses an
  // environment the tenant's entitlement does not list, whatever the credential says. Without a
  // live-entitled tenant seeded, a live end-to-end search cannot be run at all on a local stack,
  // and the refusal reads as a bug in the key rather than as the provisioning step it is.
  //
  // Kept separate from alpha and beta deliberately: they are the sandbox tenants every other
  // suite reasons about, and widening them would quietly change what those tests mean.
  { tenantId: 'tenant-live', name: 'Live Demo (provisioned for live)', environment: 'live' },
];

/**
 * FR-15: `adverse_media` is the only capability. The entitlement version is pinned to every
 * search so a historical run can explain why it was permitted at the time.
 */
const CAPABILITIES = [{ capabilityId: 'adverse_media', name: 'Adverse media search' }];

/**
 * What the seeded taxonomy and policy contain no longer lives here.
 *
 * `buildTenantProvisioning` is the one definition of what a tenant is made of, and it is the
 * same function `POST /v1/signup` uses (phase I, I1). Two copies of "all seventeen categories,
 * these countries, this retention" are two things to keep in step, and the copy that drifts is
 * the one a real customer gets provisioned from while the local stack looks fine. Imported from
 * the built API package for the same reason the discovery templates above are: `pnpm
 * local:bootstrap` builds first, so the import always resolves.
 *
 * The country list, the seventeen categories, the unmeasured languages, the thirty-day
 * retention and the FR-02 traversal bounds — with the reasoning for each — are in
 * `apps/api/src/tenancy/provisioning.ts`.
 */

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
    // `US` is here to match `SEED_COUNTRIES` above. The two lists are different things — what a
    // source covers, and what the taxonomy enables categories for — and a lead only survives the
    // fetch gate where they overlap. They overlapped on `CR` alone, so the only English-language
    // demo the corpus can offer was refused either as `SOURCE_DOES_NOT_COVER_JURISDICTION` (US:
    // enabled, not covered) or `JURISDICTION_NOT_ENABLED` (GB: covered, not enabled). Both
    // refusals are the gates working correctly; the gap was in the fixture, which claimed to
    // serve `en` while covering no country where `en` could be searched.
    countries: ['CR', 'GB', 'US'],
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

  /**
   * The rung 2 and rung 4 query feeds — seeded **PROPOSED**, and that is the whole point.
   *
   * Every other source here is seeded ACTIVE because it is a fixture that talks to nothing.
   * These two name real publishers. Seeding them active would put two unverified endpoints on
   * the ladder of every fresh stack, and the only thing standing between that and a live request
   * would be the fetch gate — which would refuse them, correctly, but relying on the last gate
   * to catch what the first one should never have admitted is how a gate becomes load-bearing by
   * accident.
   *
   * So a fresh stack gets them as drafts an operator can see and work on, in the same registry
   * as everything else, with three separate things still missing and each recorded on the record
   * itself:
   *
   *   - nobody has loaded the endpoint      → `ENDPOINT NOT VERIFIED` in `policySummary`
   *   - nobody has read robots.txt          → `robotsPosition: 'NOT_ESTABLISHED'`
   *   - nobody has accepted first contact   → `accessPolicy.firstContactApproval: null`
   *
   * Rung 3 (GDELT) is deliberately not seeded: it needs its own connector and is not on the path
   * to a live name search, which rungs 2 and 4 are.
   */
  ...[
    ['google-news-rss-en-us', GOOGLE_NEWS_RSS_TEMPLATE],
    ['bing-news-rss-en-us', BING_NEWS_RSS_TEMPLATE],
  ].map(([sourceId, template]) => ({
    sourceId,
    ...template,
    status: 'PROPOSED',
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
    // The same builder `POST /v1/signup` uses, so a seeded tenant and a self-signed-up one are
    // made of the same four records. When they differ, the local stack stops being a rehearsal
    // of what a customer gets — and the difference is found by a customer.
    const provisioned = buildTenantProvisioning({
      tenantId: tenant.tenantId,
      name: tenant.name,
      // A sandbox tenant is entitled to sandbox only. A live tenant keeps sandbox too, because
      // taking live away would mean a customer provisioned for live could no longer rehearse.
      environments: tenant.environment === 'live' ? ['sandbox', 'live'] : ['sandbox'],
      provisionedBy: 'bootstrap',
      // FR-02: a former-director search is selectable only under an **approved** historical
      // scope, and this is that approval. Granted to exactly one seeded tenant on purpose, so
      // both paths are exercised against the bootstrapped stack — granting it to both would
      // leave the refusal untested, and the refusal is the half that matters. A tenant who asks
      // for history and is silently given current-only has been answered a narrower question
      // than the one they asked, with nothing saying so.
      historicalScopeApproved: tenant.tenantId === 'tenant-beta',
      decisionRef:
        'Categories: all seventeen (D-009). Jurisdiction: Costa Rica (D-010), widened to ' +
        'worldwide by D-044 with CR and US enabled. Languages es+en requested but NOT enabled ' +
        'until measured at G10.',
      now: new Date(now),
    });

    // The tenant record keeps the seeded `environment` marker rather than the builder's
    // default: these three exist to be the fixtures other suites reason about, and `tenant-live`
    // saying `sandbox` would make the seed file lie about what it provisioned.
    await upsert(
      'tenants',
      { tenantId: tenant.tenantId },
      { ...provisioned.tenant, environment: tenant.environment },
    );

    await upsert(
      'tenantEntitlementVersions',
      { tenantId: tenant.tenantId, version: 1 },
      provisioned.entitlement,
    );

    await upsert(
      'taxonomyVersions',
      { tenantId: tenant.tenantId, version: 1 },
      provisioned.taxonomy,
    );

    await upsert('policyVersions', { tenantId: tenant.tenantId, version: 1 }, provisioned.policy);
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
