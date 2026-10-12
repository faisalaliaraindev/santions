#!/usr/bin/env node
/**
 * `pnpm source:onboard` — put an indexed source through the real lifecycle, over the real API.
 *
 * # The problem this fixes
 *
 * Ten indexed sources existed in code with parsers, schedules, search support and reviewed row
 * floors, and **not one registry row on a clean deployment**. `scripts/bootstrap/seed-data.mjs`
 * seeds fixtures by writing to Mongo directly; adding real sources to it would mean seeding them
 * `ACTIVE` around the approval lifecycle, which is the one thing that must not happen. So the
 * only route to a working deployment was a person clicking through Postman folder 11 ten times,
 * or reconstructing a database by hand — undocumented either way, and unrepeatable.
 *
 * # What this is instead
 *
 * An operator-run client of the **public Admin API**. It writes nothing to Mongo, holds no
 * privileged access of its own, and can do nothing a person with the same two credentials could
 * not do by hand. Every state change is an ordinary authenticated request, so every one of them
 * lands in the audit trail with a principal attached.
 *
 * ```
 *   propose (proposer key)  ->  SUBMIT (proposer)  ->  APPROVE (approver)  ->  activate (approver)
 * ```
 *
 * **Two credentials, genuinely distinct.** `DISABLE_SOURCE_FOUR_EYES_FOR_TESTING` must be
 * `false`; this script refuses to run if the two keys resolve to the same principal, because a
 * four-eyes lifecycle driven by one pair of eyes is worse than no lifecycle — it produces an
 * audit trail that says something untrue.
 *
 * # Idempotence, and why it is by content
 *
 * A deployment must be able to run this twice without creating a second version of everything.
 * It reads the existing versions first and compares **content**, not counts: an identical ACTIVE
 * version is left alone, an identical version mid-lifecycle is carried forward from wherever it
 * stopped, and only genuinely different content creates a new version. Comparing counts would
 * make a re-run after a half-finished onboarding produce a duplicate, which is the failure mode
 * that turns a registry into a pile of near-identical rows nobody dares delete.
 *
 * # It cannot invent permission
 *
 * Governance fields come from `docs/sources/evidence/<sourceId>.json`, which
 * `pnpm indexed:first-contact` writes from actual requests to the publisher. A source whose
 * evidence does not support activation is proposed and approved and **stopped before
 * activation**, with the blocker recorded on the approval reason. There is no flag to override
 * that, deliberately: the evidence file is the thing to change, by gathering better evidence.
 *
 * ## Usage
 *
 * ```
 * pnpm source:onboard                              # plan only, changes nothing
 * pnpm source:onboard --apply
 * pnpm source:onboard --apply --source ofac-sdn
 * ```
 *
 * Credentials come from the environment, never from an argument — an argument lands in shell
 * history and in the process table:
 *
 * ```
 * SOURCE_PROPOSER_KEY=erly_... SOURCE_APPROVER_KEY=erly_... pnpm source:onboard --apply
 * ```
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

import {
  firstContactApprovalFor,
  firstContactBannerFor,
} from './lib/first-contact-approvals.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = join(repoRoot, 'docs/sources/evidence');

/**
 * D6 — the narrow robots exception, closed 2026-09-21.
 *
 * Four publishers serve their own bulk file from delivery infrastructure whose `robots.txt`
 * answers 403 rather than 404. OFAC and the UN redirect their documented address to a signed,
 * one-hour object-store URL; the FCDO serves the file from a bucket directly. This service reads
 * an unreadable robots.txt as `UNKNOWN` and refuses, which is right in general and wrong for this
 * shape — the redirect is issued by the publisher, to the publisher's own delivery host, for one
 * exact file.
 *
 * The exception is **host-scoped**. `deliveryHosts` are the exact hosts observed in the evidence
 * files, and a hop onto anything else still takes the strict path and is refused. That is the
 * "fail closed if the redirect leaves the expected delivery infrastructure" half of the decision,
 * and it is enforced in `HttpEvidenceFetchAdapter`, not merely stated here.
 */
const ROBOTS_EXCEPTION = {
  approvedBy: 'Faisal Ali',
  role: 'Source admin',
  approvedOn: '2026-09-21',
  decision: 'D6',
  scope:
    "Artifact download only: follow only the publisher-issued redirect from the publisher's own " +
    'documented address, fetch the exact bulk file, and nothing else. No crawling, no bucket ' +
    'listing, no arbitrary object access. Redirect evidence is preserved on the source version ' +
    'and in the fetch log. A hop to any host not named here is refused.',
};

/** The hosts each exception covers, taken from the recorded evidence rather than assumed. */
const DELIVERY_HOSTS = {
  'ofac-sdn': ['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'],
  'ofac-consolidated-non-sdn': ['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'],
  'unsc-consolidated': ['unsolprodfiles.blob.core.windows.net'],
  'uk-sanctions-list': ['sanctionslist.fcdo.gov.uk'],
};

/**
 * Where this deployment processes data, and how long it keeps it.
 *
 * One value for all ten because it is a property of the deployment, not of the publisher. It
 * matches what `buildTenantProvisioning` seeds, so a source cannot be cleared for a retention the
 * tenant policy does not allow.
 */
const PROCESSING_REGION = 'eu-west-2';
const RETENTION_DAYS = 30;

function loadEnv() {
  try {
    const content = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
      }
    }
  } catch {
    // No .env; the explicit checks below produce a better message than a stack trace.
  }
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
}

/** Every source this script onboards, from the compiled registry — never a second copy of a URL. */
async function loadRegistryContent() {
  const registry = async (file) =>
    import(pathToFileURL(join(repoRoot, 'apps/api/dist/sources/registry', file)).href);

  const global = await registry('global-indexed-sources.js');
  const regulators = await registry('regulator-indexed-sources.js');
  const worldBank = await registry('world-bank-indexed-source.js');
  const searxng = await registry('searxng-adverse-media.js');
  const wikinews = await registry('wikinews-en.js');

  return new Map([
    ...Object.entries(global.GLOBAL_INDEXED_SOURCE_CONTENT),
    ...Object.entries(regulators.REGULATOR_INDEXED_SOURCE_CONTENT),
    [worldBank.WORLD_BANK_DEBARRED_SOURCE_ID, worldBank.WORLD_BANK_DEBARRED_CONTENT],
    // The rung-5 metasearch layer. Not an indexed source, and it goes through this script
    // anyway, because the lifecycle is the point: propose -> submit -> approve -> activate, with
    // four eyes, over the public Admin API. A second onboarding path for one source would be a
    // second place the lifecycle could be got wrong.
    [searxng.SEARXNG_SOURCE_ID, searxng.SEARXNG_CONTENT],
    // The first PUBLISHER approved for rung-5 fetching, and the reason it is a separate entry
    // from the line above rather than covered by it: approving the metasearch layer approves
    // querying our own instance, never fetching from whatever that instance names. One domain,
    // one record, one approval (D22).
    [wikinews.WIKINEWS_EN_SOURCE_ID, wikinews.WIKINEWS_EN_CONTENT],
  ]);
}

/**
 * Sources that are a service this deployment runs rather than a third-party publisher.
 *
 * They take a different governance shape at three points, and each one is checked below rather
 * than branched on ad hoc:
 *
 * - **no first-contact approval**, because there is no third party on the hop to consent to
 *   being contacted. Injecting D19's approval here would be a signature on a record nobody gave;
 * - **no robots position**, because there is no robots.txt to establish one from;
 * - **no endpoint URL in the registry**, because the address is deployment configuration.
 *
 * `jurisdictionFor` also has to stop reading the endpoint URL for these, since there is none.
 */
const INTERNAL_SERVICE_SOURCES = new Set(['searxng-adverse-media']);

function readEvidence(sourceId) {
  try {
    return JSON.parse(readFileSync(join(evidenceDir, `${sourceId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The registry content to propose: the reviewed template, plus the governance fields the evidence
 * established.
 *
 * The code template deliberately ships `robotsPosition: 'NOT_ESTABLISHED'` and
 * `firstContactApproval: null`, and `indexed-source-config.test.ts` fails if that stops being
 * true. That is not a value to "fix" in the template — it is the template honestly saying that
 * writing a connector is not the same event as deciding to call someone. The governance values
 * are set **here**, from the evidence file, by the run that a named person authorised.
 */
function contentFor(sourceId, template, evidence) {
  if (INTERNAL_SERVICE_SOURCES.has(sourceId)) {
    // Proposed exactly as the registry module wrote it. Nothing is injected: the two governance
    // fields this script normally fills are the two that must stay empty here, and the reasons
    // are in `INTERNAL_SERVICE_SOURCES` and in the module's own header.
    return { ...template };
  }
  const exception = DELIVERY_HOSTS[sourceId];
  const robotsFromEvidence = evidence?.conclusion?.robotsPosition ?? 'NOT_ESTABLISHED';
  const robotsPosition = exception === undefined ? robotsFromEvidence : 'EXCEPTION_APPROVED';

  return {
    ...template,
    robotsPosition,
    accessPolicy: {
      ...template.accessPolicy,
      firstContactApproval: firstContactApprovalFor(sourceId),
      ...(exception === undefined
        ? {}
        : { robotsException: { ...ROBOTS_EXCEPTION, deliveryHosts: exception } }),
    },
  };
}

/** Bulk files are downloaded; RSS is a published feed. The distinction is what the policy clears. */
function collectionMethodFor(template) {
  if (template.connectorType === 'NEWS_DISCOVERY_SEARXNG') {
    // The metasearch instance serves a published JSON API and we read it as one. Not
    // BULK_DOWNLOAD, which would describe pulling a file, and not HTML_FETCH, which would
    // describe scraping a page — the connector does neither and the record should not say it does.
    return 'PUBLISHED_API';
  }
  if (template.connectorType === 'EVIDENCE_FETCH_HTTP') {
    // One article page at a time, over HTTP, because a discovery service named that URL. That is
    // HTML_FETCH and nothing else. Letting this fall through to the BULK_DOWNLOAD default below
    // would put a false declaration on an approved version — the rights policy would clear a
    // collection method this source never performs, and would not clear the one it does.
    return 'HTML_FETCH';
  }
  return template.connectorType === 'INDEXED_RSS' ? 'PUBLISHED_FEED' : 'BULK_DOWNLOAD';
}

/**
 * The rights policy and the data profile.
 *
 * `retainsRawPersonalData` is **true**, and the policy permits it, because it is what the code
 * actually does: `IndexedSourceRepository.toStored` keeps the publisher's own fields in
 * `rawEvidence` so a finding can be checked against what the publisher published. Declaring
 * `false` here while storing the record would be a false declaration on an approved version,
 * which is worse than a permissive one that is true.
 */
function rightsFor(sourceId, template) {
  const method = collectionMethodFor(template);
  const jurisdiction = jurisdictionFor(template);
  return {
    rightsPolicy: {
      policyId: `${sourceId}-${template.licenceTermsVersion}`.slice(0, 120),
      jurisdiction,
      permittedOperations: ['COLLECT', 'PROCESS', 'STORE', 'DISPLAY'],
      permittedClassifications: ['PUBLIC_RECORD', 'PUBLISHED_CONTENT'],
      permittedIntendedUses: ['ADVERSE_SCREENING'],
      permittedCollectionMethods: [method],
      permittedRegions: [PROCESSING_REGION],
      maxRetentionDays: RETENTION_DAYS,
      rawPersonalDataRetentionPermitted: true,
      approvalRequiredFor: [],
    },
    dataProfile: {
      jurisdiction,
      // A designation list is a public record: the publishing authority publishes it precisely so
      // that it is acted on. Not BULK_PERSONAL_DATA, which would be the right reading of a
      // population register and the wrong one of a sanctions list.
      // A designation list is a public record. A news article a metasearch instance surfaced is
      // not: it is published content, written by a publisher, and calling it a public record
      // would overstate what it is on every finding it supports.
      classification:
        template.connectorType === 'NEWS_DISCOVERY_SEARXNG' ? 'PUBLISHED_CONTENT' : 'PUBLIC_RECORD',
      collectionMethod: method,
      intendedUse: 'ADVERSE_SCREENING',
      operations: ['COLLECT', 'PROCESS', 'STORE', 'DISPLAY'],
      requestedRetentionDays: RETENTION_DAYS,
      retainsRawPersonalData: true,
      processingRegion: PROCESSING_REGION,
      approval: null,
    },
  };
}

/**
 * The jurisdiction the rights policy is written under — the publisher's own, not ours.
 *
 * `countryCodeSchema` refuses regional pseudo-codes, so a GLOBAL source still has to name the
 * country whose law its publisher acts under. That is the honest answer anyway: the UN's terms
 * are not "global law", they are the terms of a body headquartered somewhere.
 */
function jurisdictionFor(template) {
  if (template.accessPolicy.endpointUrl === null) {
    // Two kinds of source record no endpoint: an internal service (the address is deployment
    // configuration) and a fetch-only publisher reached solely by following a discovered link
    // (D-043 — a recorded endpoint would be a second way in that the discovery path never goes
    // through). Either way there is no host to read a jurisdiction off, and the rights policy is
    // written under the law this deployment operates under, which is where the processing
    // actually happens.
    return 'GB';
  }
  const host = new URL(template.accessPolicy.endpointUrl).host;
  if (host.endsWith('.gov.uk') || host.endsWith('.fca.org.uk')) {
    return 'GB';
  }
  if (host.endsWith('europa.eu')) {
    return 'BE';
  }
  return 'US';
}

/** Whether the gathered evidence supports taking this source all the way to ACTIVE. */
function activationSupport(sourceId, template, evidence) {
  if (INTERNAL_SERVICE_SOURCES.has(sourceId)) {
    // The evidence file for an internal service records what the instance IS, not whether a
    // publisher permits contact — so `activationSupported` is read from it the same way, and its
    // absence blocks activation the same way. What activation does NOT do is authorise any
    // upstream engine: that is `engine-governance.ts`, and it is a code change under review.
    if (evidence === null) {
      return {
        supported: false,
        blocker:
          `No evidence file at docs/sources/evidence/${sourceId}.json. Audit the instance ` +
          `first: read GET {SEARXNG_URL}/config and record what it has enabled.`,
      };
    }
    return evidence.conclusion?.activationSupported === true
      ? { supported: true, blocker: null }
      : {
          supported: false,
          blocker: evidence.conclusion?.blocker ?? 'Evidence does not support activation.',
        };
  }
  if (evidence === null) {
    return {
      supported: false,
      blocker:
        `No evidence file at docs/sources/evidence/${sourceId}.json. Run ` +
        // Not every publisher's evidence comes from the same script: a fetch-only source has no
        // endpoint for `indexed:first-contact` to verify, so naming that script here would send
        // the reader to one that cannot gather it.
        `${sourceId === 'wikinews-en' ? 'pnpm wikinews:first-contact' : 'pnpm indexed:first-contact'}.`,
    };
  }
  if (DELIVERY_HOSTS[sourceId] !== undefined) {
    // The endpoint could not be verified by the evidence script precisely because it stopped at
    // the redirect the D6 exception now covers. The exception is the evidence that this hop is
    // permitted; the controlled first refresh is what verifies the endpoint.
    return { supported: true, blocker: null };
  }
  if (evidence.conclusion?.activationSupported === true) {
    return { supported: true, blocker: null };
  }
  return {
    supported: false,
    blocker: evidence.conclusion?.blocker ?? 'Evidence does not support activation.',
  };
}

function sameContent(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

/** A tiny typed client over the Admin API. Every call carries one of the two credentials. */
function adminClient(baseUrl) {
  const call = async (key, method, path, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `ApiKey ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed, etag: response.headers.get('etag') };
  };

  return {
    listVersions: (key, recordId) =>
      call(key, 'GET', `/v1/admin/sources?recordId=${encodeURIComponent(recordId)}&limit=200`),
    readVersion: (key, recordId, version) =>
      call(key, 'GET', `/v1/admin/sources/${encodeURIComponent(recordId)}/versions/${version}`),
    propose: (key, body) => call(key, 'POST', '/v1/admin/sources', body),
    transition: (key, recordId, version, body, revision) =>
      call(
        key,
        'POST',
        `/v1/admin/sources/${encodeURIComponent(recordId)}/versions/${version}/transitions`,
        body,
        { 'if-match': `"${revision}"` },
      ),
    activate: (key, recordId, version, revision) =>
      call(
        key,
        'POST',
        `/v1/admin/sources/${encodeURIComponent(recordId)}/versions/${version}/activate`,
        undefined,
        { 'if-match': `"${revision}"` },
      ),
  };
}

/**
 * A successful write.
 *
 * `POST /transitions` and `POST /activate` answer **201**, because Nest's default status for a
 * POST is 201 and neither route overrides it. Checking for exactly 200 treated nine successful
 * submissions as failures while the lifecycle had in fact advanced — the kind of bug that leaves
 * real state behind and reports none of it.
 */
function ok(status) {
  return status >= 200 && status < 300;
}

function fail(message) {
  console.error(`\n  FAILED  ${message}\n`);
  process.exitCode = 1;
}

async function main() {
  loadEnv();
  const baseUrl = (process.env['ONBOARD_BASE_URL'] ?? 'http://127.0.0.1:28081').replace(/\/$/u, '');
  const proposerKey = process.env['SOURCE_PROPOSER_KEY'];
  const approverKey = process.env['SOURCE_APPROVER_KEY'];
  const apply = process.argv.includes('--apply');
  const only = arg('source');

  const templates = await loadRegistryContent();
  const sourceIds = only === undefined ? [...templates.keys()] : [only];
  if (only !== undefined && !templates.has(only)) {
    fail(`No indexed source is registered in code as ${only}.`);
    return;
  }

  console.log(`
────────────────────────────────────────────────────────────────────────────────
  INDEXED SOURCE ONBOARDING — propose -> submit -> approve -> activate
────────────────────────────────────────────────────────────────────────────────
  API              ${baseUrl}
  Sources          ${sourceIds.length}
  Mode             ${apply ? 'APPLY — this will change registry state' : 'PLAN — nothing is sent'}
  First contact    ${firstContactBannerFor(sourceIds, (id) => INTERNAL_SERVICE_SOURCES.has(id))}
`);

  const plan = [];
  for (const sourceId of sourceIds) {
    const template = templates.get(sourceId);
    const evidence = readEvidence(sourceId);
    const support = activationSupport(sourceId, template, evidence);
    plan.push({
      sourceId,
      template,
      evidence,
      support,
      content: contentFor(sourceId, template, evidence),
      ...rightsFor(sourceId, template),
    });
  }

  console.log(`  ${'sourceId'.padEnd(40)} ${'robots'.padEnd(18)} target`);
  for (const row of plan) {
    console.log(
      `  ${row.sourceId.padEnd(40)} ${row.content.robotsPosition.padEnd(18)} ` +
        `${row.support.supported ? 'ACTIVE' : 'APPROVED (blocked)'}`,
    );
    if (row.support.blocker !== null) {
      console.log(`      blocker: ${row.support.blocker}`);
    }
  }

  if (!apply) {
    console.log('\n  Nothing was sent. Re-run with --apply\n');
    return;
  }
  if (proposerKey === undefined || approverKey === undefined) {
    fail('SOURCE_PROPOSER_KEY and SOURCE_APPROVER_KEY must both be set in the environment.');
    return;
  }
  if (proposerKey === approverKey) {
    fail(
      'The proposer and approver keys are identical. Four eyes means two principals; running ' +
        'the lifecycle with one produces an audit trail that says something untrue.',
    );
    return;
  }
  if ((process.env['DISABLE_SOURCE_FOUR_EYES_FOR_TESTING'] ?? 'false') !== 'false') {
    fail(
      'DISABLE_SOURCE_FOUR_EYES_FOR_TESTING is set. Onboarding real sources under the testing ' +
        'bypass would mark every approval as not an independent second opinion.',
    );
    return;
  }

  const api = adminClient(baseUrl);
  const results = [];

  for (const row of plan) {
    console.log(`\n──── ${row.sourceId}`);
    const result = await onboardOne(api, proposerKey, approverKey, row);
    results.push(result);
    console.log(`  ${result.outcome}: ${result.detail}`);
  }

  console.log(`
────────────────────────────────────────────────────────────────────────────────
  RESULT
────────────────────────────────────────────────────────────────────────────────
  ${'sourceId'.padEnd(40)} ${'version'.padEnd(8)} ${'state'.padEnd(12)} outcome`);
  for (const r of results) {
    console.log(
      `  ${r.sourceId.padEnd(40)} ${String(r.version ?? '-').padEnd(8)} ` +
        `${String(r.state ?? '-').padEnd(12)} ${r.outcome}`,
    );
  }
  const active = results.filter((r) => r.state === 'ACTIVE').length;
  console.log(`\n  ${String(active)} of ${String(results.length)} source(s) ACTIVE.\n`);
}

/**
 * One source, from wherever it currently is to wherever the evidence permits.
 *
 * Written as "read the state, then take the next step that state allows", rather than as a fixed
 * four-call sequence, because a re-run after a partial failure has to resume rather than restart.
 */
async function onboardOne(api, proposerKey, approverKey, row) {
  const { sourceId, content, rightsPolicy, dataProfile, support } = row;
  const base = { sourceId, version: null, state: null };

  const existing = await api.listVersions(proposerKey, sourceId);
  if (existing.status !== 200) {
    return {
      ...base,
      outcome: 'FAILED',
      detail: `Could not list versions: HTTP ${existing.status} ${JSON.stringify(existing.body)}`,
    };
  }
  const versions = existing.body.items ?? [];

  // An identical ACTIVE version is the finished state. Say so and change nothing — this is what
  // makes a second run of a bootstrap safe.
  const activeSame = versions.find((v) => v.status === 'ACTIVE' && sameContent(v.content, content));
  if (activeSame !== undefined) {
    return {
      ...base,
      version: activeSame.version,
      state: 'ACTIVE',
      outcome: 'ALREADY_ACTIVE',
      detail: `v${activeSame.version} is ACTIVE with identical content. Nothing to do.`,
    };
  }

  // An identical version part-way through is carried forward rather than duplicated.
  let target = versions.find(
    (v) =>
      sameContent(v.content, content) &&
      ['PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'ACTIVATING'].includes(v.status),
  );

  if (target === undefined) {
    const proposed = await api.propose(proposerKey, {
      recordId: sourceId,
      content,
      rightsPolicy,
      dataProfile,
    });
    if (proposed.status !== 201) {
      return {
        ...base,
        outcome: 'FAILED',
        detail: `Propose refused: HTTP ${proposed.status} ${JSON.stringify(proposed.body)}`,
      };
    }
    target = proposed.body;
    console.log(`  proposed v${target.version} (${target.status})`);
  } else {
    console.log(`  resuming v${target.version} at ${target.status}`);
  }

  const evidenceRef = `docs/sources/evidence/${sourceId}.json`;
  // The decision covering THIS source, not a fixed D19. These two strings become the reason on
  // the audit entry for the submit and the approval, and an audit entry naming the wrong decision
  // is worse than one naming none: it is a specific, checkable, false claim about who authorised
  // contacting this publisher. An internal service has no such decision and says so.
  const firstContact = INTERNAL_SERVICE_SOURCES.has(sourceId)
    ? null
    : firstContactApprovalFor(sourceId);

  // SUBMIT — the proposer's act.
  if (target.status === 'PROPOSED') {
    const submitted = await api.transition(
      proposerKey,
      sourceId,
      target.version,
      {
        action: 'SUBMIT',
        reason:
          (firstContact === null
            ? 'Submitted for approval. Internal service — no publisher first contact applies. '
            : `Submitted for approval under ${firstContact.decision}. `) +
          `Publisher evidence: ${evidenceRef}.`,
      },
      target.revision,
    );
    if (!ok(submitted.status)) {
      return {
        ...base,
        version: target.version,
        state: target.status,
        outcome: 'FAILED',
        detail: `Submit refused: HTTP ${submitted.status} ${JSON.stringify(submitted.body)}`,
      };
    }
    target = submitted.body;
    console.log(`  submitted -> ${target.status}`);
  }

  // APPROVE — a different principal's act. The reason carries the evidence reference and, where
  // one applies, the robots exception, so the audit entry says what was relied on.
  if (target.status === 'AWAITING_APPROVAL') {
    const exception = content.accessPolicy.robotsException;
    const approved = await api.transition(
      approverKey,
      sourceId,
      target.version,
      {
        action: 'APPROVE',
        reason:
          (firstContact === null
            ? 'Internal service — no publisher first contact applies. '
            : `Approved by ${firstContact.approvedBy}, ${firstContact.role}. ` +
              `Robots position ${content.robotsPosition}; first contact ${firstContact.decision}. `) +
          (exception === undefined
            ? ''
            : `Robots exception ${exception.decision} scoped to ${exception.deliveryHosts.join(', ')}. `) +
          `Evidence: ${evidenceRef}.`,
      },
      target.revision,
    );
    if (!ok(approved.status)) {
      return {
        ...base,
        version: target.version,
        state: target.status,
        outcome: 'FAILED',
        detail: `Approve refused: HTTP ${approved.status} ${JSON.stringify(approved.body)}`,
      };
    }
    target = approved.body;
    console.log(`  approved -> ${target.status}`);
  }

  // Activation is the step the evidence gates. A source whose publisher evidence does not support
  // it stops here, APPROVED, with the blocker on the record — not half-configured, and not live.
  if (!support.supported) {
    return {
      ...base,
      version: target.version,
      state: target.status,
      outcome: 'STOPPED_AT_APPROVED',
      detail: `Not activated: ${support.blocker}`,
    };
  }

  if (target.status === 'APPROVED' || target.status === 'ACTIVATING') {
    const activated = await api.activate(approverKey, sourceId, target.version, target.revision);
    if (!ok(activated.status)) {
      return {
        ...base,
        version: target.version,
        state: target.status,
        outcome: 'FAILED',
        detail: `Activate refused: HTTP ${activated.status} ${JSON.stringify(activated.body)}`,
      };
    }
    const wire = activated.body.version;
    if (!activated.body.activated) {
      return {
        ...base,
        version: wire.version,
        state: wire.status,
        outcome: 'RIGHTS_REFUSED',
        detail: `The SEC-05 rights gate refused activation: ${JSON.stringify(activated.body.clearance)}`,
      };
    }
    target = wire;
    console.log(`  activated -> ${target.status}`);
  }

  // Read it back through the API rather than trusting the response we just received. "It returned
  // 200" and "it is ACTIVE when asked" are different facts, and only the second one is the one an
  // operator cares about.
  const verified = await api.readVersion(approverKey, sourceId, target.version);
  if (verified.status !== 200) {
    return {
      ...base,
      version: target.version,
      state: target.status,
      outcome: 'FAILED',
      detail: `Read-back failed: HTTP ${verified.status}`,
    };
  }
  return {
    ...base,
    version: verified.body.version,
    state: verified.body.status,
    outcome: verified.body.status === 'ACTIVE' ? 'ACTIVATED' : 'INCOMPLETE',
    detail: `Verified through GET /v1/admin/sources/${sourceId}/versions/${verified.body.version}: ${verified.body.status}.`,
  };
}

await main();
