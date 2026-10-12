/**
 * `RssNewsDiscoveryAdapter` — the live news discovery connector, Phase E step 3.
 *
 * **Every test here runs against an injected fetch port. No socket is opened.** The connector has
 * no HTTP path of its own by design — it goes through `EvidenceFetchPort` — so a test of the
 * connector is a test of what it asks for and what it does with the answer, which is exactly the
 * part that can be wrong.
 *
 * Three behaviours carry the weight:
 *
 * 1. **A parse failure is never an empty result.** A shape change on an undocumented feed yields
 *    zero items with nothing thrown, and reporting that as "no news about this person" is the
 *    single most dangerous failure this product has (FR-05 volatility control, T84).
 * 2. **The address comes from the registry, never from the connector** (D-043), and a query is
 *    set as one search parameter rather than spliced into a string.
 * 3. **Nothing is fetched without passing the gate** — the same gate a document fetch passes.
 */

import { describe, expect, it } from 'vitest';

import type { TaxonomyVersion } from '@adverse-search/domain';

import type {
  EvidenceFetchPort,
  FetchRequest,
  FetchResult,
} from '../src/sources/evidence-fetch.port.js';
import { FetchGateService } from '../src/sources/fetch-gate.service.js';
import type { DiscoveryQuery } from '../src/sources/lead.js';
import { RssNewsDiscoveryAdapter } from '../src/sources/rss-news-discovery.adapter.js';
import {
  hasData,
  ok,
  type AdapterDescriptor,
  type SourceOutcome,
} from '../src/sources/source-adapter.js';
import type {
  ActiveSourceVersion,
  SourceVersionReader,
} from '../src/sources/source-version.service.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const CONTACT = 'https://example.com/bots/adverse-search';

const FIXED_FEED_SOURCE: ActiveSourceVersion = {
  sourceId: 'sec-litigation-releases',
  versionId: 'sec-litigation-releases:v1',
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
  endpointUrl: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss',
  endpointKind: 'FIXED_FEED',
  queryParam: null,
  pollFloorMs: 15 * 60_000,
  requestCeilingPerSecond: null,
};

const QUERY_FEED_SOURCE: ActiveSourceVersion = {
  ...FIXED_FEED_SOURCE,
  sourceId: 'news-search',
  versionId: 'news-search:v1',
  sourceName: 'A news search feed',
  canonicalDomains: ['news.example'],
  endpointUrl: 'https://news.example/rss/search?hl=en-US&gl=US',
  endpointKind: 'QUERY_FEED',
  queryParam: 'q',
  cascadeRung: 2,
};

const TAXONOMY: TaxonomyVersion = {
  taxonomyVersionId: 't-1:v1',
  version: 1,
  tenantId: 't-1',
  categories: [{ category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['US'] }],
  lexicon: [],
  languages: [{ language: 'en', measuredRecall: null, measuredByEvaluationRunId: null }],
  status: 'ACTIVE',
  proposedBy: 'test',
  approvedBy: 'test',
  activatedAt: NOW.toISOString(),
};

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SEC Litigation Releases</title>
    <language>en-us</language>
    <item>
      <title>SEC Charges Jane Marie Whitfield With Fraud</title>
      <link>https://www.sec.gov/litigation/litreleases/lr-26000?utm_source=rss</link>
      <description>The Commission filed a complaint.</description>
      <pubDate>Mon, 18 Aug 2026 14:00:00 GMT</pubDate>
    </item>
    <item>
      <title>SEC Charges Someone Else Entirely</title>
      <link>https://www.sec.gov/litigation/litreleases/lr-26001</link>
      <pubDate>Tue, 19 Aug 2026 14:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

/** Records what the connector asked for, and answers from a script. */
class RecordingFetch implements EvidenceFetchPort {
  readonly requests: FetchRequest[] = [];
  readonly descriptor: AdapterDescriptor = {
    adapterId: 'test-fetch',
    portKind: 'EVIDENCE_FETCH',
    sourceId: 'test',
    parserVersion: 'test-1',
    stabilityClass: 'DOCUMENTED_STABLE',
    mode: 'LIVE',
    jurisdictions: [],
  };

  constructor(
    private readonly script: (request: FetchRequest) => SourceOutcome<FetchResult> = () =>
      body(FEED),
  ) {}

  fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>> {
    this.requests.push(request);
    return Promise.resolve(this.script(request));
  }

  robotsPositionFor(): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'> {
    return Promise.resolve('ALLOWED');
  }
}

function body(text: string, contentType = 'application/rss+xml'): SourceOutcome<FetchResult> {
  const bytes = new TextEncoder().encode(text);
  return ok(
    {
      adapterId: 'test-fetch',
      portKind: 'EVIDENCE_FETCH',
      sourceId: 'test',
      parserVersion: 'test-1',
      stabilityClass: 'DOCUMENTED_STABLE',
      mode: 'LIVE',
      jurisdictions: [],
    },
    NOW,
    {
      url: 'https://example/feed',
      finalUrl: 'https://example/feed',
      httpStatus: 200,
      headers: { 'content-type': contentType },
      body: bytes,
      notModified: false,
      contentType,
      bytes: bytes.byteLength,
      renderTrigger: null,
      egressIdentityId: 'egress-primary',
      fetchedAt: NOW.toISOString(),
    },
  );
}

function notModified(): SourceOutcome<FetchResult> {
  const result = body('');
  if (!hasData(result)) {
    throw new Error('unreachable');
  }
  return { ...result, data: { ...result.data, httpStatus: 304, notModified: true, body: null } };
}

function readerFor(version: ActiveSourceVersion | null): SourceVersionReader {
  return {
    loadActive: () => Promise.resolve(version),
    loadActiveByDomain: () => Promise.resolve(null),
  };
}

function adapterFor(
  version: ActiveSourceVersion | null,
  fetch: RecordingFetch = new RecordingFetch(),
): { adapter: RssNewsDiscoveryAdapter; fetch: RecordingFetch } {
  const versions = readerFor(version);
  const gate = new FetchGateService(versions, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT });
  return {
    adapter: new RssNewsDiscoveryAdapter({
      sourceId: version?.sourceId ?? 'missing',
      versions,
      gate,
      fetch,
      clock: () => NOW,
    }),
    fetch,
  };
}

function queryFor(overrides: Partial<DiscoveryQuery> = {}): DiscoveryQuery {
  return {
    tenantId: 't-1',
    run: {
      jobId: 'job-1',
      subjectId: 'subject-1',
      jurisdictions: ['US'],
      languages: ['en'],
      taxonomy: TAXONOMY,
    },
    queryId: 'q-1',
    family: 'F1',
    text: 'Jane Marie Whitfield',
    language: 'en',
    country: 'US',
    window: null,
    limit: 25,
    ...overrides,
  };
}

describe('the address comes from the registry, never from the connector', () => {
  it('polls the endpoint the approved version records', async () => {
    const { adapter, fetch } = adapterFor(FIXED_FEED_SOURCE);
    await adapter.discover(queryFor());

    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.url).toBe(FIXED_FEED_SOURCE.endpointUrl);
  });

  it('refuses a source that records no endpoint rather than inventing one', async () => {
    const { adapter, fetch } = adapterFor({ ...FIXED_FEED_SOURCE, endpointUrl: null });
    const outcome = await adapter.discover(queryFor());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.detail).toContain('records no endpoint');
    }
    // And nothing was fetched. A connector that guessed an address would be making a request
    // nobody approved.
    expect(fetch.requests).toHaveLength(0);
  });

  it('sets the query as one search parameter on a QUERY_FEED, keeping the recorded ones', async () => {
    const { adapter, fetch } = adapterFor(QUERY_FEED_SOURCE);
    await adapter.discover(queryFor({ text: 'Jane Whitfield' }));

    const url = new URL(fetch.requests[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('Jane Whitfield');
    // The edition parameters an approver recorded survive. A connector that rebuilt the URL from
    // scratch would silently drop them and search the wrong edition.
    expect(url.searchParams.get('hl')).toBe('en-US');
    expect(url.searchParams.get('gl')).toBe('US');
  });

  it('cannot be made to reach another host through the query text', async () => {
    // The query is a parameter value, not a template hole. Serialising through `URL` is what
    // makes this structural rather than a matter of escaping carefully.
    const { adapter, fetch } = adapterFor(QUERY_FEED_SOURCE);
    await adapter.discover(queryFor({ text: 'x&hl=zz#/../..@evil.example/?q=' }));

    const url = new URL(fetch.requests[0]?.url ?? '');
    expect(url.hostname).toBe('news.example');
    expect(url.searchParams.get('hl')).toBe('en-US');
  });

  it('refuses a QUERY_FEED that names no query parameter', async () => {
    const { adapter, fetch } = adapterFor({ ...QUERY_FEED_SOURCE, queryParam: null });
    const outcome = await adapter.discover(queryFor());
    expect(outcome.status).toBe('FAILED');
    expect(fetch.requests).toHaveLength(0);
  });
});

describe('nothing is fetched without passing the gate', () => {
  it('refuses a source with no named first-contact approval, and opens no socket', async () => {
    const { adapter, fetch } = adapterFor({ ...FIXED_FEED_SOURCE, firstContactApproval: null });
    const outcome = await adapter.discover(queryFor());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.detail).toContain('NO_FIRST_CONTACT_APPROVAL');
    }
    expect(fetch.requests).toHaveLength(0);
  });

  it('refuses a source whose robots position was never established', async () => {
    const { adapter, fetch } = adapterFor({
      ...FIXED_FEED_SOURCE,
      robotsPosition: 'NOT_ESTABLISHED',
    });
    const outcome = await adapter.discover(queryFor());

    expect(outcome.status).toBe('FAILED');
    expect(fetch.requests).toHaveLength(0);
  });

  it('refuses a jurisdiction the run never asked for', async () => {
    const { adapter, fetch } = adapterFor(FIXED_FEED_SOURCE);
    const outcome = await adapter.discover(
      queryFor({ run: { ...queryFor().run, jurisdictions: ['CR'] }, country: 'US' }),
    );
    expect(outcome.status).toBe('FAILED');
    expect(fetch.requests).toHaveLength(0);
  });

  it('records no relevance score for a feed poll, because nothing has been judged', async () => {
    const { adapter, fetch } = adapterFor(FIXED_FEED_SOURCE);
    await adapter.discover(queryFor());

    const authorisation = fetch.requests[0]?.authorisation;
    expect(authorisation?.relevanceScore).toBeNull();
    expect(authorisation?.relevanceMethod).toBe('NOT_APPLICABLE_ENDPOINT_POLL');
  });

  it('attributes the poll to the run, which is what makes it not anonymous', async () => {
    const { adapter, fetch } = adapterFor(FIXED_FEED_SOURCE);
    await adapter.discover(queryFor());

    expect(fetch.requests[0]?.attribution).toMatchObject({
      tenantId: 't-1',
      jobId: 'job-1',
      subjectId: 'subject-1',
      queryId: 'q-1',
      sourceId: 'sec-litigation-releases',
    });
  });
});

describe('a parse failure is never an empty result', () => {
  it('reports a shape change as FAILED, not as "nothing found"', async () => {
    // The failure T84 exists for: HTTP 200, a body that parses, and zero items. Nothing throws.
    const fetch = new RecordingFetch(() => body('<html><body>We moved!</body></html>'));
    const { adapter } = adapterFor(FIXED_FEED_SOURCE, fetch);
    const outcome = await adapter.discover(queryFor());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.detail).toContain('neither an RSS');
    }
  });

  it('reports a feed carrying a DOCTYPE as FAILED, and never parses it', async () => {
    const fetch = new RecordingFetch(() =>
      body(
        `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>` +
          `<rss version="2.0"><channel><title>&x;</title></channel></rss>`,
      ),
    );
    const { adapter } = adapterFor(FIXED_FEED_SOURCE, fetch);
    const outcome = await adapter.discover(queryFor());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('CONTENT_ERROR');
    }
  });

  it('reports a genuinely empty feed as NO_RESULTS, which is a different fact', async () => {
    const fetch = new RecordingFetch(() =>
      body('<rss version="2.0"><channel><title>Nada</title></channel></rss>'),
    );
    const { adapter } = adapterFor(FIXED_FEED_SOURCE, fetch);
    expect((await adapter.discover(queryFor())).status).toBe('NO_RESULTS');
  });

  it('treats a 304 as a successful poll of an unchanged feed, not as a failure', async () => {
    const fetch = new RecordingFetch(() => notModified());
    const { adapter } = adapterFor(FIXED_FEED_SOURCE, fetch);
    expect((await adapter.discover(queryFor())).status).toBe('NO_RESULTS');
  });
});

describe('the leads it produces', () => {
  it('does not poll a fixed feed for non-F1 queries', async () => {
    const { adapter, fetch } = adapterFor(FIXED_FEED_SOURCE);
    const outcome = await adapter.discover(
      queryFor({ family: 'F3', text: '"Jane Marie Whitfield" fraud' }),
    );

    expect(outcome.status).toBe('NO_RESULTS');
    expect(fetch.requests).toHaveLength(0);
  });

  it('matches the planned query against a fixed feed the publisher was never asked', async () => {
    const { adapter } = adapterFor(FIXED_FEED_SOURCE);
    const outcome = await adapter.discover(queryFor({ text: '"Jane Marie Whitfield"' }));

    expect(hasData(outcome)).toBe(true);
    if (!hasData(outcome)) {
      return;
    }
    // Two items in the feed, one about the subject. A fixed feed is the publisher's whole list.
    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]?.title).toContain('Jane Marie Whitfield');
  });

  it('does not re-filter what a query feed already answered', async () => {
    // The publisher was asked the question. Filtering their answer again on our own string match
    // would silently discard results they judged relevant.
    const { adapter } = adapterFor(QUERY_FEED_SOURCE);
    const outcome = await adapter.discover(queryFor());

    expect(hasData(outcome)).toBe(true);
    if (hasData(outcome)) {
      expect(outcome.data).toHaveLength(2);
    }
  });

  it('canonicalises the URL, so tracking parameters do not make one story two', async () => {
    const { adapter } = adapterFor(FIXED_FEED_SOURCE);
    const outcome = await adapter.discover(queryFor());

    if (!hasData(outcome)) {
      throw new Error('expected leads');
    }
    expect(outcome.data[0]?.url).not.toContain('utm_source');
  });

  it('carries the rung the approved version records, not one the connector chose', async () => {
    const { adapter } = adapterFor(FIXED_FEED_SOURCE);
    const outcome = await adapter.discover(queryFor());
    if (hasData(outcome)) {
      expect(outcome.data[0]?.rung).toBe(1);
    }
  });

  it('leaves a missing publication date null rather than backfilling the retrieval date', async () => {
    // FR-07. A date nobody published is a date a reviewer would reason about as though it were
    // the event's, and recency is judged on it.
    const fetch = new RecordingFetch(() =>
      body(
        `<rss version="2.0"><channel><item><title>Jane Marie Whitfield charged</title>` +
          `<link>https://www.sec.gov/x</link></item></channel></rss>`,
      ),
    );
    const { adapter } = adapterFor(FIXED_FEED_SOURCE, fetch);
    const outcome = await adapter.discover(queryFor());

    if (hasData(outcome)) {
      expect(outcome.data[0]?.publishedAt).toEqual({ value: null, precision: 'UNKNOWN' });
    }
  });

  it('never synthesises a snippet the publisher did not write', async () => {
    const { adapter } = adapterFor(QUERY_FEED_SOURCE);
    const outcome = await adapter.discover(queryFor());
    if (hasData(outcome)) {
      const sparse = outcome.data.find((lead) => lead.title.includes('Someone Else'));
      expect(sparse?.snippet).toBeNull();
    }
  });

  it('drops an item whose link the URL policy refuses, rather than carrying it to the gate', async () => {
    const fetch = new RecordingFetch(() =>
      body(
        `<rss version="2.0"><channel>` +
          `<item><title>Jane Marie Whitfield</title><link>http://insecure.example/a</link></item>` +
          `<item><title>Jane Marie Whitfield again</title><link>https://www.sec.gov/b</link></item>` +
          `</channel></rss>`,
      ),
    );
    const { adapter } = adapterFor(FIXED_FEED_SOURCE, fetch);
    const outcome = await adapter.discover(queryFor());

    if (hasData(outcome)) {
      expect(outcome.data).toHaveLength(1);
      expect(outcome.data[0]?.url).toContain('https://www.sec.gov/b');
    }
  });

  it('bounds the result rather than silently cutting it', async () => {
    const { adapter } = adapterFor(QUERY_FEED_SOURCE);
    const outcome = await adapter.discover(queryFor({ limit: 1 }));

    expect(outcome.status).toBe('BOUNDED');
    if (outcome.status === 'BOUNDED') {
      expect(outcome.truncation.availableCount).toBe(2);
      expect(outcome.truncation.limit).toBe(1);
    }
  });
});

describe('the contract probe', () => {
  it('reports a shape change as unstable, with zero items parsed', async () => {
    const fetch = new RecordingFetch(() => body('<html><body>moved</body></html>'));
    const { adapter } = adapterFor(FIXED_FEED_SOURCE, fetch);
    const probe = await adapter.contractProbe();

    expect(probe.shapeStable).toBe(false);
    expect(probe.sampleParsedCount).toBe(0);
    expect(probe.parserVersion).toContain('4.5.7');
  });

  it('reports a working feed as stable', async () => {
    const { adapter } = adapterFor(FIXED_FEED_SOURCE);
    const probe = await adapter.contractProbe();

    expect(probe.shapeStable).toBe(true);
    expect(probe.sampleParsedCount).toBe(2);
  });

  it('goes through the gate like any other request', async () => {
    // A probe that bypassed the gate would be a scheduled job making unauthorised requests to a
    // publisher — a worse problem than the one it detects.
    const { adapter, fetch } = adapterFor({ ...FIXED_FEED_SOURCE, firstContactApproval: null });
    const probe = await adapter.contractProbe();

    expect(probe.shapeStable).toBe(false);
    expect(fetch.requests).toHaveLength(0);
  });
});
