/**
 * **A source that fails never subtracts from what another source found.**
 *
 * That is the whole of this file, and it is a regression guard rather than a design note. The
 * behaviour it protects had failed in two distinct places, and the two failures compounded into
 * the worst answer a screening product can give — a run that had found something and reported
 * that it had not:
 *
 * 1. **`sourceOutcomes` was one entry per *kind of thing that happened*, not per source.** A
 *    source that answered forty queries and was rate-limited on the forty-first appeared twice,
 *    once `COMPLETED` and once `FAILED`, and every reader had to pick one. Neither was true.
 *    `mergeSourceCoverageOutcomes` gives the third answer, `PARTIAL`, which `aggregateRun` counts
 *    as a source that answered **and** as a coverage gap.
 *
 * 2. **The findings state was computed from two bands out of six.** `supportedFindingCount`
 *    counted `CORROBORATED` and `SUPPORTED` and nothing else, so a run whose only result was an
 *    `AMBIGUOUS` finding reported `NO_MATCHES_FOUND` — while serving that finding from
 *    `/findings` the whole time. A reviewer told "no matches" does not go and look.
 *
 * The cases below are the five ways the pair could come back. They run the **real**
 * `LadderBuilder`, the **real** `CascadeService`, the real merge and the real `aggregateRun`;
 * only the socket is a test double, and it counts what each publisher would have seen.
 *
 * Nothing here opens a socket, and nothing here contacts the SEC or GDELT.
 */

import { describe, expect, it } from 'vitest';

import type { Db } from 'mongodb';

import {
  aggregateRun,
  assertNoMatchIsHonest,
  boundPlan,
  buildQueryPlan,
  cascadeCoverageOutcomes,
  mergeSourceCoverageOutcomes,
  normaliseName,
  type PlannedQuery,
  type RungAttempt,
  type SourceCoverageOutcome,
  type TaxonomyVersion,
} from '@erly/adverse-domain';

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
import { GDELT_DOC_V2_SOURCE_ID } from '../src/sources/registry/gdelt-doc-v2.js';
import { SEC_LITIGATION_RELEASES_SOURCE_ID } from '../src/sources/registry/sec-litigation-releases.js';
import { SEC_PRESS_RELEASES_SOURCE_ID } from '../src/sources/registry/sec-press-releases.js';
import type { DiscoveryQuery } from '../src/sources/lead.js';
import {
  failed,
  ok,
  type AdapterDescriptor,
  type SourceOutcome,
} from '../src/sources/source-adapter.js';
import type {
  ActiveSourceVersion,
  SourceVersionReader,
} from '../src/sources/source-version.service.js';
import type { SourceAdapterSet } from '../src/sources/sources.registry.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const CONTACT = 'https://erlystage.com/bots/adverse-search';

const SEC_LITIGATION_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss';
const SEC_PRESS_URL = 'https://www.sec.gov/news/pressreleases.rss';
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

const SEC_LEAD_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26640';

// ---------------------------------------------------------------------------------------------
// The registry, as the ladder builder reads it.
// ---------------------------------------------------------------------------------------------

function secDocument(sourceId: string, sourceName: string, url: string): Record<string, unknown> {
  return {
    sourceId,
    status: 'ACTIVE',
    version: 1,
    versionId: `${sourceId}:v1`,
    content: {
      sourceName,
      connectorType: 'NEWS_DISCOVERY_RSS',
      canonicalDomains: ['www.sec.gov'],
      countries: ['US'],
      languages: ['en'],
      robotsPosition: 'HONOURED',
      licenceTermsVersion: 'sec-fair-access-2026-09-15',
      cascadeRung: 1,
      authorityTier: 1,
      freeTierHourlyBudget: 6,
      freeTierDailyBudget: 120,
      accessPolicy: {
        endpointUrl: url,
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
    },
  };
}

const GDELT_DOCUMENT: Record<string, unknown> = {
  sourceId: GDELT_DOC_V2_SOURCE_ID,
  status: 'ACTIVE',
  version: 1,
  versionId: `${GDELT_DOC_V2_SOURCE_ID}:v1`,
  content: {
    sourceName: 'GDELT DOC 2.0 (global article index)',
    connectorType: 'NEWS_DISCOVERY_GDELT',
    canonicalDomains: ['api.gdeltproject.org'],
    countries: ['US'],
    languages: ['en'],
    // A hypothetical approved state, as in `mixed-live-sources.test.ts`. The real registry record
    // is inert, and nothing in this file activates anything.
    robotsPosition: 'HONOURED',
    licenceTermsVersion: 'gdelt-terms-test',
    cascadeRung: 3,
    authorityTier: 5,
    freeTierHourlyBudget: 24,
    freeTierDailyBudget: 200,
    accessPolicy: {
      endpointUrl: GDELT_URL,
      endpointKind: 'QUERY_FEED',
      queryParam: 'query',
      pollFloorSeconds: null,
      conditionalGet: false,
      firstContactApproval: {
        approvedBy: 'Test Approver',
        role: 'Source admin',
        approvedOn: '2026-09-18',
        decision: 'TEST',
      },
      robotsException: null,
    },
  },
};

function secVersion(sourceId: string, sourceName: string, url: string): ActiveSourceVersion {
  return {
    sourceId,
    versionId: `${sourceId}:v1`,
    version: 1,
    sourceName,
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
    endpointUrl: url,
    endpointKind: 'FIXED_FEED',
    queryParam: null,
    pollFloorMs: 15 * 60_000,
    requestCeilingPerSecond: null,
  };
}

const VERSIONS: Readonly<Record<string, ActiveSourceVersion>> = {
  [SEC_LITIGATION_RELEASES_SOURCE_ID]: secVersion(
    SEC_LITIGATION_RELEASES_SOURCE_ID,
    'SEC litigation releases (RSS)',
    SEC_LITIGATION_URL,
  ),
  [SEC_PRESS_RELEASES_SOURCE_ID]: secVersion(
    SEC_PRESS_RELEASES_SOURCE_ID,
    'SEC press releases (RSS)',
    SEC_PRESS_URL,
  ),
  [GDELT_DOC_V2_SOURCE_ID]: {
    sourceId: GDELT_DOC_V2_SOURCE_ID,
    versionId: `${GDELT_DOC_V2_SOURCE_ID}:v1`,
    version: 1,
    sourceName: 'GDELT DOC 2.0 (global article index)',
    connectorType: 'NEWS_DISCOVERY_GDELT',
    canonicalDomains: ['api.gdeltproject.org'],
    countries: ['US'],
    languages: ['en'],
    robotsPosition: 'HONOURED',
    licenceTermsVersion: 'gdelt-terms-test',
    licenceExpiresAt: null,
    cascadeRung: 3,
    authorityTier: 5,
    firstContactApproval: {
      approvedBy: 'Test Approver',
      role: 'Source admin',
      approvedOn: '2026-09-18',
      decision: 'TEST',
    },
    robotsException: null,
    endpointUrl: GDELT_URL,
    endpointKind: 'QUERY_FEED',
    queryParam: 'query',
    pollFloorMs: null,
    requestCeilingPerSecond: null,
  },
};

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

/** One litigation release naming the subject. This is the lead that must survive. */
const SEC_FEED_WITH_ITEM = [
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

/** A feed that parsed cleanly and had nothing. Not the same fact as a feed that failed. */
const SEC_FEED_EMPTY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0"><channel>',
  '<title>SEC</title><language>en-us</language>',
  '</channel></rss>',
].join('\n');

function gdeltBody(requestUrl: string): string {
  const query = new URL(requestUrl).searchParams.get('query') ?? '';
  return JSON.stringify({
    articles: [
      {
        url: `https://news.example.test/${encodeURIComponent(query).slice(0, 40)}`,
        title: `Report concerning ${query}`,
        seendate: '20260901T120000Z',
        domain: 'news.example.test',
        language: 'English',
      },
    ],
  });
}

const FETCH_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'test-fetch',
  portKind: 'EVIDENCE_FETCH',
  sourceId: 'test',
  parserVersion: 'test-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'LIVE',
  jurisdictions: [],
};

function body(url: string, text: string, contentType: string): SourceOutcome<FetchResult> {
  const bytes = new TextEncoder().encode(text);
  return ok(FETCH_DESCRIPTOR, NOW, {
    url,
    finalUrl: url,
    httpStatus: 200,
    headers: { 'content-type': contentType },
    body: bytes,
    notModified: false,
    contentType,
    bytes: bytes.byteLength,
    renderTrigger: null,
    egressIdentityId: 'egress-primary',
    fetchedAt: NOW.toISOString(),
  });
}

/** HTTP 429. `classifyFailure` turns this into `RATE_LIMITED` through the one FR-06 table. */
function rateLimited(): SourceOutcome<FetchResult> {
  return failed(
    FETCH_DESCRIPTOR,
    NOW,
    { httpStatus: 429 },
    'The publisher answered 429 and asked us to slow down.',
  );
}

/** The fetch port, scripted per host. The only socket in this file, and it is not one. */
class ScriptedFetch implements EvidenceFetchPort {
  readonly requests: FetchRequest[] = [];
  readonly descriptor = FETCH_DESCRIPTOR;

  constructor(
    private readonly script: (request: FetchRequest) => SourceOutcome<FetchResult> | null = () =>
      null,
    private readonly secFeed: string = SEC_FEED_WITH_ITEM,
  ) {}

  fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>> {
    this.requests.push(request);
    const scripted = this.script(request);
    if (scripted !== null) {
      return Promise.resolve(scripted);
    }
    if (request.url.startsWith(GDELT_URL)) {
      return Promise.resolve(body(request.url, gdeltBody(request.url), 'application/json'));
    }
    return Promise.resolve(body(request.url, this.secFeed, 'application/rss+xml'));
  }

  robotsPositionFor(): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'> {
    return Promise.resolve('ALLOWED');
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

function dbWith(documents: readonly Record<string, unknown>[]): Db {
  return {
    collection: () => ({
      find: () => ({ toArray: () => Promise.resolve([...documents]) }),
    }),
  } as unknown as Db;
}

const READER: SourceVersionReader = {
  loadActive: (sourceId) => Promise.resolve(VERSIONS[sourceId] ?? null),
};

const EMPTY_SET: SourceAdapterSet = {
  newsDiscovery: [],
  webDiscovery: [],
  primarySource: null,
  companyRegistry: null,
  evidenceFetch: null,
  extractionModel: null,
};

/** Health that permits everything. The failures under test come from the wire, not from us. */
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

function taxonomy(): TaxonomyVersion {
  return {
    taxonomyVersionId: 'tenant-live:v1',
    version: 1,
    tenantId: 'tenant-live',
    categories: [
      { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 3, enabledCountries: ['US'] },
    ],
    lexicon: [
      {
        category: 'FRAUD_FINANCIAL_CRIME',
        language: 'en',
        term: 'fraud',
        kind: 'CONDUCT',
        rank: 1,
      },
    ],
    languages: [{ language: 'en', measuredRecall: null, measuredByEvaluationRunId: null }],
    status: 'ACTIVE',
    proposedBy: 'test',
    approvedBy: 'test',
    activatedAt: NOW.toISOString(),
  };
}

function planFor(tax: TaxonomyVersion): readonly PlannedQuery[] {
  const plan = buildQueryPlan({
    subjectName: 'Jon P. Kipp',
    normalisedName: normaliseName('Jon P. Kipp'),
    aliases: [],
    jurisdictions: ['US'],
    languages: ['en'],
    taxonomy: tax,
    anchorCompanies: [],
    queryIdPrefix: 'run',
  });
  return boundPlan(plan, 200).kept;
}

interface DiscoveryResult {
  readonly attempts: readonly RungAttempt[];
  /** What the run stores and `/findings` serves — one entry per source, after the merge. */
  readonly sourceOutcomes: readonly SourceCoverageOutcome[];
  /** Distinct discovered leads, deduplicated as the pipeline deduplicates them. */
  readonly leadUrls: readonly string[];
}

/**
 * Discovery for one search, run exactly as `SearchPipeline.discover` runs it — the same builder,
 * the same cascade, the same merge. A test that reimplemented any of the three would prove that
 * the reimplementation is correct.
 */
async function discover(input: {
  readonly queries: readonly PlannedQuery[];
  readonly taxonomy: TaxonomyVersion;
  readonly fetch: ScriptedFetch;
}): Promise<DiscoveryResult> {
  const documents = [
    secDocument(
      SEC_LITIGATION_RELEASES_SOURCE_ID,
      'SEC litigation releases (RSS)',
      SEC_LITIGATION_URL,
    ),
    secDocument(SEC_PRESS_RELEASES_SOURCE_ID, 'SEC press releases (RSS)', SEC_PRESS_URL),
    GDELT_DOCUMENT,
  ];

  const builder = new LadderBuilder(dbWith(documents), EMPTY_SET, {
    mode: 'LIVE',
    versions: READER,
    gate: new FetchGateService(READER, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
    evidenceFetch: input.fetch,
    clock: () => NOW,
    pollCache: new FixedFeedPollCache(),
    requestLog: new DiscoveryRequestLog(),
  });
  const ladder = await builder.build();
  const cascade = new CascadeService(permissiveHealth());

  const attempts: RungAttempt[] = [];
  const leadUrls = new Set<string>();

  for (const [index, query] of input.queries.entries()) {
    const discoveryQuery: DiscoveryQuery = {
      tenantId: 'tenant-live',
      run: {
        jobId: 'search-1',
        subjectId: 'subject-1',
        jurisdictions: ['US'],
        languages: ['en'],
        taxonomy: input.taxonomy,
      },
      queryId: query.queryId,
      family: query.family,
      text: query.query,
      language: query.language,
      country: query.jurisdiction,
      window: null,
      limit: 25,
    };
    const walk = await cascade.walk({
      ladder,
      query: discoveryQuery,
      queriesAffected: input.queries.length - index,
      now: NOW,
    });
    attempts.push(...walk.attempts);
    for (const lead of walk.leads) {
      leadUrls.add(lead.url);
    }
  }

  return {
    attempts,
    sourceOutcomes: mergeSourceCoverageOutcomes(cascadeCoverageOutcomes(attempts)),
    leadUrls: [...leadUrls],
  };
}

function outcomeFor(result: DiscoveryResult, sourceId: string): SourceCoverageOutcome | undefined {
  return result.sourceOutcomes.find((outcome) => outcome.sourceId === sourceId);
}

/** The aggregate for a run that produced these findings, by band, over these outcomes. */
function aggregateWith(input: {
  readonly result: DiscoveryResult;
  readonly confirmed?: number;
  readonly ambiguous?: number;
  readonly other?: number;
  readonly unresolvedLeads?: number;
}): ReturnType<typeof aggregateRun> {
  return aggregateRun({
    cancelled: false,
    supportedFindingCount: input.confirmed ?? 0,
    ambiguousFindingCount: input.ambiguous ?? 0,
    otherFindingCount: input.other ?? 0,
    unresolvedLeadCount: input.unresolvedLeads ?? 0,
    sourceOutcomes: input.result.sourceOutcomes,
    anyWorkDispatched: input.result.sourceOutcomes.length > 0,
    unmeasuredLanguages: [],
  });
}

// ---------------------------------------------------------------------------------------------
// 1. A succeeds with a finding, B is rate-limited.
// ---------------------------------------------------------------------------------------------

describe('a rate-limited source never discards a finding from a source that answered', () => {
  it('keeps the SEC lead when GDELT answers 429 on every query', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch((request) =>
      request.url.startsWith(GDELT_URL) ? rateLimited() : null,
    );

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    // The acceptance criterion, stated as an assertion: the responding source's material is here.
    expect(result.leadUrls).toContain(SEC_LEAD_URL);

    expect(outcomeFor(result, SEC_LITIGATION_RELEASES_SOURCE_ID)?.outcome).toBe('COMPLETED');

    const gdelt = outcomeFor(result, GDELT_DOC_V2_SOURCE_ID);
    expect(gdelt?.outcome).toBe('FAILED');
    expect(gdelt?.failureClass).toBe('RATE_LIMITED');

    // One finding came out of that lead. The run is partial and the finding is reported.
    const aggregate = aggregateWith({ result, confirmed: 1 });
    expect(aggregate.execution).toBe('PARTIAL');
    expect(aggregate.coverage).toBe('INCOMPLETE');
    expect(aggregate.findings).toBe('CONFIRMED_MATCHES_FOUND');
    expect(aggregate.findingCounts.total).toBe(1);
  });

  it('reports the rate limit as a failure and never as an empty answer', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch((request) =>
      request.url.startsWith(GDELT_URL) ? rateLimited() : null,
    );

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    // "We could not read it" and "we read it and it said nothing" never merge (D-046).
    expect(
      result.attempts.some(
        (attempt) => attempt.sourceId === GDELT_DOC_V2_SOURCE_ID && attempt.outcome === 'EMPTY',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. A succeeds with zero findings, B fails.
// ---------------------------------------------------------------------------------------------

describe('a source answering emptily beside one that failed is a partial run, not a failed one', () => {
  it('is PARTIAL / INCOMPLETE without claiming the working source failed', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch(
      (request) => (request.url.startsWith(GDELT_URL) ? rateLimited() : null),
      // The SEC feed parses and holds nothing. A real answer, and a different fact from a failure.
      SEC_FEED_EMPTY,
    );

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    expect(outcomeFor(result, SEC_LITIGATION_RELEASES_SOURCE_ID)?.outcome).toBe('COMPLETED');
    expect(outcomeFor(result, SEC_PRESS_RELEASES_SOURCE_ID)?.outcome).toBe('COMPLETED');
    expect(outcomeFor(result, GDELT_DOC_V2_SOURCE_ID)?.outcome).toBe('FAILED');

    const aggregate = aggregateWith({ result });
    expect(aggregate.execution).toBe('PARTIAL');
    expect(aggregate.coverage).toBe('INCOMPLETE');
    // Zero findings and zero leads really is a no-match here — but only because the SEC answered.
    expect(aggregate.findings).toBe('NO_MATCHES_FOUND');
    // **Not** `FAILED` / `NOT_EVALUATED`: one publisher failing is not every publisher failing.
    expect(aggregate.execution).not.toBe('FAILED');
    expect(aggregate.findings).not.toBe('NOT_EVALUATED');
  });

  it('still fails the run when every source failed, and never calls that a clean result (T47)', async () => {
    const tax = taxonomy();
    // Everything 429s. This is the case that must **not** be softened by the changes above.
    //
    // The plan is narrowed to **F1** deliberately. A fixed feed answers `noResults` for every
    // family but F1 without opening a socket — a real answer, and one the merge correctly counts
    // as the source having been consulted. Leaving those queries in would make even a totally
    // unreachable SEC come out `PARTIAL`, and the run under test here is the one where *nothing*
    // answered.
    const queries = planFor(tax).filter((query) => query.family === 'F1');
    expect(queries.length).toBeGreaterThan(0);
    const fetch = new ScriptedFetch(() => rateLimited());

    const result = await discover({ queries, taxonomy: tax, fetch });

    expect(
      result.sourceOutcomes
        .filter((outcome) => !outcome.sourceId.startsWith('cascade-rung-'))
        .every((outcome) => outcome.outcome === 'FAILED'),
    ).toBe(true);

    const aggregate = aggregateWith({ result });
    expect(aggregate.execution).toBe('FAILED');
    expect(aggregate.findings).toBe('NOT_EVALUATED');
    expect(aggregate.findings).not.toBe('NO_MATCHES_FOUND');
  });

  it('is PARTIAL, not FAILED, when a fixed feed is unreachable but still answers other families', async () => {
    // The distinction the case above is narrowed to avoid, asserted in its own right: a fixed
    // feed that cannot be polled still answers `noResults` for every family but F1, so the run
    // has been told something by that source and `PARTIAL` is the honest execution state.
    const tax = taxonomy();
    const fetch = new ScriptedFetch(() => rateLimited());

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });
    const sec = outcomeFor(result, SEC_LITIGATION_RELEASES_SOURCE_ID);

    expect(sec?.outcome).toBe('PARTIAL');
    expect(sec?.failureClass).toBe('RATE_LIMITED');
    expect(aggregateWith({ result }).execution).toBe('PARTIAL');
  });
});

// ---------------------------------------------------------------------------------------------
// 3. An ambiguous finding exists.
// ---------------------------------------------------------------------------------------------

describe('an ambiguous finding is never reported as no match', () => {
  it('reports AMBIGUOUS_MATCHES_FOUND when the only finding is AMBIGUOUS', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch((request) =>
      request.url.startsWith(GDELT_URL) ? rateLimited() : null,
    );
    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    const aggregate = aggregateWith({ result, ambiguous: 1 });

    expect(aggregate.findings).toBe('AMBIGUOUS_MATCHES_FOUND');
    expect(aggregate.findings).not.toBe('NO_MATCHES_FOUND');
    expect(aggregate.findingCounts).toMatchObject({ confirmed: 0, ambiguous: 1, total: 1 });
    // The run still says what it missed. Reporting the finding does not erase the gap.
    expect(aggregate.coverage).toBe('INCOMPLETE');
  });

  it('never produces NO_MATCHES_FOUND over any non-empty finding list, in any band', () => {
    // Every band group, one at a time, with no source outcomes at all — the harshest input there
    // is, because it removes the other evidence that anything answered.
    const cases = [
      { label: 'confirmed', confirmed: 1, ambiguous: 0, other: 0 },
      { label: 'ambiguous', confirmed: 0, ambiguous: 1, other: 0 },
      { label: 'other', confirmed: 0, ambiguous: 0, other: 1 },
    ] as const;

    for (const testCase of cases) {
      const aggregate = aggregateRun({
        cancelled: false,
        supportedFindingCount: testCase.confirmed,
        ambiguousFindingCount: testCase.ambiguous,
        otherFindingCount: testCase.other,
        unresolvedLeadCount: 0,
        sourceOutcomes: [],
        anyWorkDispatched: true,
      });
      expect(aggregate.findings, testCase.label).not.toBe('NO_MATCHES_FOUND');
      expect(
        assertNoMatchIsHonest({ findings: aggregate.findings, counts: aggregate.findingCounts }),
        testCase.label,
      ).toBeNull();
    }
  });

  it('catches the contradiction if anything ever writes the pair', () => {
    // The guard the read path runs before serving a page. It exists because this pair is the one
    // inconsistency a reviewer acts on by not looking.
    const violation = assertNoMatchIsHonest({
      findings: 'NO_MATCHES_FOUND',
      counts: { confirmed: 0, ambiguous: 1, other: 0, total: 1, unresolvedLeads: 0 },
    });
    expect(violation).not.toBeNull();
    expect(violation).toContain('NO_MATCHES_FOUND');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Several successful sources, one failure.
// ---------------------------------------------------------------------------------------------

describe('every successful source keeps its findings when one source fails', () => {
  it('retains both SEC feeds while GDELT is rate-limited', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch((request) =>
      request.url.startsWith(GDELT_URL) ? rateLimited() : null,
    );

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    const completed = result.sourceOutcomes
      .filter((outcome) => outcome.outcome === 'COMPLETED')
      .map((outcome) => outcome.sourceId);
    expect(completed).toContain(SEC_LITIGATION_RELEASES_SOURCE_ID);
    expect(completed).toContain(SEC_PRESS_RELEASES_SOURCE_ID);

    // Both publishers were actually addressed. The failure did not stop the walk.
    const asked = new Set(result.attempts.map((attempt) => attempt.sourceId));
    expect(asked.has(SEC_LITIGATION_RELEASES_SOURCE_ID)).toBe(true);
    expect(asked.has(GDELT_DOC_V2_SOURCE_ID)).toBe(true);

    const aggregate = aggregateWith({ result, confirmed: 2, ambiguous: 1 });
    expect(aggregate.findingCounts.total).toBe(3);
    expect(aggregate.findings).toBe('CONFIRMED_MATCHES_FOUND');
    expect(aggregate.execution).toBe('PARTIAL');
  });

  it('reports a source that answered some queries and failed others as PARTIAL, not as failed', async () => {
    const tax = taxonomy();
    let gdeltCalls = 0;
    // GDELT answers the first query and is rate-limited from then on — the shape that used to
    // produce two entries for one source and force every reader to guess which one was true.
    const fetch = new ScriptedFetch((request) => {
      if (!request.url.startsWith(GDELT_URL)) {
        return null;
      }
      gdeltCalls += 1;
      return gdeltCalls === 1 ? null : rateLimited();
    });

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    const gdeltEntries = result.sourceOutcomes.filter(
      (outcome) => outcome.sourceId === GDELT_DOC_V2_SOURCE_ID,
    );
    expect(gdeltEntries).toHaveLength(1);
    expect(gdeltEntries[0]?.outcome).toBe('PARTIAL');
    expect(gdeltEntries[0]?.failureClass).toBe('RATE_LIMITED');

    const aggregate = aggregateWith({ result, confirmed: 1 });
    // PARTIAL is counted as a source that answered **and** as a coverage gap. Both, deliberately.
    expect(aggregate.execution).toBe('PARTIAL');
    expect(aggregate.coverage).toBe('INCOMPLETE');
    expect(aggregate.failedSources.map((s) => s.sourceId)).toContain(GDELT_DOC_V2_SOURCE_ID);
    expect(aggregate.findings).toBe('CONFIRMED_MATCHES_FOUND');
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The failed source's reason, and the successful sources' provenance.
// ---------------------------------------------------------------------------------------------

describe('a failed source carries its reason and contaminates nothing', () => {
  it('names the reason and the FR-06 class on the failed source only', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch((request) =>
      request.url.startsWith(GDELT_URL) ? rateLimited() : null,
    );

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    const gdelt = outcomeFor(result, GDELT_DOC_V2_SOURCE_ID);
    expect(gdelt?.failureClass).toBe('RATE_LIMITED');
    expect(gdelt?.detail ?? '').not.toBe('');

    for (const sourceId of [SEC_LITIGATION_RELEASES_SOURCE_ID, SEC_PRESS_RELEASES_SOURCE_ID]) {
      const sec = outcomeFor(result, sourceId);
      expect(sec?.outcome).toBe('COMPLETED');
      // The failure's class must not spread to a publisher that did nothing wrong. Recording one
      // against a working source is how a healthy publisher gets refused on the next run.
      expect(sec?.failureClass ?? null).toBeNull();
      expect(sec?.truncation).toBeNull();
    }
  });

  it('keeps the succeeding source on every lead it produced', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch((request) =>
      request.url.startsWith(GDELT_URL) ? rateLimited() : null,
    );

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    // Provenance is per lead, and no lead may be attributed to the source that never answered.
    expect(result.leadUrls.length).toBeGreaterThan(0);
    expect(result.leadUrls.every((url) => url.startsWith('https://www.sec.gov/'))).toBe(true);
  });

  it('puts the failed source in sourceOutcomes rather than omitting it', async () => {
    const tax = taxonomy();
    const fetch = new ScriptedFetch((request) =>
      request.url.startsWith(GDELT_URL) ? rateLimited() : null,
    );

    const result = await discover({ queries: planFor(tax), taxonomy: tax, fetch });

    // A run that quietly consulted one fewer source reads to a reviewer as a clean result from a
    // search that was never made.
    expect(result.sourceOutcomes.map((outcome) => outcome.sourceId)).toContain(
      GDELT_DOC_V2_SOURCE_ID,
    );
  });
});
