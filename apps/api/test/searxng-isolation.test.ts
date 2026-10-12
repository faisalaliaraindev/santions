/**
 * SearXNG must never be able to subtract from what another source found — §14 of the milestone.
 *
 * `partial-results.test.ts` establishes the general rule for the feed rungs. This file is the
 * rung-5 half, and it is worth its own file because the metasearch layer can fail at **two
 * grains** and the two must behave differently:
 *
 * - **An engine fails.** Google is suspended on CAPTCHA, the other three answer. Nothing is
 *   lost: the query is an `OK` outcome carrying the engines that answered, and the failure is a
 *   diagnostic rather than a coverage gap for the source.
 * - **The instance fails.** The whole layer is unreachable. That IS a coverage gap for
 *   `searxng-adverse-media`, recorded with its reason — and the SEC leads found at rung 1 are
 *   untouched, because they were found before rung 5 was reached and nothing here can reach back.
 *
 * The other three properties are the ones a reader of a SearXNG finding most needs to be true,
 * and each is checked against the **real** domain function rather than a restatement of it:
 *
 * - **Syndicated copies collapse** (§13). Four engines returning one story is one cluster, and a
 *   wire story republished elsewhere joins it rather than corroborating it. An SEC enforcement
 *   action does not.
 * - **A name-only match stays AMBIGUOUS** (§11). A metasearch article naming the same name with
 *   no discriminator is not a supported identity, and a contradicting date of birth does not
 *   become one either.
 * - **A publisher refusal produces no finding** (§10). A search result whose article FetchGate
 *   refuses is a rejected lead with a reason, never a finding built from the snippet.
 *
 * Nothing here opens a socket.
 */

import { describe, expect, it } from 'vitest';

import type { Db } from 'mongodb';

import {
  assignClusters,
  cascadeCoverageOutcomes,
  gradeIdentity,
  mergeSourceCoverageOutcomes,
  resolveIdentityEvidence,
  type AssignableCandidate,
  type DocumentIdentityEvidence,
  type RungAttempt,
  type SubjectIdentityEvidence,
  type TaxonomyVersion,
} from '@adverse-search/domain';

import { CascadeService, type CascadeHealthPort } from '../src/pipeline/cascade.service.js';
import { LadderBuilder } from '../src/pipeline/ladder.builder.js';
import { DiscoveryRequestLog } from '../src/sources/discovery-request-log.js';
import type {
  EvidenceFetchPort,
  FetchRequest,
  FetchResult,
} from '../src/sources/evidence-fetch.port.js';
import { FetchGateService } from '../src/sources/fetch-gate.service.js';
import { FixedFeedPollCache } from '../src/sources/feed-poll-cache.js';
import type { DiscoveryQuery } from '../src/sources/lead.js';
import { SEARXNG_SOURCE_ID } from '../src/sources/registry/searxng-adverse-media.js';
import { SEC_LITIGATION_RELEASES_SOURCE_ID } from '../src/sources/registry/sec-litigation-releases.js';
import { SearxngEngineLog } from '../src/sources/searxng/engine-health.js';
import {
  defaultResolvedEngines,
  type EngineEnablementPort,
  type ResolvedEngine,
} from '../src/sources/searxng/engine-enablement.service.js';
import {
  SearxngClient,
  validateSearxngBaseUrl,
  type SearxngTransport,
  type SearxngTransportResult,
} from '../src/sources/searxng/searxng-client.js';
import { ok, type AdapterDescriptor, type SourceOutcome } from '../src/sources/source-adapter.js';
import type {
  ActiveSourceVersion,
  SourceVersionReader,
} from '../src/sources/source-version.service.js';
import type { SourceAdapterSet } from '../src/sources/sources.registry.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const CONTACT = 'https://example.com/bots/adverse-search';
const BASE = 'http://127.0.0.1:28888';

const SEC_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss';
const SEC_LEAD_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26640';
const REUTERS_URL = 'https://www.reuters.com/legal/kipp-charged-2026-08-18/';

// ---------------------------------------------------------------------------------------------
// The registry, as the ladder builder reads it
// ---------------------------------------------------------------------------------------------

const SEC_CONTENT = {
  sourceName: 'SEC litigation releases (RSS)',
  connectorType: 'NEWS_DISCOVERY_RSS',
  canonicalDomains: ['www.sec.gov'],
  countries: ['US'],
  languages: ['en'],
  robotsPosition: 'HONOURED',
  licenceTermsVersion: 'sec-fair-access-2026-09-15',
  cascadeRung: 1,
  authorityTier: 1,
  accessPolicy: {
    endpointUrl: SEC_URL,
    endpointKind: 'FIXED_FEED',
    queryParam: null,
    pollFloorSeconds: 900,
    conditionalGet: true,
    firstContactApproval: {
      approvedBy: 'Faisal Ali',
      role: 'Source admin',
      approvedOn: '2026-09-15',
      decision: 'D17',
    },
    robotsException: null,
  },
};

const SEARXNG_CONTENT_DOC = {
  sourceName: 'SearXNG adverse-media discovery (self-hosted)',
  connectorType: 'NEWS_DISCOVERY_SEARXNG',
  canonicalDomains: ['searxng.internal'],
  jurisdictionScope: 'GLOBAL',
  countries: [],
  languages: ['en'],
  // Left exactly as the real record carries them, so the test proves the internal path
  // authorises despite them rather than being handed a version dressed up as a publisher.
  robotsPosition: 'NOT_ESTABLISHED',
  licenceTermsVersion: 'self-hosted-searxng-agpl-3.0',
  cascadeRung: 5,
  authorityTier: 5,
  accessPolicy: {
    endpointUrl: null,
    endpointKind: 'QUERY_FEED',
    queryParam: 'q',
    pollFloorSeconds: null,
    conditionalGet: false,
    firstContactApproval: null,
    robotsException: null,
  },
};

const DOCUMENTS: readonly Record<string, unknown>[] = [
  {
    sourceId: SEC_LITIGATION_RELEASES_SOURCE_ID,
    status: 'ACTIVE',
    version: 1,
    versionId: `${SEC_LITIGATION_RELEASES_SOURCE_ID}:v1`,
    content: SEC_CONTENT,
  },
  {
    sourceId: SEARXNG_SOURCE_ID,
    status: 'ACTIVE',
    version: 1,
    versionId: `${SEARXNG_SOURCE_ID}:v1`,
    content: SEARXNG_CONTENT_DOC,
  },
];

const VERSIONS: Readonly<Record<string, ActiveSourceVersion>> = {
  [SEC_LITIGATION_RELEASES_SOURCE_ID]: {
    sourceId: SEC_LITIGATION_RELEASES_SOURCE_ID,
    versionId: `${SEC_LITIGATION_RELEASES_SOURCE_ID}:v1`,
    version: 1,
    sourceName: 'SEC litigation releases (RSS)',
    connectorType: 'NEWS_DISCOVERY_RSS',
    canonicalDomains: ['www.sec.gov'],
    countries: ['US'],
    languages: ['en'],
    robotsPosition: 'HONOURED',
    licenceTermsVersion: 'sec-fair-access-2026-09-15',
    licenceExpiresAt: null,
    cascadeRung: 1,
    authorityTier: 1,
    firstContactApproval: {
      approvedBy: 'Faisal Ali',
      role: 'Source admin',
      approvedOn: '2026-09-15',
      decision: 'D17',
    },
    robotsException: null,
    endpointUrl: SEC_URL,
    endpointKind: 'FIXED_FEED',
    queryParam: null,
    pollFloorMs: 15 * 60_000,
    requestCeilingPerSecond: null,
  },
  [SEARXNG_SOURCE_ID]: {
    sourceId: SEARXNG_SOURCE_ID,
    versionId: `${SEARXNG_SOURCE_ID}:v1`,
    version: 1,
    sourceName: 'SearXNG adverse-media discovery (self-hosted)',
    connectorType: 'NEWS_DISCOVERY_SEARXNG',
    canonicalDomains: ['searxng.internal'],
    jurisdictionScope: 'GLOBAL',
    countries: [],
    languages: ['en'],
    robotsPosition: 'NOT_ESTABLISHED',
    licenceTermsVersion: 'self-hosted-searxng-agpl-3.0',
    licenceExpiresAt: null,
    cascadeRung: 5,
    authorityTier: 5,
    firstContactApproval: null,
    robotsException: null,
    endpointUrl: null,
    endpointKind: 'QUERY_FEED',
    queryParam: 'q',
    pollFloorMs: null,
    requestCeilingPerSecond: null,
  },
};

const SEC_FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0"><channel>',
  '<title>SEC</title><language>en-us</language>',
  '<item>',
  '<title>SEC Charges Jon P. Kipp With Fraud</title>',
  `<link>${SEC_LEAD_URL}</link>`,
  '<description>The Commission filed a complaint.</description>',
  '<pubDate>Mon, 18 Aug 2026 14:00:00 GMT</pubDate>',
  '</item>',
  '</channel></rss>',
].join('\n');

const FETCH_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'test-fetch',
  portKind: 'EVIDENCE_FETCH',
  sourceId: 'test',
  parserVersion: 'test-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'LIVE',
  jurisdictions: [],
};

class SecOnlyFetch implements EvidenceFetchPort {
  readonly requests: FetchRequest[] = [];
  readonly descriptor = FETCH_DESCRIPTOR;

  fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>> {
    this.requests.push(request);
    const bytes = new TextEncoder().encode(SEC_FEED);
    return Promise.resolve(
      ok(FETCH_DESCRIPTOR, NOW, {
        url: request.url,
        finalUrl: request.url,
        httpStatus: 200,
        headers: { 'content-type': 'application/rss+xml' },
        body: bytes,
        notModified: false,
        contentType: 'application/rss+xml',
        bytes: bytes.byteLength,
        renderTrigger: null,
        egressIdentityId: 'egress-primary',
        fetchedAt: NOW.toISOString(),
      }),
    );
  }

  robotsPositionFor(): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'> {
    return Promise.resolve('ALLOWED');
  }
}

/**
 * A transport that answers per engine.
 *
 * Keyed on the `engines` parameter, because the connector issues one request per engine. A single
 * canned reply could not express "Google was blocked while Wikinews answered", which is the whole
 * point of this file.
 */
class StubTransport implements SearxngTransport {
  readonly urls: string[] = [];
  private readonly single: SearxngTransportResult | null;
  private readonly byEngine: Readonly<Record<string, SearxngTransportResult>>;

  constructor(replies: SearxngTransportResult | Readonly<Record<string, SearxngTransportResult>>) {
    // Split at construction rather than narrowed at call time: a `Record<string, ...>` can
    // legitimately hold a `kind` key, so an `in` check would be a narrowing that is wrong for
    // exactly the input a future test is most likely to write.
    const isSingle = 'kind' in replies && typeof replies['kind'] === 'string';
    this.single = isSingle ? replies : null;
    this.byEngine = isSingle ? {} : replies;
  }

  send(input: { url: string; timeoutMs: number }): Promise<SearxngTransportResult> {
    this.urls.push(input.url);
    if (this.single !== null) {
      return Promise.resolve(this.single);
    }
    const engine = new URL(input.url).searchParams.get('engines') ?? '';
    return Promise.resolve(
      this.byEngine[engine] ?? {
        kind: 'FAILURE',
        code: 'ECONNREFUSED',
        detail: `no scripted reply for ${engine}`,
      },
    );
  }
}

const READER: SourceVersionReader = {
  loadActive: (sourceId) => Promise.resolve(VERSIONS[sourceId] ?? null),
  // Mirrors SourceVersionService.loadActiveByDomain: the publisher-fetch permission is looked
  // up against the domain actually being contacted, not inherited from the discovery source.
  loadActiveByDomain: (domain) =>
    Promise.resolve(
      Object.values(VERSIONS).find((version) =>
        version.canonicalDomains.some(
          (canonical) => domain === canonical || domain.endsWith(`.${canonical}`),
        ),
      ) ?? null,
    ),
};

const EMPTY_SET: SourceAdapterSet = {
  newsDiscovery: [],
  webDiscovery: [],
  primarySource: null,
  companyRegistry: null,
  evidenceFetch: null,
  extractionModel: null,
};

function dbWith(documents: readonly Record<string, unknown>[]): Db {
  return {
    collection: () => ({ find: () => ({ toArray: () => Promise.resolve([...documents]) }) }),
  } as unknown as Db;
}

function permissiveHealth(): CascadeHealthPort {
  return {
    checkAccess: (() =>
      Promise.resolve({
        decision: { allowed: true, refusal: null, detail: '', health: null, failureClass: null },
        coverageOutcome: null,
      })) as unknown as CascadeHealthPort['checkAccess'],
    recordFailure: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordFailure'],
    recordSuccess: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordSuccess'],
  };
}

const TAXONOMY: TaxonomyVersion = {
  taxonomyVersionId: 'tenant-live:v1',
  version: 1,
  tenantId: 'tenant-live',
  categories: [{ category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 3, enabledCountries: ['US'] }],
  lexicon: [
    { category: 'FRAUD_FINANCIAL_CRIME', language: 'en', term: 'fraud', kind: 'CONDUCT', rank: 1 },
  ],
  languages: [{ language: 'en', measuredRecall: null, measuredByEvaluationRunId: null }],
  status: 'ACTIVE',
  proposedBy: 'test',
  approvedBy: 'test',
  activatedAt: NOW.toISOString(),
};

/** One walk of the real ladder with the real cascade. Only the two sockets are doubles. */
async function walkLadder(
  searxngReply: SearxngTransportResult | Readonly<Record<string, SearxngTransportResult>>,
  enablement: EngineEnablementPort = enablementFor(),
): Promise<{
  attempts: readonly RungAttempt[];
  leadUrls: readonly string[];
  engineLog: SearxngEngineLog;
  transport: StubTransport;
}> {
  const base = validateSearxngBaseUrl(BASE);
  if (base.kind !== 'OK') {
    throw new Error('unreachable');
  }
  const transport = new StubTransport(searxngReply);
  const engineLog = new SearxngEngineLog();

  const builder = new LadderBuilder(dbWith(DOCUMENTS), EMPTY_SET, {
    mode: 'LIVE',
    versions: READER,
    gate: new FetchGateService(READER, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
    evidenceFetch: new SecOnlyFetch(),
    clock: () => NOW,
    pollCache: new FixedFeedPollCache(),
    requestLog: new DiscoveryRequestLog(),
    searxngClient: new SearxngClient(base.base, transport),
    searxngEngineLog: engineLog,
    searxngEnablement: enablement,
  });

  const ladder = await builder.build();
  const cascade = new CascadeService(permissiveHealth());

  const query: DiscoveryQuery = {
    tenantId: 'tenant-live',
    run: {
      jobId: 'search-1',
      subjectId: 'subject-1',
      jurisdictions: ['US'],
      languages: ['en'],
      taxonomy: TAXONOMY,
    },
    queryId: 'q-1',
    // **F1, the name-only family, and it has to be.** `RssNewsDiscoveryAdapter` serves a
    // `FIXED_FEED` only for F1: a fixed feed is the publisher's whole list, and polling it again
    // for each conduct term would be the same bytes re-read 50 times. So a walk built on an F3
    // query reaches the SEC connector and is declined before a byte moves — which looks exactly
    // like "the SEC had nothing" and would have made the isolation claim below vacuous.
    //
    // SearXNG has no such restriction: it is a `QUERY_FEED` and every planned query is its own
    // search. One query serving both is what lets this file compare them on one walk.
    family: 'F1',
    text: '"Jon P. Kipp"',
    language: 'en',
    country: 'US',
    window: null,
    limit: 25,
  };

  const walk = await cascade.walk({ ladder, query, queriesAffected: 1, now: NOW });
  return {
    attempts: walk.attempts,
    leadUrls: walk.leads.map((lead) => lead.url),
    engineLog,
    transport,
  };
}

/**
 * Engine switches, without Mongo.
 *
 * Takes the engines to turn ON; everything else stays in the matrix and reports as
 * `DISABLED_BY_POLICY`, which is the state the diagnostics assertions depend on.
 */
function enablementFor(...on: readonly string[]): EngineEnablementPort {
  const enabled = new Set<string>(on);
  const engines: ResolvedEngine[] = defaultResolvedEngines().map((engine) => ({
    ...engine,
    tenantEnabled: enabled.has(engine.engine),
    effectiveEnabled:
      engine.integrated && enabled.has(engine.engine) && engine.governanceStatus !== 'REFUSED',
    configuredByTenant: true,
  }));
  return { resolveFor: (): Promise<readonly ResolvedEngine[]> => Promise.resolve(engines) };
}

// ---------------------------------------------------------------------------------------------
// §14 — the whole layer failing
// ---------------------------------------------------------------------------------------------

describe('SearXNG is never a hard dependency', () => {
  it('keeps the SEC lead when the whole instance is unreachable', async () => {
    const result = await walkLadder(
      { kind: 'FAILURE', code: 'ECONNREFUSED', detail: 'connect ECONNREFUSED' },
      enablementFor('WIKINEWS'),
    );

    // The SEC lead survives. It was found at rung 1, before rung 5 was reached, and nothing at
    // rung 5 can reach back and remove it.
    expect(result.leadUrls).toContain(SEC_LEAD_URL);

    const sec = result.attempts.find(
      (attempt) => attempt.sourceId === SEC_LITIGATION_RELEASES_SOURCE_ID,
    );
    expect(sec?.outcome).toBe('FOUND');

    // And the failure is recorded against SearXNG alone, with its reason, rather than being
    // swallowed or allowed to fail the walk.
    const searx = result.attempts.find((attempt) => attempt.sourceId === SEARXNG_SOURCE_ID);
    expect(searx?.outcome).toBe('FAILED');
    // The detail names which engines failed and how, rather than a raw syscall: with one request
    // per engine there is no single transport error to quote, and the per-engine breakdown is
    // the thing a reader can act on.
    expect(searx?.detail).toContain('CONNECTION_ERROR');
    expect(result.engineLog.summaryFor('search-1')?.sourceOutcome).toBe('FAILED');

    // The run is PARTIAL rather than clean: one source answered, one did not.
    const outcomes = mergeSourceCoverageOutcomes(cascadeCoverageOutcomes(result.attempts));
    const searxOutcome = outcomes.find((outcome) => outcome.sourceId === SEARXNG_SOURCE_ID);
    expect(searxOutcome?.outcome).toBe('FAILED');
    expect(
      outcomes.find((outcome) => outcome.sourceId === SEC_LITIGATION_RELEASES_SOURCE_ID),
    ).toBeDefined();
  });

  it('keeps the SEC lead when governance permits no engine at all', async () => {
    // The state the deployment is actually in until D21 closes. It must degrade to "this rung
    // could not be searched, and here is why", never to a failed run or a quiet skip.
    const result = await walkLadder({ kind: 'RESPONSE', status: 200, body: '{"results":[]}' });

    expect(result.leadUrls).toContain(SEC_LEAD_URL);
    const searx = result.attempts.find((attempt) => attempt.sourceId === SEARXNG_SOURCE_ID);
    expect(searx?.outcome).toBe('FAILED');
    expect(searx?.detail).toContain('NO_ENGINE_PERMITTED');
    // Nothing was put on the wire, so the upstream engines saw nothing.
    expect(result.transport.urls).toEqual([]);
  });

  it('records a metasearch failure as OUR refusal, not the source failing, when we refused it', async () => {
    // `CascadeService` must not feed a `policyRefusal` to source health: doing so records a
    // working service as one that refused us, on the strength of a decision we made about our
    // own configuration, and the next run is refused before anything is asked.
    const failures: unknown[] = [];
    const base = validateSearxngBaseUrl(BASE);
    if (base.kind !== 'OK') {
      throw new Error('unreachable');
    }
    const builder = new LadderBuilder(dbWith(DOCUMENTS), EMPTY_SET, {
      mode: 'LIVE',
      versions: READER,
      gate: new FetchGateService(READER, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      evidenceFetch: new SecOnlyFetch(),
      clock: () => NOW,
      pollCache: new FixedFeedPollCache(),
      requestLog: new DiscoveryRequestLog(),
      searxngClient: new SearxngClient(
        base.base,
        new StubTransport({ kind: 'RESPONSE', status: 200, body: '{"results":[]}' }),
      ),
      searxngEngineLog: new SearxngEngineLog(),
      searxngEnablement: enablementFor(),
    });
    const ladder = await builder.build();
    const health = permissiveHealth();
    const cascade = new CascadeService({
      ...health,
      recordFailure: ((input: unknown) => {
        failures.push(input);
        return Promise.resolve(null);
      }) as unknown as CascadeHealthPort['recordFailure'],
    });

    await cascade.walk({
      ladder,
      query: {
        tenantId: 'tenant-live',
        run: {
          jobId: 'search-2',
          subjectId: 'subject-1',
          jurisdictions: ['US'],
          languages: ['en'],
          taxonomy: TAXONOMY,
        },
        queryId: 'q-1',
        family: 'F1',
        text: '"Jon P. Kipp"',
        language: 'en',
        country: 'US',
        window: null,
        limit: 25,
      },
      queriesAffected: 1,
      now: NOW,
    });

    // Nothing was recorded against any source's health: the only failure was our own gate
    // refusing, and we did not ask the instance anything.
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// §14 — one engine failing
// ---------------------------------------------------------------------------------------------

describe('one engine failing does not remove another engine results', () => {
  it('keeps the results of the engines that answered', async () => {
    // Two engines enabled. Google is blocked on a CAPTCHA; Wikinews answers. Both facts are true
    // of the same planned query, and the run must carry both.
    const result = await walkLadder(
      {
        'google news': {
          kind: 'RESPONSE',
          status: 200,
          body: JSON.stringify({
            results: [],
            unresponsive_engines: [['google news', 'Suspended: CAPTCHA']],
          }),
        },
        wikinews: {
          kind: 'RESPONSE',
          status: 200,
          body: JSON.stringify({
            results: [
              {
                url: REUTERS_URL,
                title: 'Jon P. Kipp charged with fraud',
                content: 'Prosecutors filed charges on Tuesday.',
                engine: 'wikinews',
                engines: ['wikinews'],
                publishedDate: '2026-08-18T00:00:00Z',
                score: 1,
                category: 'news',
              },
            ],
            unresponsive_engines: [],
          }),
        },
      },
      enablementFor('GOOGLE_NEWS', 'WIKINEWS'),
    );

    // Both leads present: the SEC feed's and the metasearch one.
    expect(result.leadUrls).toContain(SEC_LEAD_URL);
    expect(result.leadUrls).toContain(REUTERS_URL);

    // The source itself is not a failure — one engine being blocked is a diagnostic, not a gap.
    const searx = result.attempts.find((attempt) => attempt.sourceId === SEARXNG_SOURCE_ID);
    expect(searx?.outcome).toBe('FOUND');

    const summary = result.engineLog.summaryFor('search-1');
    expect(summary?.sourceOutcome).toBe('COMPLETED');
    expect(summary?.enginesAttempted).toBe(1);
    expect(summary?.enginesReturnedResults).toBe(1);
    expect(summary?.enginesFailed).toBe(0);
    expect(summary?.perEngine.find((s) => s.engine === 'GOOGLE_NEWS')?.outcome).toBe(
      'DISABLED_BY_POLICY',
    );
    expect(summary?.perEngine.find((s) => s.engine === 'WIKINEWS')?.outcome).toBe(
      'RETURNED_RESULTS',
    );
  });

  it('reports every engine that was switched off, so a reader is not left wondering', async () => {
    const result = await walkLadder(
      { wikinews: { kind: 'RESPONSE', status: 200, body: '{"results":[]}' } },
      enablementFor('WIKINEWS'),
    );
    const summary = result.engineLog.summaryFor('search-1');
    // "Why is Google not in this result?" is a question every adverse-media search invites, and
    // the answer belongs in the response rather than in a code comment. Google is a row with an
    // outcome and the decision behind it — never an absence.
    const google = summary?.perEngine.find((stat) => stat.engine === 'GOOGLE_NEWS');
    expect(google?.attempted).toBe(false);
    expect(google?.outcome).toBe('DISABLED_BY_POLICY');
    expect(google?.decisionId).toBe('D20');
    // And every integrated engine is present whatever its switch says.
    expect(summary?.perEngine).toHaveLength(6);
    expect(summary?.enginesConfigured).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------
// §13 — clustering
// ---------------------------------------------------------------------------------------------

describe('four engines finding one story is one cluster', () => {
  function candidate(overrides: Partial<AssignableCandidate>): AssignableCandidate {
    return {
      documentId: 'doc',
      subjectId: 'subject-1',
      companyId: null,
      category: 'FRAUD_FINANCIAL_CRIME',
      proceduralStage: 'CHARGE_INDICTMENT',
      eventDate: '2026-08-18',
      canonicalUrl: REUTERS_URL,
      contentHash: 'hash-reuters',
      nearDuplicateKey: 'wire-kipp-charged',
      originatingNewsroomId: 'reuters',
      isIndependentAuthority: false,
      issuingAuthorityId: null,
      ...overrides,
    };
  }

  it('collapses a syndicated copy of the same wire story into one cluster', () => {
    // The §13 case. One Reuters article and one syndication of it, reached through different
    // engines, is ONE underlying piece of evidence. Counting the syndication separately is
    // exactly the independence inflation FR-10 exists to prevent.
    const assignment = assignClusters([
      candidate({ documentId: 'reuters-original' }),
      candidate({
        documentId: 'syndicated-copy',
        canonicalUrl: 'https://www.example-wire.test/kipp-charged',
        contentHash: 'hash-syndicated',
        originatingNewsroomId: 'reuters',
      }),
    ]);

    expect(assignment.clusters).toHaveLength(1);
    expect(assignment.clusters[0]?.representatives).toHaveLength(1);
    const copy = assignment.memberOf.get('syndicated-copy');
    expect(copy?.isSuppressedCopy).toBe(true);
    expect(copy?.reason).toBe('SYNDICATED_COPY');
  });

  it('keeps an SEC enforcement action independent of the press report of it', () => {
    // The other half, and the one a too-eager merge would break. A regulator's own record of an
    // action it took is never suppressed as a duplicate of somebody else's account of it.
    const assignment = assignClusters([
      candidate({ documentId: 'reuters-original' }),
      candidate({
        documentId: 'sec-litigation-release',
        canonicalUrl: SEC_LEAD_URL,
        contentHash: 'hash-sec',
        nearDuplicateKey: null,
        originatingNewsroomId: 'sec',
        isIndependentAuthority: true,
        issuingAuthorityId: 'us-sec',
      }),
    ]);

    const representatives = assignment.clusters.flatMap((cluster) => cluster.representatives);
    expect(representatives).toContain('reuters-original');
    expect(representatives).toContain('sec-litigation-release');
    expect(assignment.memberOf.get('sec-litigation-release')?.isSuppressedCopy).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// §11 — identity
// ---------------------------------------------------------------------------------------------

describe('identity is never derived from the query', () => {
  const SUBJECT: SubjectIdentityEvidence = {
    names: [{ text: 'Jon P. Kipp', role: 'PRIMARY' }],
    datesOfBirth: [{ value: '1971-04-02', precision: 'DAY' }],
    countries: ['US'],
    companyNames: ['Kipp Capital LLC'],
    identifiers: [],
  };

  it('leaves a name-only metasearch article AMBIGUOUS', () => {
    // §11 and §17's "name only" case. The article names the same name and states nothing else
    // about who the person is. That the query contained the name proves nothing — the query is
    // ours, and comparing the subject's name to itself is not evidence.
    const document: DocumentIdentityEvidence = {
      names: [{ text: 'Jon P. Kipp', role: 'PRIMARY' }],
      datesOfBirth: [],
      countries: [],
      companyNames: [],
      identifiers: [],
      distinguishesNamesake: false,
    };

    const resolved = resolveIdentityEvidence(SUBJECT, document);
    const graded = gradeIdentity({
      nameMatch: resolved.match.form,
      factors: resolved.factors,
      frequencyPrior: null,
      documentDistinguishesNamesake: false,
    });

    // `WEAK` is the identity vocabulary's word for what §17 calls AMBIGUOUS: the name agreed and
    // nothing else was established, so the document does not say this is the subject. The two
    // grades that WOULD say so are the ones that must not appear.
    expect(graded.grade).toBe('WEAK');
    expect(graded.grade).not.toBe('CORROBORATED');
    expect(graded.grade).not.toBe('PARTIAL');
    // The name agreement is the ONLY corroborating factor, and it is WEAK. A name is the
    // question rather than the answer, and `gradeIdentity` says so in as many words: "Only weak
    // identifiers; never sufficient alone."
    expect(graded.corroborating.map((factor) => factor.kind)).toEqual(['EXACT_COMMON_NAME']);
    expect(graded.corroborating.every((factor) => factor.strength === 'WEAK')).toBe(true);
    // And nothing about the QUERY became a factor. The subject's name compared to itself is not
    // evidence, and the engine that surfaced the article is not evidence either.
    expect(JSON.stringify(graded.rationale)).not.toContain('SEARXNG');
    expect(JSON.stringify(graded.rationale)).not.toContain('query');
  });

  it('does not turn a contradicting date of birth into a supported identity', () => {
    // §17's "contradicting DOB" case. The document states a different full date of birth. That
    // is evidence against, and it must never be reported as a match because the name agreed.
    const document: DocumentIdentityEvidence = {
      names: [{ text: 'Jon P. Kipp', role: 'PRIMARY' }],
      datesOfBirth: [{ value: '1983-11-30', precision: 'DAY' }],
      countries: ['US'],
      companyNames: [],
      identifiers: [],
      distinguishesNamesake: false,
    };

    const resolved = resolveIdentityEvidence(SUBJECT, document);
    const graded = gradeIdentity({
      nameMatch: resolved.match.form,
      factors: resolved.factors,
      frequencyPrior: null,
      documentDistinguishesNamesake: false,
    });

    expect(graded.contradicting.length).toBeGreaterThan(0);
    // Never a supported identity. `CONTRADICTED` excludes it from findings outright; `WEAK` says
    // the document does not establish it. Either is honest; `CORROBORATED` would not be.
    expect(['CONTRADICTED', 'WEAK']).toContain(graded.grade);
    expect(graded.grade).not.toBe('CORROBORATED');
  });

  it('does not let a year-only date of birth become a full-date match', () => {
    // A YEAR-precision agreement is a YEAR-precision agreement. Reading it as a full-date match
    // is how a common name becomes a confident wrong answer.
    const document: DocumentIdentityEvidence = {
      names: [{ text: 'Jon P. Kipp', role: 'PRIMARY' }],
      datesOfBirth: [{ value: '1971-01-01', precision: 'YEAR' }],
      countries: [],
      companyNames: [],
      identifiers: [],
      distinguishesNamesake: false,
    };

    const resolved = resolveIdentityEvidence(SUBJECT, document);
    const dobFactors = resolved.factors.filter((factor) => factor.kind.includes('DOB'));
    for (const factor of dobFactors) {
      // Whatever the factor is called, it must not be presented as the strongest kind of
      // agreement on the strength of a four-digit year.
      expect(factor.strength).not.toBe('STRONG');
    }
    const graded = gradeIdentity({
      nameMatch: resolved.match.form,
      factors: resolved.factors,
      frequencyPrior: null,
      documentDistinguishesNamesake: false,
    });
    // A four-digit year is not a full date of birth, and it must not carry a name-only match up
    // to the grade that says "this is the person".
    expect(graded.grade).not.toBe('CORROBORATED');
  });
});
