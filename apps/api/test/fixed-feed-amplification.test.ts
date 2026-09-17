/**
 * How many times one search may ask a publisher for the same bytes.
 *
 * A `FIXED_FEED` is the publisher's whole list. It is polled and then matched locally, so the
 * number of external requests it costs is a property of **the feed**, not of the query plan. The
 * bug this file exists to prevent is the opposite: a plan of forty queries producing forty polls
 * of one unchanging URL, which exhausts the SEC's free tier in two or three searches and reads to
 * a reviewer as `PARTIAL` / `UNRESOLVED` with a lead rejected at stage `FETCH`.
 *
 * **Nothing here opens a socket.** The fetch port is injected and counts what it was asked for,
 * which is precisely the quantity the publisher sees.
 *
 * The harness reproduces `SearchPipelineService.discover` — build the ladder from the registry,
 * then walk the cascade once per planned query — because that loop is where the multiplication
 * happened. The plan is built by the real `buildQueryPlan` from a taxonomy the size of the one a
 * live tenant actually carries, so the count under test is the count a real run produces.
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
import type {
  EvidenceFetchPort,
  FetchRequest,
  FetchResult,
} from '../src/sources/evidence-fetch.port.js';
import { FetchGateService } from '../src/sources/fetch-gate.service.js';
import { FixedFeedPollCache } from '../src/sources/feed-poll-cache.js';
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

const NOW = new Date('2026-09-17T12:00:00.000Z');
const CONTACT = 'https://erlystage.com/bots/adverse-search';
const SEC_FEED_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss';

/** The SEC record as the registry actually holds it — nested under `content`, rung 1, fixed. */
const SEC_VERSION_DOCUMENT = {
  sourceId: 'sec-litigation-releases',
  status: 'ACTIVE',
  version: 5,
  versionId: 'sec-litigation-releases:v5',
  content: {
    sourceName: 'SEC litigation releases (RSS)',
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
      endpointUrl: SEC_FEED_URL,
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

const SEC_VERSION: ActiveSourceVersion = {
  sourceId: 'sec-litigation-releases',
  versionId: 'sec-litigation-releases:v5',
  version: 5,
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
  endpointUrl: SEC_FEED_URL,
  endpointKind: 'FIXED_FEED',
  queryParam: null,
  pollFloorMs: 15 * 60_000,
};

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SEC Litigation Releases</title>
    <language>en-us</language>
    <item>
      <title>SEC Charges Jon P. Kipp With Fraud</title>
      <link>https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26640</link>
      <description>The Commission filed a complaint.</description>
      <pubDate>Mon, 18 Aug 2026 14:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const FETCH_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'test-fetch',
  portKind: 'EVIDENCE_FETCH',
  sourceId: 'test',
  parserVersion: 'test-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'LIVE',
  jurisdictions: [],
};

/**
 * The fetch port, counting every request by URL.
 *
 * This is the only number that matters: it is what the publisher's own log would show.
 */
class CountingFetch implements EvidenceFetchPort {
  readonly requests: FetchRequest[] = [];
  readonly descriptor = FETCH_DESCRIPTOR;

  constructor(
    private readonly script: (
      request: FetchRequest,
      nth: number,
    ) => SourceOutcome<FetchResult> = () => feedBody(),
  ) {}

  fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>> {
    this.requests.push(request);
    return Promise.resolve(this.script(request, this.requests.length));
  }

  robotsPositionFor(): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'> {
    return Promise.resolve('ALLOWED');
  }

  countFor(url: string): number {
    return this.requests.filter((request) => request.url === url).length;
  }
}

function feedBody(text = FEED): SourceOutcome<FetchResult> {
  const bytes = new TextEncoder().encode(text);
  return ok(FETCH_DESCRIPTOR, NOW, {
    url: SEC_FEED_URL,
    finalUrl: SEC_FEED_URL,
    httpStatus: 200,
    headers: { 'content-type': 'application/rss+xml' },
    body: bytes,
    notModified: false,
    contentType: 'application/rss+xml',
    bytes: bytes.byteLength,
    renderTrigger: null,
    egressIdentityId: 'egress-primary',
    fetchedAt: NOW.toISOString(),
  });
}

function dbWith(documents: readonly Record<string, unknown>[]): Db {
  return {
    collection: () => ({
      find: () => ({ toArray: () => Promise.resolve([...documents]) }),
    }),
  } as unknown as Db;
}

function readerFor(version: ActiveSourceVersion | null): SourceVersionReader {
  return { loadActive: () => Promise.resolve(version) };
}

const EMPTY_SET: SourceAdapterSet = {
  newsDiscovery: [],
  webDiscovery: [],
  primarySource: null,
  companyRegistry: null,
  evidenceFetch: null,
  extractionModel: null,
};

/** Health that permits everything and counts. The breaker is tested elsewhere. */
function permissiveHealth(): CascadeHealthPort & { readonly checks: string[] } {
  const checks: string[] = [];
  return {
    checks,
    checkAccess: ((input: { sourceId: string }) => {
      checks.push(input.sourceId);
      return Promise.resolve({
        decision: { allowed: true, refusal: null, detail: '', health: null },
        coverageOutcome: null,
      });
    }) as unknown as CascadeHealthPort['checkAccess'],
    recordFailure: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordFailure'],
    recordSuccess: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordSuccess'],
  };
}

/**
 * A taxonomy the size of a live tenant's — seventeen categories, both languages, real term
 * counts — because the bug's size is a function of the plan's size.
 */
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

/** The plan a live run of this shape produces, bounded exactly as the pipeline bounds it. */
function planFor(
  taxonomy: TaxonomyVersion,
  aliases: readonly string[] = [],
): readonly PlannedQuery[] {
  const plan = buildQueryPlan({
    subjectName: 'Jon P. Kipp',
    normalisedName: normaliseName('Jon P. Kipp'),
    aliases,
    jurisdictions: ['US'],
    languages: ['en'],
    taxonomy,
    anchorCompanies: [],
    queryIdPrefix: 'run',
  });
  return boundPlan(plan, 200).kept;
}

/**
 * One search, run exactly as `SearchPipelineService.discover` runs it.
 *
 * Returns the fetch port so the caller can count. `cache` is passed through to the connector: a
 * run supplies one, and the cache is what makes a fixed feed cost one poll rather than one per
 * query.
 */
async function runOneSearch(input: {
  readonly queries: readonly PlannedQuery[];
  readonly fetch: CountingFetch;
  readonly cache?: FixedFeedPollCache;
  readonly taxonomy: TaxonomyVersion;
  readonly now?: Date;
}): Promise<void> {
  const versions = readerFor(SEC_VERSION);
  const builder = new LadderBuilder(dbWith([SEC_VERSION_DOCUMENT]), EMPTY_SET, {
    mode: 'LIVE',
    versions,
    gate: new FetchGateService(versions, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
    evidenceFetch: input.fetch,
    clock: () => input.now ?? NOW,
    ...(input.cache === undefined ? {} : { pollCache: input.cache }),
  });
  const ladder = await builder.build();
  const cascade = new CascadeService(permissiveHealth());

  for (const [index, query] of input.queries.entries()) {
    const discovery: DiscoveryQuery = {
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
    await cascade.walk({
      ladder,
      query: discovery,
      queriesAffected: input.queries.length - index,
      now: input.now ?? NOW,
    });
  }
}

describe('a fixed feed costs one poll per search, not one per planned query', () => {
  it('polls the SEC feed exactly once for a full-sized query plan', async () => {
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy);
    const fetch = new CountingFetch();

    // The plan this asserts against is the real one: F1 per name form, F3 per category term,
    // F4 per jurisdiction. If it ever shrinks to a handful, this test stops proving anything.
    expect(queries.length).toBeGreaterThanOrEqual(40);

    await runOneSearch({ queries, fetch, cache: new FixedFeedPollCache(), taxonomy });

    expect(fetch.countFor(SEC_FEED_URL)).toBe(1);
  });

  it('still polls once when the subject carries aliases in several name forms', async () => {
    // Aliases multiply F1, which is the family a fixed feed answers. Before the poll cache this
    // was the multiplier: one identical request per name form per language per jurisdiction.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, ['Jonathan Kipp', 'J. Kipp', 'Jon Kipp']);
    const fetch = new CountingFetch();

    expect(queries.filter((query) => query.family === 'F1').length).toBe(4);

    await runOneSearch({ queries, fetch, cache: new FixedFeedPollCache(), taxonomy });

    expect(fetch.countFor(SEC_FEED_URL)).toBe(1);
  });

  it('never approaches the ~41 identical fetches the bug produced', async () => {
    // The regression guard stated as the number it guards against. A plan of this size fetching
    // per query is what spent the SEC's whole hourly free tier in two or three searches.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, ['Jonathan Kipp']);
    const fetch = new CountingFetch();

    await runOneSearch({ queries, fetch, cache: new FixedFeedPollCache(), taxonomy });

    expect(fetch.requests.length).toBeLessThan(5);
    expect(fetch.requests.length).toBeLessThan(queries.length);
  });

  it('does not re-poll when the same search is orchestrated twice inside the poll floor', async () => {
    // A redelivered queue message, a stage retry, or two ladder entries for one source. The
    // publisher must see one request, not one per delivery.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy);
    const fetch = new CountingFetch();
    const cache = new FixedFeedPollCache();

    await runOneSearch({ queries, fetch, cache, taxonomy });
    await runOneSearch({ queries, fetch, cache, taxonomy });

    expect(fetch.countFor(SEC_FEED_URL)).toBe(1);
  });

  it('polls again once the publisher’s own poll floor has elapsed', async () => {
    // The cache is a poll floor, not a permanent freeze. Fifteen minutes is what the SEC's
    // record says; after it, a new search is entitled to fresh bytes.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy);
    const fetch = new CountingFetch();
    const cache = new FixedFeedPollCache();

    await runOneSearch({ queries, fetch, cache, taxonomy });
    await runOneSearch({
      queries,
      fetch,
      cache,
      taxonomy,
      now: new Date(NOW.getTime() + 15 * 60_000 + 1),
    });

    expect(fetch.countFor(SEC_FEED_URL)).toBe(2);
  });

  it('collapses concurrent polls of the same feed into one request', async () => {
    // Two searches in flight at once must not both open a socket. Without an in-flight map a
    // cache that only stores completed responses lets every concurrent run through.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy);
    const fetch = new CountingFetch();
    const cache = new FixedFeedPollCache();

    await Promise.all([
      runOneSearch({ queries, fetch, cache, taxonomy }),
      runOneSearch({ queries, fetch, cache, taxonomy }),
      runOneSearch({ queries, fetch, cache, taxonomy }),
    ]);

    expect(fetch.countFor(SEC_FEED_URL)).toBe(1);
  });

  it('does not serve a failed poll from the cache', async () => {
    // A failure is not a poll. Replaying one would hide the breaker's own recovery and make a
    // transient error look like a fifteen-minute outage.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy);
    const cache = new FixedFeedPollCache();
    const fetch = new CountingFetch((_request, nth) =>
      nth === 1 ? failed(FETCH_DESCRIPTOR, NOW, { httpStatus: 503 }, 'upstream') : feedBody(),
    );

    await runOneSearch({ queries, fetch, cache, taxonomy });
    await runOneSearch({ queries, fetch, cache, taxonomy });

    // One failed poll in the first search, one successful poll in the second, and the second
    // search's remaining forty queries served from the cache.
    expect(fetch.countFor(SEC_FEED_URL)).toBe(2);
  });
});

describe('the poll cache itself', () => {
  it('reports how many polls it turned into how many requests', async () => {
    // The count has to be observable, or "no amplification" is a claim nobody can check. This
    // is what the live smoke test reads.
    const taxonomy = largeTaxonomy();
    const queries = planFor(taxonomy, ['Jonathan Kipp', 'J. Kipp', 'Jon Kipp']);
    const fetch = new CountingFetch();
    const cache = new FixedFeedPollCache();

    await runOneSearch({ queries, fetch, cache, taxonomy });

    const stats = cache.statsFor(SEC_FEED_URL);
    expect(stats.requests).toBe(1);
    expect(stats.served).toBe(queries.filter((query) => query.family === 'F1').length);
    expect(stats.served).toBeGreaterThan(stats.requests);
  });
});

describe('our own refusals are not the publisher’s failures', () => {
  it('does not open the source breaker when the gate refuses our configuration', async () => {
    // A gate refusal carries `policyRefusal`, which classifies as `HARD_BLOCK` — the class that
    // opens the breaker and suspends the domain. Recording it against source health marks a
    // working publisher as one that refused us, on the strength of a decision about our own
    // registry record, and every later run is refused before a socket opens. That is how the SEC
    // source reached `OPEN` / `HARD_BLOCK` with zero consecutive failures.
    const failures: unknown[] = [];
    const health: CascadeHealthPort = {
      checkAccess: (() =>
        Promise.resolve({
          decision: { allowed: true, refusal: null, detail: '', health: null },
          coverageOutcome: null,
        })) as unknown as CascadeHealthPort['checkAccess'],
      recordFailure: ((input: unknown) => {
        failures.push(input);
        return Promise.resolve(null);
      }) as unknown as CascadeHealthPort['recordFailure'],
      recordSuccess: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordSuccess'],
    };
    const cascade = new CascadeService(health);

    const attempt = await cascade.walk({
      ladder: [
        {
          rung: 1,
          sourceId: 'sec-litigation-releases',
          sourceName: 'SEC litigation releases (RSS)',
          ask: () =>
            Promise.resolve(
              failed(
                FETCH_DESCRIPTOR,
                NOW,
                { policyRefusal: true },
                'ROBOTS_POSITION_NOT_ESTABLISHED: nobody has read their robots.txt.',
              ),
            ),
        },
      ],
      query: {
        tenantId: 'tenant-live',
        run: {
          jobId: 'job',
          subjectId: 'subject',
          jurisdictions: ['US'],
          languages: ['en'],
          taxonomy: largeTaxonomy(),
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

    // Still a recorded failure and still a coverage gap — it is only source *health* that must
    // not hear about it.
    expect(attempt.attempts.some((one) => one.outcome === 'FAILED')).toBe(true);
    expect(failures).toHaveLength(0);
  });

  it('still records a real publisher failure against source health', async () => {
    const failures: unknown[] = [];
    const health: CascadeHealthPort = {
      checkAccess: (() =>
        Promise.resolve({
          decision: { allowed: true, refusal: null, detail: '', health: null },
          coverageOutcome: null,
        })) as unknown as CascadeHealthPort['checkAccess'],
      recordFailure: ((input: unknown) => {
        failures.push(input);
        return Promise.resolve(null);
      }) as unknown as CascadeHealthPort['recordFailure'],
      recordSuccess: (() => Promise.resolve(null)) as unknown as CascadeHealthPort['recordSuccess'],
    };
    const cascade = new CascadeService(health);

    await cascade.walk({
      ladder: [
        {
          rung: 1,
          sourceId: 'sec-litigation-releases',
          sourceName: 'SEC litigation releases (RSS)',
          ask: () =>
            Promise.resolve(
              failed(FETCH_DESCRIPTOR, NOW, { httpStatus: 429 }, 'the publisher rate-limited us'),
            ),
        },
      ],
      query: {
        tenantId: 'tenant-live',
        run: {
          jobId: 'job',
          subjectId: 'subject',
          jurisdictions: ['US'],
          languages: ['en'],
          taxonomy: largeTaxonomy(),
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

    expect(failures).toHaveLength(1);
  });
});
