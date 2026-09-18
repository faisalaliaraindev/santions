/**
 * `LadderBuilder` — what sits on the FR-05 ladder, and why.
 *
 * The rule under test is one sentence: **a source sits at the rung its approved version
 * records**, and a live RSS connector is constructed for it from that record rather than from
 * code (**D-043**, **D-045**).
 *
 * **No socket is opened.** The fetch port is injected and records what it was asked for, which is
 * the interesting part: a live connector that reaches the fetch adapter has passed the gate, and
 * one that does not has been refused for a reason this file asserts.
 */

import { describe, expect, it } from 'vitest';

import type { Db } from 'mongodb';

import { FetchGateService } from '../src/sources/fetch-gate.service.js';
import { LadderBuilder } from '../src/pipeline/ladder.builder.js';
import type { EvidenceFetchPort } from '../src/sources/evidence-fetch.port.js';
import type { AdapterDescriptor } from '../src/sources/source-adapter.js';
import type {
  ActiveSourceVersion,
  SourceVersionReader,
} from '../src/sources/source-version.service.js';
import type { SourceAdapterSet } from '../src/sources/sources.registry.js';

const CONTACT = 'https://erlystage.com/bots/adverse-search';

/** The SEC record, as `sec-litigation-releases.ts` writes it and the registry would hold it. */
const SEC_VERSION_DOCUMENT = {
  sourceId: 'sec-litigation-releases',
  status: 'ACTIVE',
  version: 1,
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
    accessPolicy: {
      endpointUrl: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss',
      endpointKind: 'FIXED_FEED',
      queryParam: null,
      firstContactApproval: {
        approvedBy: 'Faisal Ali',
        role: 'Source admin',
        approvedOn: '2026-09-15',
        decision: 'D17',
      },
    },
  },
};

/** A Mongo stand-in that returns whatever documents a test hands it. */
function dbWith(documents: readonly Record<string, unknown>[]): Db {
  return {
    collection: () => ({
      find: () => ({ toArray: () => Promise.resolve([...documents]) }),
    }),
  } as unknown as Db;
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

/** Records what it was asked to fetch. Never opens anything. */
function recordingFetch(): EvidenceFetchPort & { readonly urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    descriptor: FETCH_DESCRIPTOR,
    fetch: (request) => {
      urls.push(request.url);
      return Promise.resolve({
        status: 'NO_RESULTS' as const,
        provenance: { ...FETCH_DESCRIPTOR, retrievedAt: '2026-09-15T12:00:00.000Z' },
      });
    },
    robotsPositionFor: () => Promise.resolve('ALLOWED' as const),
  };
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

describe('a live RSS source is constructed from its approval', () => {
  it('puts the SEC feed on the ladder at the rung its version records', async () => {
    const fetch = recordingFetch();
    const builder = new LadderBuilder(dbWith([SEC_VERSION_DOCUMENT]), EMPTY_SET, {
      mode: 'LIVE',
      versions: readerFor(null),
      gate: new FetchGateService(readerFor(null), 'LIVE', {
        mode: 'LIVE',
        contactUrl: CONTACT,
      }),
      evidenceFetch: fetch,
    });

    const ladder = await builder.build();

    expect(ladder).toHaveLength(1);
    // Rung 1, because the approved version says 1 — a regulator's own enforcement archive is a
    // primary source, not web discovery. Nothing in the connector decided that.
    expect(ladder[0]?.rung).toBe(1);
    expect(ladder[0]?.sourceId).toBe('sec-litigation-releases');
    expect(ladder[0]?.sourceName).toBe('SEC litigation releases (RSS)');
  });

  it('follows the rung the registry records, not one chosen in code', async () => {
    // The same record at a different rung produces a different ladder, with no code change.
    // That is what makes the ladder configuration (D-045).
    const moved = {
      ...SEC_VERSION_DOCUMENT,
      content: { ...SEC_VERSION_DOCUMENT.content, cascadeRung: 4 },
    };
    const builder = new LadderBuilder(dbWith([moved]), EMPTY_SET, {
      mode: 'LIVE',
      versions: readerFor(null),
      gate: new FetchGateService(readerFor(null), 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      evidenceFetch: recordingFetch(),
    });

    expect((await builder.build())[0]?.rung).toBe(4);
  });

  it('builds nothing in mock mode, however the source is approved', async () => {
    // A live feed must not be readable by a mock process. The mocks in the set are the only
    // adapters a mock process has, and none of them is this source.
    const builder = new LadderBuilder(dbWith([SEC_VERSION_DOCUMENT]), EMPTY_SET, {
      mode: 'MOCK',
      versions: readerFor(null),
      gate: new FetchGateService(readerFor(null), 'MOCK', { mode: 'MOCK', contactUrl: null }),
      evidenceFetch: recordingFetch(),
    });

    expect(await builder.build()).toHaveLength(0);
  });

  it('builds nothing when this process has no evidence-fetch adapter', async () => {
    // No contact URL or no source health means no fetch adapter, and a connector with nothing to
    // fetch through cannot make a request. The rung reports unsearched rather than pretending.
    const builder = new LadderBuilder(dbWith([SEC_VERSION_DOCUMENT]), EMPTY_SET, {
      mode: 'LIVE',
      versions: readerFor(null),
      gate: new FetchGateService(readerFor(null), 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      evidenceFetch: null,
    });

    expect(await builder.build()).toHaveLength(0);
  });

  it('builds nothing for a connector type it cannot read', async () => {
    const gazette = {
      ...SEC_VERSION_DOCUMENT,
      content: { ...SEC_VERSION_DOCUMENT.content, connectorType: 'GAZETTE_PDF' },
    };
    const builder = new LadderBuilder(dbWith([gazette]), EMPTY_SET, {
      mode: 'LIVE',
      versions: readerFor(null),
      gate: new FetchGateService(readerFor(null), 'LIVE', { mode: 'LIVE', contactUrl: CONTACT }),
      evidenceFetch: recordingFetch(),
    });

    expect(await builder.build()).toHaveLength(0);
  });

  // Deliberately not tested here: that a retired version is off the ladder. The builder queries
  // `{ status: 'ACTIVE' }` and this file's Mongo stand-in returns whatever it is handed, so any
  // assertion would be testing the stand-in. It belongs in the integration suite, against a real
  // query. A test that cannot fail for the right reason is worse than no test.
});

describe('the gate still stands in front of the connector', () => {
  it('refuses the poll when nothing named a first-contact approval', async () => {
    // D-042. The source is configured, approved as a registry entry, on the ladder — and still
    // unreachable, because nobody accepted that this service would contact the publisher.
    const unapproved = {
      ...SEC_VERSION_DOCUMENT,
      content: {
        ...SEC_VERSION_DOCUMENT.content,
        accessPolicy: {
          ...SEC_VERSION_DOCUMENT.content.accessPolicy,
          firstContactApproval: null,
        },
      },
    };

    const version: ActiveSourceVersion = {
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
      firstContactApproval: null,
      endpointUrl: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss',
      endpointKind: 'FIXED_FEED',
      queryParam: null,
      pollFloorMs: 900_000,
      requestCeilingPerSecond: null,
    };

    const fetch = recordingFetch();
    const builder = new LadderBuilder(dbWith([unapproved]), EMPTY_SET, {
      mode: 'LIVE',
      versions: readerFor(version),
      gate: new FetchGateService(readerFor(version), 'LIVE', {
        mode: 'LIVE',
        contactUrl: CONTACT,
      }),
      evidenceFetch: fetch,
    });

    const ladder = await builder.build();
    expect(ladder).toHaveLength(1);

    const outcome = await ladder[0]?.ask({
      tenantId: 't-1',
      run: {
        jobId: 'job-1',
        subjectId: 'subject-1',
        jurisdictions: ['US'],
        languages: ['en'],
        taxonomy: {
          taxonomyVersionId: 't-1:v1',
          version: 1,
          tenantId: 't-1',
          categories: [
            { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['US'] },
          ],
          lexicon: [],
          languages: [{ language: 'en', measuredRecall: null, measuredByEvaluationRunId: null }],
          status: 'ACTIVE',
          proposedBy: 'test',
          approvedBy: 'test',
          activatedAt: '2026-09-15T12:00:00.000Z',
        },
      },
      queryId: 'q-1',
      family: 'F1',
      text: 'Jane Whitfield',
      language: 'en',
      country: 'US',
      window: null,
      limit: 25,
    });

    expect(outcome?.status).toBe('FAILED');
    if (outcome?.status === 'FAILED') {
      expect(outcome.detail).toContain('NO_FIRST_CONTACT_APPROVAL');
    }
    // The assertion that matters most: being on the ladder is not permission. Nothing was
    // fetched, so no request reached the publisher.
    expect(fetch.urls).toHaveLength(0);
  });
});
