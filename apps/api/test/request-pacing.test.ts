/**
 * The recorded request ceiling is enforced, and enforcing it changes nothing else.
 *
 * # What this file is guarding
 *
 * `accessPolicy.requestCeilingPerSecond` was recorded on every source version since FR-05 and
 * read by nothing. The regression is not that the number was wrong — it is that a record could
 * state a ceiling, an approver could sign it, and the service could then ignore it, with no test
 * anywhere able to tell the difference. GDELT publishes "one request every 5 seconds" in the body
 * of its own 429, so for a `QUERY_FEED` this is the difference between a fan-out that works and
 * one that is refused from its second request onward.
 *
 * The properties asserted, in the order they matter:
 *
 * 1. **The ceiling is read from the record, not from a constant.** 0.2/second means 5000ms, and
 *    a source recording no ceiling is not paced at all.
 * 2. **Requests are actually spaced.** Not "a delay function was called" — the gap between
 *    consecutive sends, measured on the clock the pacer reads.
 * 3. **Arrival order is preserved.** A long plan is not starved by a later caller.
 * 4. **Keys are independent.** Pacing GDELT must never delay the SEC.
 * 5. **Pacing delays; it never drops, and never merges.** The same number of requests go out,
 *    against the same number of distinct URLs, as before pacing existed — because
 *    `requestsIssued` and `distinctEndpoints` are how a query feed is told from a fixed one, and
 *    a "fix" that quietly reduced either would break the thing it was protecting.
 * 6. **The connector carries the ceiling, the fetch adapter enforces it.** Pacing lives at the
 *    one choke point every outbound request passes through — `HttpEvidenceFetchAdapter`, which
 *    issues the document fetch, each redirect hop and the robots.txt read that precedes them.
 *    The tests for that enforcement are in `http-evidence-fetch.test.ts`; what is asserted here
 *    is that the connector puts the approved ceiling where the adapter can read it.
 *
 * **Nothing here opens a socket, and nothing here spends wall-clock time.** The pacer's clock and
 * its sleep are both injected, so a five-second interval is asserted in microseconds.
 */

import { describe, expect, it } from 'vitest';

import { DiscoveryRequestLog } from '../src/sources/discovery-request-log.js';
import type {
  EvidenceFetchPort,
  FetchAuthorisation,
  FetchRequest,
  FetchResult,
} from '../src/sources/evidence-fetch.port.js';
import { FetchGateService } from '../src/sources/fetch-gate.service.js';
import { GdeltDiscoveryAdapter } from '../src/sources/gdelt-discovery.adapter.js';
import type { DiscoveryQuery } from '../src/sources/lead.js';
import { minIntervalMsFor, RequestPacer } from '../src/sources/request-pacer.js';
import { GDELT_DOC_V2_SOURCE_ID } from '../src/sources/registry/gdelt-doc-v2.js';
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
import type { TaxonomyVersion } from '@adverse-search/domain';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const CONTACT = 'https://example.com/bots/adverse-search';

/**
 * A clock and a sleep that share one counter.
 *
 * `sleep(ms)` advances the clock by exactly `ms` and returns. That is what makes a five-second
 * interval assertable without waiting five seconds, and it is stricter than a spy on `setTimeout`:
 * the gap asserted below is read from the same clock the pacer used to decide it.
 */
function fakeTime(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  readonly sleeps: number[];
} {
  let current = NOW.getTime();
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number) => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. The mapping
// ---------------------------------------------------------------------------------------------

describe('minIntervalMsFor turns a recorded ceiling into an interval', () => {
  it('maps GDELT’s published 0.2/second to 5000ms', () => {
    expect(minIntervalMsFor(0.2)).toBe(5000);
  });

  it('maps the SEC’s 10/second to 100ms', () => {
    expect(minIntervalMsFor(10)).toBe(100);
  });

  it('treats an absent ceiling as no pacing rather than as a default', () => {
    // Inventing an interval for a publisher who published none is the same class of mistake as
    // inventing their robots position.
    expect(minIntervalMsFor(null)).toBeNull();
  });

  it('treats a corrupt ceiling as absent, never as unlimited', () => {
    expect(minIntervalMsFor(0)).toBeNull();
    expect(minIntervalMsFor(-1)).toBeNull();
    expect(minIntervalMsFor(Number.NaN)).toBeNull();
    expect(minIntervalMsFor(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2-4. The pacer itself
// ---------------------------------------------------------------------------------------------

describe('RequestPacer spaces requests on one key', () => {
  it('lets the first request go immediately and spaces every one after it', async () => {
    const time = fakeTime();
    const pacer = new RequestPacer({ now: time.now, sleep: time.sleep });
    const sentAt: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      await pacer.pace('gdelt-doc-v2', 5000);
      sentAt.push(time.now());
    }

    expect(sentAt.at(0)).toBe(NOW.getTime());
    for (let i = 1; i < sentAt.length; i += 1) {
      expect((sentAt[i] ?? 0) - (sentAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(5000);
    }
    // Three waits, not four: the first request is not delayed, because nothing preceded it.
    expect(time.sleeps).toEqual([5000, 5000, 5000]);
  });

  it('does not pace a source that records no ceiling', async () => {
    const time = fakeTime();
    const pacer = new RequestPacer({ now: time.now, sleep: time.sleep });

    for (let i = 0; i < 5; i += 1) {
      const result = await pacer.pace('unpaced-source', null);
      expect(result.waitedMs).toBe(0);
      expect(result.minIntervalMs).toBeNull();
    }
    expect(time.sleeps).toEqual([]);
    expect(time.now()).toBe(NOW.getTime());
  });

  it('serves concurrent waiters in arrival order rather than starving the first', async () => {
    const time = fakeTime();
    const pacer = new RequestPacer({ now: time.now, sleep: time.sleep });
    const finished: string[] = [];

    // Started together, deliberately: the pipeline's loop is serial, but a second search in the
    // same process is not, and a pacer that reordered under concurrency would let a late caller
    // jump a long plan.
    await Promise.all(
      ['a', 'b', 'c'].map(async (label) => {
        await pacer.pace('one-key', 5000);
        finished.push(label);
      }),
    );

    expect(finished).toEqual(['a', 'b', 'c']);
  });

  it('paces each key independently, so GDELT never delays the SEC', async () => {
    const time = fakeTime();
    const pacer = new RequestPacer({ now: time.now, sleep: time.sleep });

    await pacer.pace('gdelt-doc-v2', 5000);
    const beforeSec = time.now();
    await pacer.pace('sec-litigation-releases', 100);
    await pacer.pace('sec-press-releases', 100);

    // Neither SEC source waited: their keys had no reservation, GDELT's is on GDELT's key.
    expect(time.now()).toBe(beforeSec);
    expect(time.sleeps).toEqual([]);
  });

  it('releases its slot even when the sleep throws, so one failure cannot stall the key', async () => {
    let first = true;
    const pacer = new RequestPacer({
      now: () => NOW.getTime(),
      sleep: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error('timer failed'));
        }
        return Promise.resolve();
      },
    });

    await pacer.pace('key', 5000);
    await expect(pacer.pace('key', 5000)).rejects.toThrow('timer failed');
    // The third call must still be served. A waiter that never released would hang here.
    await expect(pacer.pace('key', 5000)).resolves.toMatchObject({ minIntervalMs: 5000 });
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The adapter, end to end
// ---------------------------------------------------------------------------------------------

const FETCH_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'test-fetch',
  portKind: 'EVIDENCE_FETCH',
  sourceId: 'test',
  parserVersion: 'test-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'LIVE',
  jurisdictions: [],
};

function gdeltVersion(ceiling: number | null): ActiveSourceVersion {
  return {
    sourceId: GDELT_DOC_V2_SOURCE_ID,
    versionId: `${GDELT_DOC_V2_SOURCE_ID}:v1`,
    version: 1,
    sourceName: 'GDELT DOC 2.0 (global article index)',
    connectorType: 'NEWS_DISCOVERY_GDELT',
    canonicalDomains: ['api.gdeltproject.org'],
    countries: ['US'],
    languages: ['en'],
    robotsPosition: 'HONOURED',
    licenceTermsVersion: 'gdelt-terms-of-use-2022-09-03',
    licenceExpiresAt: null,
    cascadeRung: 3,
    authorityTier: 5,
    firstContactApproval: {
      approvedBy: 'Faisal Ali',
      role: 'Source admin',
      approvedOn: '2026-09-18',
      decision: 'D18',
    },
    robotsException: null,
    endpointUrl: GDELT_URL,
    endpointKind: 'QUERY_FEED',
    queryParam: 'query',
    pollFloorMs: null,
    requestCeilingPerSecond: ceiling,
  };
}

/** Records every URL it was asked for, and when — the two facts this file is about. */
class TimedFetch implements EvidenceFetchPort {
  readonly requests: { url: string; at: number }[] = [];
  readonly authorisations: FetchAuthorisation[] = [];
  readonly descriptor = FETCH_DESCRIPTOR;

  constructor(private readonly now: () => number) {}

  fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>> {
    this.requests.push({ url: request.url, at: this.now() });
    this.authorisations.push(request.authorisation);
    const text = JSON.stringify({ articles: [] });
    const bytes = new TextEncoder().encode(text);
    return Promise.resolve(
      ok(FETCH_DESCRIPTOR, NOW, {
        url: request.url,
        finalUrl: request.url,
        httpStatus: 200,
        headers: { 'content-type': 'application/json' },
        body: bytes,
        notModified: false,
        contentType: 'application/json',
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

const TAXONOMY: TaxonomyVersion = {
  taxonomyVersionId: 'tenant-live:v1',
  version: 1,
  tenantId: 'tenant-live',
  categories: [{ category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 3, enabledCountries: ['US'] }],
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

function queryFor(index: number): DiscoveryQuery {
  return {
    tenantId: 'tenant-live',
    run: {
      jobId: 'search-1',
      subjectId: 'subject-1',
      jurisdictions: ['US'],
      languages: ['en'],
      taxonomy: TAXONOMY,
    },
    queryId: `q${String(index)}`,
    family: 'F3',
    text: `"Jon P. Kipp" term-${String(index)}`,
    language: 'en',
    country: 'US',
    window: null,
    limit: 25,
  };
}

describe('the GDELT connector still reports one request per query, unaffected by pacing', () => {
  it('issues one request per eligible query against distinct endpoints, and merges none', async () => {
    const time = fakeTime();
    const reader: SourceVersionReader = {
      loadActive: () => Promise.resolve(gdeltVersion(0.2)),
      loadActiveByDomain: () => Promise.resolve(null),
    };
    const fetch = new TimedFetch(time.now);
    const log = new DiscoveryRequestLog();
    const adapter = new GdeltDiscoveryAdapter({
      sourceId: GDELT_DOC_V2_SOURCE_ID,
      versions: reader,
      gate: new FetchGateService(reader, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      fetch,
      clock: () => NOW,
      requestLog: log,
    });

    for (let i = 0; i < 4; i += 1) {
      await adapter.discover(queryFor(i));
    }

    // One request per eligible query. Pacing waits; it never drops.
    expect(fetch.requests).toHaveLength(4);
    // Distinct queries were not collapsed into one endpoint.
    expect(new Set(fetch.requests.map((request) => request.url)).size).toBe(4);
    const sent = [...fetch.requests];
    for (const [i, request] of sent.entries()) {
      expect(new URL(request.url).searchParams.get('query')).toBe(
        `"Jon P. Kipp" term-${String(i)}`,
      );
    }

    // The counts a reader of the findings response sees. These are how a QUERY_FEED is told from
    // a FIXED_FEED, and pacing must leave all three exactly as they were.
    const summary = log.summaryFor('search-1');
    const gdelt = summary.sources.find((s) => s.sourceId === GDELT_DOC_V2_SOURCE_ID);
    expect(gdelt?.requestsIssued).toBe(4);
    expect(gdelt?.distinctEndpoints).toBe(4);
    expect(gdelt?.servedWithoutRequest).toBe(0);
  });

  it('carries the recorded ceiling through to the authorisation the fetch adapter paces on', async () => {
    // The connector does not pace; it authorises. What it must do is put the approved ceiling on
    // the authorisation, because that is the only thing `HttpEvidenceFetchAdapter` can read it
    // from at the moment the socket opens.
    const reader: SourceVersionReader = {
      loadActive: () => Promise.resolve(gdeltVersion(0.2)),
      loadActiveByDomain: () => Promise.resolve(null),
    };
    const fetch = new TimedFetch(() => 0);
    const adapter = new GdeltDiscoveryAdapter({
      sourceId: GDELT_DOC_V2_SOURCE_ID,
      versions: reader,
      gate: new FetchGateService(reader, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      fetch,
      clock: () => NOW,
    });

    await adapter.discover(queryFor(0));

    expect(fetch.authorisations).toHaveLength(1);
    expect(fetch.authorisations[0]?.requestCeilingPerSecond).toBe(0.2);
  });

  it('counts a request refused before the socket as served-without-request, not as traffic', async () => {
    // The regression this guards is from the 2026-09-18 live run. Every GDELT query was refused
    // inside the fetch adapter by a domain cooldown, so nothing reached the publisher — and the
    // findings response still reported requestsIssued 53 against a recorded budget of 24. A count
    // that says we sent 53 requests a publisher never saw is worse than no count at all: it is
    // the number an operator would use to answer "did we exceed their limit?".
    const reader: SourceVersionReader = {
      loadActive: () => Promise.resolve(gdeltVersion(0.2)),
      loadActiveByDomain: () => Promise.resolve(null),
    };
    const log = new DiscoveryRequestLog();
    const refusing: EvidenceFetchPort = {
      descriptor: FETCH_DESCRIPTOR,
      fetch: () =>
        Promise.resolve(
          failed(
            FETCH_DESCRIPTOR,
            NOW,
            { policyRefusal: true },
            'api.gdeltproject.org is in a cooldown after a RATE_LIMITED. No request was made.',
          ),
        ),
      robotsPositionFor: () => Promise.resolve('ALLOWED' as const),
    };
    const adapter = new GdeltDiscoveryAdapter({
      sourceId: GDELT_DOC_V2_SOURCE_ID,
      versions: reader,
      gate: new FetchGateService(reader, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      fetch: refusing,
      clock: () => NOW,
      requestLog: log,
    });

    for (let i = 0; i < 5; i += 1) {
      await adapter.discover(queryFor(i));
    }

    const gdelt = log
      .summaryFor('search-1')
      .sources.find((x) => x.sourceId === GDELT_DOC_V2_SOURCE_ID);
    expect(gdelt?.queriesOffered).toBe(5);
    // Nothing reached the publisher, so nothing is counted as having been sent to them.
    expect(gdelt?.requestsIssued).toBe(0);
    expect(gdelt?.distinctEndpoints).toBe(0);
    expect(gdelt?.servedWithoutRequest).toBe(5);
  });

  it('records no ceiling on the authorisation when the version records none', async () => {
    const reader: SourceVersionReader = {
      loadActive: () => Promise.resolve(gdeltVersion(null)),
      loadActiveByDomain: () => Promise.resolve(null),
    };
    const fetch = new TimedFetch(() => 0);
    const adapter = new GdeltDiscoveryAdapter({
      sourceId: GDELT_DOC_V2_SOURCE_ID,
      versions: reader,
      gate: new FetchGateService(reader, 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      fetch,
      clock: () => NOW,
    });

    await adapter.discover(queryFor(0));
    expect(fetch.authorisations[0]?.requestCeilingPerSecond).toBeNull();
  });
});
