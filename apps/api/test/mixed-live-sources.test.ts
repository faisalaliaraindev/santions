/**
 * Two source shapes on one ladder — SEC `FIXED_FEED` and GDELT `QUERY_FEED`.
 *
 * `fixed-feed-amplification.test.ts` proves a fixed feed costs one request however large the
 * plan is. That is half of a rule, and on its own it is the half that can be satisfied by a bug:
 * a connector that made **one** request for every source would pass it and would be wrong about
 * every query feed on the ladder. This file is the other half.
 *
 * The properties asserted here, in the order a request travels:
 *
 * 1. **Planning reaches the wire.** F2, F3 and F4 are not merely generated — each produces a
 *    distinct outbound GDELT request carrying its own text in the recorded query parameter.
 * 2. **The two shapes cost different things.** One plan, one run: the SEC feeds are polled once
 *    each; GDELT is requested once per eligible planned query.
 * 3. **Nothing collapses a query feed.** Distinct planned queries produce distinct URLs. The
 *    poll cache is handed to the same process and must not touch them.
 * 4. **The budget bounds the fan-out.** A query feed stops at its recorded hourly budget, and
 *    the queries after it are recorded refusals rather than silent omissions.
 * 5. **Domains are isolated.** `sec.gov` failing does not stop `api.gdeltproject.org`, and the
 *    reverse. The cascade walks every rung, so a failure at rung 1 is a gap at rung 1.
 * 6. **The counts are observable.** `DiscoveryRequestLog` reports what a reader of the findings
 *    response will see, so Folder 15 asserts a number rather than a belief.
 *
 * **Nothing here opens a socket.** The fetch port is injected and counts what it was asked for,
 * which is exactly the quantity each publisher would see.
 */

import { describe, expect, it } from 'vitest';

import type { Db } from 'mongodb';

import {
  boundPlan,
  buildQueryPlan,
  normaliseName,
  type PlannedQuery,
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

/** The hourly budget the GDELT proposal records, and therefore the fan-out ceiling. */
const GDELT_HOURLY_BUDGET = 24;

// ---------------------------------------------------------------------------------------------
// The three approved versions, as the registry holds them — nested under `content`.
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
    // A hypothetical approved state. The real record is inert — no first-contact approval and no
    // robots position — and this file says so in `the proposal stays inert` below.
    robotsPosition: 'HONOURED',
    licenceTermsVersion: 'gdelt-terms-test',
    cascadeRung: 3,
    authorityTier: 5,
    freeTierHourlyBudget: GDELT_HOURLY_BUDGET,
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
    },
  },
};

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
    endpointUrl: GDELT_URL,
    endpointKind: 'QUERY_FEED',
    queryParam: 'query',
    pollFloorMs: null,
    requestCeilingPerSecond: null,
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
    endpointUrl: url,
    endpointKind: 'FIXED_FEED',
    queryParam: null,
    pollFloorMs: 15 * 60_000,
    requestCeilingPerSecond: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SEC</title>
    <language>en-us</language>
    <item>
      <title>SEC Charges Jon P. Kipp With Fraud</title>
      <link>https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26640</link>
      <description>The Commission filed a complaint.</description>
      <pubDate>Mon, 18 Aug 2026 14:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

/** One article per response, at a URL derived from the request, so leads stay distinguishable. */
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

/**
 * The fetch port, counting every request by URL and by host.
 *
 * The only number that matters: it is what each publisher's own log would show.
 */
class CountingFetch implements EvidenceFetchPort {
  readonly requests: FetchRequest[] = [];
  readonly descriptor = FETCH_DESCRIPTOR;

  constructor(
    private readonly script: (request: FetchRequest) => SourceOutcome<FetchResult> | null = () =>
      null,
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
    return Promise.resolve(body(request.url, FEED, 'application/rss+xml'));
  }

  robotsPositionFor(): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'> {
    return Promise.resolve('ALLOWED');
  }

  /** Requests whose URL begins with this prefix — a query feed's URLs differ per query. */
  countStartingWith(prefix: string): number {
    return this.requests.filter((request) => request.url.startsWith(prefix)).length;
  }

  distinctStartingWith(prefix: string): number {
    return new Set(this.requests.filter((r) => r.url.startsWith(prefix)).map((r) => r.url)).size;
  }

  hostsSeen(): readonly string[] {
    return [...new Set(this.requests.map((r) => new URL(r.url).host))].toSorted();
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

interface HealthOptions {
  /** Sources whose breaker is open for this run. Every query to them is refused. */
  readonly refuse?: readonly string[];
  /** Per-source hourly budgets. A source reaching its budget is refused thereafter. */
  readonly budgets?: Readonly<Record<string, number>>;
  /** The fetch port whose request count stands in for budget spend. */
  readonly spentBy?: CountingFetch;
}

/**
 * Health that models the two refusals the cascade actually meets: an open breaker and a spent
 * budget.
 *
 * Budget spend is read from the fetch port rather than counted here, which mirrors production:
 * `HttpEvidenceFetchAdapter` spends once per request it issues, and the cascade's own check is
 * non-spending (**D-035**). Counting in both places is the drift that bug guards against.
 */
function health(options: HealthOptions = {}): CascadeHealthPort & {
  readonly refusals: { sourceId: string; reason: string }[];
} {
  const refusals: { sourceId: string; reason: string }[] = [];
  const refuse = new Set(options.refuse ?? []);
  return {
    refusals,
    checkAccess: ((input: { sourceId: string }) => {
      if (refuse.has(input.sourceId)) {
        refusals.push({ sourceId: input.sourceId, reason: 'BREAKER_OPEN' });
        return Promise.resolve({
          decision: {
            allowed: false,
            refusal: 'BREAKER_OPEN',
            detail: `${input.sourceId}: the circuit breaker is open.`,
            health: null,
          },
          coverageOutcome: null,
        });
      }
      const budget = options.budgets?.[input.sourceId];
      if (budget !== undefined && options.spentBy !== undefined) {
        const spent = options.spentBy.requests.filter(
          (request) => request.attribution.sourceId === input.sourceId,
        ).length;
        if (spent >= budget) {
          refusals.push({ sourceId: input.sourceId, reason: 'HOURLY_BUDGET_EXHAUSTED' });
          return Promise.resolve({
            decision: {
              allowed: false,
              refusal: 'HOURLY_BUDGET_EXHAUSTED',
              detail: `The hourly free-tier budget of ${String(budget)} call(s) is spent.`,
              health: null,
            },
            coverageOutcome: null,
          });
        }
      }
      return Promise.resolve({
        decision: { allowed: true, refusal: null, detail: '', health: null },
        coverageOutcome: null,
      });
    }) as unknown as CascadeHealthPort['checkAccess'],
    recordFailure: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordFailure'],
    recordSuccess: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordSuccess'],
  };
}

/** A taxonomy the size of a live tenant's, so the counts under test are a real run's counts. */
function largeTaxonomy(): TaxonomyVersion {
  const categories = [
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
  ] as const;

  return {
    taxonomyVersionId: 'tenant-live:v1',
    version: 1,
    tenantId: 'tenant-live',
    categories: categories.map((category) => ({
      category,
      severityWeight: 3,
      enabledCountries: ['US'],
    })),
    lexicon: categories.flatMap((category) =>
      [1, 2, 3].map((rank) => ({
        category,
        language: 'en' as const,
        term: `${category.toLowerCase()}-term-${String(rank)}`,
        kind: 'CONDUCT' as const,
        rank,
      })),
    ),
    languages: [{ language: 'en', measuredRecall: null, measuredByEvaluationRunId: null }],
    status: 'ACTIVE',
    proposedBy: 'test',
    approvedBy: 'test',
    activatedAt: NOW.toISOString(),
  };
}

/**
 * The plan a live run produces, bounded exactly as the pipeline bounds it.
 *
 * `anchorCompanies` is supplied so **F2** is generated. FR-02 anchors F2 and F6 on a resolved
 * company, so a plan built without one has no F2 at all — and a test that proved F3 and F4 reach
 * the wire while quietly omitting F2 would be proving two thirds of the requirement.
 */
function planFor(
  taxonomy: TaxonomyVersion,
  options: { readonly aliases?: readonly string[]; readonly companies?: boolean } = {},
): readonly PlannedQuery[] {
  const plan = buildQueryPlan({
    subjectName: 'Jon P. Kipp',
    normalisedName: normaliseName('Jon P. Kipp'),
    aliases: options.aliases ?? [],
    jurisdictions: ['US'],
    languages: ['en'],
    taxonomy,
    anchorCompanies:
      options.companies === true
        ? [{ companyRef: 'GB-01234567', name: 'Kipp Holdings Ltd', role: 'DIRECTOR' }]
        : [],
    queryIdPrefix: 'run',
  });
  return boundPlan(plan, 200).kept;
}

interface RunResult {
  readonly fetch: CountingFetch;
  readonly log: DiscoveryRequestLog;
  readonly attempts: readonly { sourceId: string | null; outcome: string }[];
}

/**
 * One search, run exactly as `SearchPipelineService.discover` runs it.
 *
 * The poll cache is supplied on **every** run, deliberately: the regression this file guards is
 * that a process holding one does not let it touch a query feed.
 */
async function runOneSearch(input: {
  readonly queries: readonly PlannedQuery[];
  readonly taxonomy: TaxonomyVersion;
  readonly documents?: readonly Record<string, unknown>[];
  readonly fetch?: CountingFetch;
  readonly log?: DiscoveryRequestLog;
  readonly cache?: FixedFeedPollCache;
  readonly health?: CascadeHealthPort;
  readonly jobId?: string;
  readonly now?: Date;
}): Promise<RunResult> {
  const fetch = input.fetch ?? new CountingFetch();
  const log = input.log ?? new DiscoveryRequestLog();
  const now = input.now ?? NOW;
  const documents = input.documents ?? [
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
    evidenceFetch: fetch,
    clock: () => now,
    pollCache: input.cache ?? new FixedFeedPollCache(),
    requestLog: log,
  });
  const ladder = await builder.build();
  const cascade = new CascadeService(input.health ?? health());
  const attempts: { sourceId: string | null; outcome: string }[] = [];

  for (const [index, query] of input.queries.entries()) {
    const discovery: DiscoveryQuery = {
      tenantId: 'tenant-live',
      run: {
        jobId: input.jobId ?? 'search-1',
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
      query: discovery,
      queriesAffected: input.queries.length - index,
      now,
    });
    for (const attempt of walk.attempts) {
      attempts.push({ sourceId: attempt.sourceId, outcome: attempt.outcome });
    }
  }

  return { fetch, log, attempts };
}

/** The families GDELT was actually asked for, read off the URLs the fetch port saw. */
function gdeltQueriesSent(fetch: CountingFetch): readonly string[] {
  return fetch.requests
    .filter((request) => request.url.startsWith(GDELT_URL))
    .map((request) => new URL(request.url).searchParams.get('query') ?? '');
}

// ---------------------------------------------------------------------------------------------

describe('the two source shapes cost different things in one run', () => {
  it('polls each SEC feed once and requests GDELT once per planned query', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, { companies: true });
    expect(queries.length).toBeGreaterThanOrEqual(40);

    const { fetch } = await runOneSearch({
      queries,
      taxonomy,
      health: health({ budgets: { [GDELT_DOC_V2_SOURCE_ID]: 1_000 } }),
    });

    // FIXED_FEED: one poll each, whatever the plan's size.
    expect(fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(1);
    expect(fetch.countStartingWith(SEC_PRESS_URL)).toBe(1);

    // QUERY_FEED: one request per planned query. Not one, and not one per rung.
    expect(fetch.countStartingWith(GDELT_URL)).toBe(queries.length);
  });

  it('does not multiply the SEC feeds by the number of GDELT queries', async () => {
    // The failure this guards is a fixed feed being re-polled because a query feed beside it
    // made the run look busy. The SEC count must be a function of the poll floor alone.
    const taxonomy = largeTaxonomy();
    const small = planFor(taxonomy).slice(0, 5);
    const large = planFor(taxonomy);

    const first = await runOneSearch({ queries: small, taxonomy, jobId: 'job-small' });
    const second = await runOneSearch({ queries: large, taxonomy, jobId: 'job-large' });

    expect(first.fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(1);
    expect(second.fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(1);
    expect(second.fetch.countStartingWith(GDELT_URL)).toBeGreaterThan(
      first.fetch.countStartingWith(GDELT_URL),
    );
  });

  it('addresses two distinct publishers in one run', async () => {
    const taxonomy = largeTaxonomy();
    const { fetch } = await runOneSearch({ queries: planFor(taxonomy).slice(0, 4), taxonomy });
    expect(fetch.hostsSeen()).toEqual(['api.gdeltproject.org', 'www.sec.gov']);
  });
});

describe('F2, F3 and F4 genuinely reach the GDELT wire', () => {
  it('sends a distinct request carrying each family’s own query text', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, { companies: true });

    // The plan really does contain all four families. Without this the assertions below could
    // pass vacuously against a plan that never generated F2.
    const planned = new Set(queries.map((query) => query.family));
    expect(planned.has('F1')).toBe(true);
    expect(planned.has('F2')).toBe(true);
    expect(planned.has('F3')).toBe(true);
    expect(planned.has('F4')).toBe(true);

    const { fetch, log } = await runOneSearch({
      queries,
      taxonomy,
      health: health({ budgets: { [GDELT_DOC_V2_SOURCE_ID]: 1_000 } }),
    });

    const sent = gdeltQueriesSent(fetch);
    for (const family of ['F1', 'F2', 'F3', 'F4'] as const) {
      const expected = queries.filter((query) => query.family === family);
      expect(expected.length, family).toBeGreaterThan(0);
      for (const query of expected) {
        // Not "a request was made for this family" but "this exact planned text was serialised
        // into the recorded query parameter". That is the whole trace, end to end.
        expect(sent, `${family} ${query.query}`).toContain(query.query);
      }
    }

    // And the same fact as the response will state it, so Folder 15 asserts a number.
    const gdelt = log
      .summaryFor('search-1')
      .sources.find((source) => source.sourceId === GDELT_DOC_V2_SOURCE_ID);
    expect(gdelt?.familiesRequested).toEqual(['F1', 'F2', 'F3', 'F4', 'F6']);
  });

  it('sets the query on the parameter the registry records, never by string splicing', async () => {
    const taxonomy = largeTaxonomy();
    const { fetch } = await runOneSearch({ queries: planFor(taxonomy).slice(0, 3), taxonomy });

    const urls = fetch.requests
      .filter((request) => request.url.startsWith(GDELT_URL))
      .map((request) => new URL(request.url));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.host).toBe('api.gdeltproject.org');
      expect(url.pathname).toBe('/api/v2/doc/doc');
      expect(url.searchParams.get('query')).not.toBeNull();
      // Forced by the connector after the query, so a recorded endpoint cannot override them.
      expect(url.searchParams.get('mode')).toBe('artlist');
      expect(url.searchParams.get('format')).toBe('json');
    }
  });

  it('never sends a query-feed parameter to the fixed feeds', async () => {
    // The other half of the same rule. A fixed feed that grew a `query` parameter would be
    // asking the SEC a question it does not answer, once per planned query.
    const taxonomy = largeTaxonomy();
    const { fetch } = await runOneSearch({ queries: planFor(taxonomy), taxonomy });

    for (const request of fetch.requests.filter((r) => r.url.includes('sec.gov'))) {
      expect(new URL(request.url).search).toBe('');
    }
  });
});

describe('the poll cache never collapses a query feed', () => {
  it('produces one distinct URL per planned query even with a poll cache in the process', async () => {
    // The regression. `FixedFeedPollCache` is keyed on URL and is handed to every connector the
    // builder makes. If a query feed were ever routed through it — or if the query were dropped
    // from the URL — every planned query would become one network operation and the run would
    // report a full search it never made.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, { companies: true });
    const cache = new FixedFeedPollCache();

    const { fetch, log } = await runOneSearch({
      queries,
      taxonomy,
      cache,
      health: health({ budgets: { [GDELT_DOC_V2_SOURCE_ID]: 1_000 } }),
    });

    expect(fetch.distinctStartingWith(GDELT_URL)).toBe(queries.length);
    expect(cache.statsFor(GDELT_URL).requests).toBe(0);
    expect(cache.statsFor(SEC_LITIGATION_URL).requests).toBe(1);

    const gdelt = log
      .summaryFor('search-1')
      .sources.find((source) => source.sourceId === GDELT_DOC_V2_SOURCE_ID);
    expect(gdelt?.distinctEndpoints).toBe(queries.length);
    expect(gdelt?.servedWithoutRequest).toBe(0);
  });

  it('still collapses the fixed feeds in the same run', async () => {
    // Both halves at once, because a fix that separated them by disabling the cache entirely
    // would pass the test above and re-introduce the amplification this project already fixed.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, { aliases: ['Jonathan Kipp', 'J. Kipp'] });
    const { fetch, log } = await runOneSearch({ queries, taxonomy });

    expect(fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(1);
    const summary = log.summaryFor('search-1');
    const sec = summary.sources.find(
      (source) => source.sourceId === SEC_LITIGATION_RELEASES_SOURCE_ID,
    );
    expect(sec?.endpointKind).toBe('FIXED_FEED');
    expect(sec?.requestsIssued).toBe(1);
    expect(sec?.distinctEndpoints).toBe(1);
    // F1 is the only family a fixed feed answers, and there are three name forms.
    expect(sec?.queriesOffered).toBe(3);
    expect(sec?.servedWithoutRequest).toBe(2);
  });

  it('does not re-poll the SEC feeds when a second search runs inside the poll floor', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy).slice(0, 6);
    const fetch = new CountingFetch();
    const cache = new FixedFeedPollCache();

    await runOneSearch({ queries, taxonomy, fetch, cache, jobId: 'job-1' });
    await runOneSearch({ queries, taxonomy, fetch, cache, jobId: 'job-2' });

    expect(fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(1);
    // And the query feed is unaffected by the floor: both runs asked their own questions.
    expect(fetch.countStartingWith(GDELT_URL)).toBe(queries.length * 2);
  });
});

describe('the budget bounds a query feed’s fan-out', () => {
  it('stops at the recorded hourly budget rather than running the whole plan', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, { companies: true });
    expect(queries.length).toBeGreaterThan(GDELT_HOURLY_BUDGET);

    const fetch = new CountingFetch();
    const port = health({
      budgets: { [GDELT_DOC_V2_SOURCE_ID]: GDELT_HOURLY_BUDGET },
      spentBy: fetch,
    });

    const { attempts } = await runOneSearch({ queries, taxonomy, fetch, health: port });

    expect(fetch.countStartingWith(GDELT_URL)).toBe(GDELT_HOURLY_BUDGET);
    // The queries after the budget are recorded refusals, not silent omissions. That is what
    // turns an exhausted budget into an honest PARTIAL rather than a clean-looking result.
    const refused = attempts.filter(
      (attempt) => attempt.sourceId === GDELT_DOC_V2_SOURCE_ID && attempt.outcome === 'REFUSED',
    );
    expect(refused.length).toBe(queries.length - GDELT_HOURLY_BUDGET);
    expect(port.refusals.every((refusal) => refusal.reason === 'HOURLY_BUDGET_EXHAUSTED')).toBe(
      true,
    );
  });

  it('leaves the fixed feeds untouched when the query feed’s budget is spent', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy);
    const fetch = new CountingFetch();

    await runOneSearch({
      queries,
      taxonomy,
      fetch,
      health: health({ budgets: { [GDELT_DOC_V2_SOURCE_ID]: 2 }, spentBy: fetch }),
    });

    expect(fetch.countStartingWith(GDELT_URL)).toBe(2);
    expect(fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(1);
    expect(fetch.countStartingWith(SEC_PRESS_URL)).toBe(1);
  });

  it('never exceeds the budget however many queries are planned', async () => {
    // The amplification guard, stated as the property rather than as a number.
    const taxonomy = largeTaxonomy();
    const fetch = new CountingFetch();
    const queries = planFor(taxonomy, { aliases: ['A B', 'C D', 'E F'], companies: true });

    await runOneSearch({
      queries,
      taxonomy,
      fetch,
      health: health({ budgets: { [GDELT_DOC_V2_SOURCE_ID]: 5 }, spentBy: fetch }),
    });

    expect(fetch.countStartingWith(GDELT_URL)).toBeLessThanOrEqual(5);
    expect(fetch.requests.length).toBeLessThanOrEqual(5 + 2);
  });
});

describe('one publisher failing does not stop the other', () => {
  it('runs GDELT when both sec.gov sources are refused', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy).slice(0, 4);

    const { fetch, attempts } = await runOneSearch({
      queries,
      taxonomy,
      health: health({
        refuse: [SEC_LITIGATION_RELEASES_SOURCE_ID, SEC_PRESS_RELEASES_SOURCE_ID],
      }),
    });

    expect(fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(0);
    expect(fetch.countStartingWith(SEC_PRESS_URL)).toBe(0);
    expect(fetch.countStartingWith(GDELT_URL)).toBe(queries.length);
    // The refusal is recorded against the source that was refused, at its own rung.
    expect(
      attempts.some(
        (attempt) =>
          attempt.sourceId === SEC_LITIGATION_RELEASES_SOURCE_ID && attempt.outcome === 'REFUSED',
      ),
    ).toBe(true);
  });

  it('runs both sec.gov sources when GDELT is refused', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy).slice(0, 4);

    const { fetch, attempts } = await runOneSearch({
      queries,
      taxonomy,
      health: health({ refuse: [GDELT_DOC_V2_SOURCE_ID] }),
    });

    expect(fetch.countStartingWith(GDELT_URL)).toBe(0);
    expect(fetch.countStartingWith(SEC_LITIGATION_URL)).toBe(1);
    expect(fetch.countStartingWith(SEC_PRESS_URL)).toBe(1);
    expect(
      attempts.some(
        (attempt) => attempt.sourceId === GDELT_DOC_V2_SOURCE_ID && attempt.outcome === 'REFUSED',
      ),
    ).toBe(true);
  });

  it('records a GDELT transport failure without suppressing the SEC feeds', async () => {
    // A real publisher failure rather than one of our own refusals: the run must still report
    // what the other publisher said, and must not present the failure as an empty answer.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy).slice(0, 4);
    const fetch = new CountingFetch((request) =>
      request.url.startsWith(GDELT_URL)
        ? failed(FETCH_DESCRIPTOR, NOW, { httpStatus: 503 }, 'gdelt is unavailable')
        : null,
    );

    const { attempts } = await runOneSearch({ queries, taxonomy, fetch });

    expect(
      attempts.some(
        (attempt) => attempt.sourceId === GDELT_DOC_V2_SOURCE_ID && attempt.outcome === 'FAILED',
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) =>
          attempt.sourceId === SEC_LITIGATION_RELEASES_SOURCE_ID && attempt.outcome === 'FOUND',
      ),
    ).toBe(true);
    // A failure is never an empty answer for the source that failed.
    expect(
      attempts.some(
        (attempt) => attempt.sourceId === GDELT_DOC_V2_SOURCE_ID && attempt.outcome === 'EMPTY',
      ),
    ).toBe(false);
  });
});

describe('the request log states what a reader of the findings response will see', () => {
  it('reports both shapes, both hosts and the totals', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, { companies: true });
    const { log, fetch } = await runOneSearch({
      queries,
      taxonomy,
      health: health({ budgets: { [GDELT_DOC_V2_SOURCE_ID]: 1_000 } }),
    });

    const summary = log.summaryFor('search-1');
    expect(summary.sources.map((source) => source.sourceId)).toEqual([
      GDELT_DOC_V2_SOURCE_ID,
      SEC_LITIGATION_RELEASES_SOURCE_ID,
      SEC_PRESS_RELEASES_SOURCE_ID,
    ]);
    expect(summary.totalRequestsIssued).toBe(fetch.requests.length);

    const gdelt = summary.sources.find((s) => s.sourceId === GDELT_DOC_V2_SOURCE_ID);
    expect(gdelt?.endpointKind).toBe('QUERY_FEED');
    expect(gdelt?.hosts).toEqual(['api.gdeltproject.org']);
    expect(gdelt?.requestsIssued).toBe(queries.length);

    const sec = summary.sources.find((s) => s.sourceId === SEC_PRESS_RELEASES_SOURCE_ID);
    expect(sec?.endpointKind).toBe('FIXED_FEED');
    expect(sec?.hosts).toEqual(['www.sec.gov']);
    expect(sec?.requestsIssued).toBe(1);
  });

  it('carries no query text and no URLs', async () => {
    // The field is meant to be quotable in an audit. A planned query is the subject's name plus
    // a conduct term, so anything that echoed one would move personal data into it.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, { companies: true });
    const { log } = await runOneSearch({
      queries,
      taxonomy,
      health: health({ budgets: { [GDELT_DOC_V2_SOURCE_ID]: 1_000 } }),
    });

    const serialised = JSON.stringify(log.summaryFor('search-1'));
    expect(serialised).not.toContain('Kipp');
    expect(serialised).not.toContain('http');
    expect(serialised).not.toContain('query=');
  });

  it('forgets a run once its summary has been read', async () => {
    const taxonomy = largeTaxonomy();
    const { log } = await runOneSearch({ queries: planFor(taxonomy).slice(0, 2), taxonomy });

    expect(log.summaryFor('search-1').sources.length).toBeGreaterThan(0);
    log.forget('search-1');
    expect(log.summaryFor('search-1')).toEqual({ sources: [], totalRequestsIssued: 0 });
  });

  it('keeps two concurrent runs apart', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy).slice(0, 3);
    const log = new DiscoveryRequestLog();

    await Promise.all([
      runOneSearch({ queries, taxonomy, log, jobId: 'job-a' }),
      runOneSearch({ queries, taxonomy, log, jobId: 'job-b' }),
    ]);

    for (const jobId of ['job-a', 'job-b']) {
      const gdelt = log
        .summaryFor(jobId)
        .sources.find((source) => source.sourceId === GDELT_DOC_V2_SOURCE_ID);
      expect(gdelt?.requestsIssued, jobId).toBe(queries.length);
    }
  });
});
