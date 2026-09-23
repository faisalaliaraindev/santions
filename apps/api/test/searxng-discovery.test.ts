/**
 * The multi-engine SearXNG discovery connector — rung 5.
 *
 * The milestone objective this file protects, in one sentence: **every engine is independently
 * observable and independently fallible, and no individual engine can block adverse search.**
 * Each block below is one way that could quietly stop being true.
 *
 * 1. **Three parse outcomes, not two.** A body that is not JSON, JSON with no `results` array,
 *    and an empty `results` array are three different facts, and only the last means "nothing was
 *    found". Collapsing them turns a shape change into confident clean results for every subject
 *    searched afterwards (T84).
 * 2. **Two axes per engine.** `integrated` and the tenant's switch are independent, and a
 *    switched-off engine still produces a `DISABLED_BY_POLICY` row rather than vanishing.
 * 3. **Independent execution.** One engine timing out, blocked on a CAPTCHA or refusing does not
 *    remove another engine's results, and never fails the source on its own.
 * 4. **Derived source outcome.** `COMPLETED` / `PARTIAL` / `FAILED` / `REFUSED` computed from the
 *    engine rows, with zero results never counted as a failure.
 * 5. **Attribution survives the merge.** One article three engines returned keeps all three engine
 *    names and remains one candidate — never three.
 * 6. **Nothing classifies.** A lead carries no category by construction, and the conduct term in
 *    the query text never reaches the record.
 * 7. **The gate is not optional**, and the publisher is the article's host, never the instance.
 *
 * **Nothing here opens a socket.** The transport is injected and returns canned bodies per engine.
 */

import { describe, expect, it } from 'vitest';

import type { TaxonomyVersion } from '@erly/adverse-domain';

import { FetchGateService } from '../src/sources/fetch-gate.service.js';
import type { DiscoveryQuery } from '../src/sources/lead.js';
import { SEARXNG_SOURCE_ID } from '../src/sources/registry/searxng-adverse-media.js';
import {
  defaultResolvedEngines,
  type EngineEnablementPort,
  type ResolvedEngine,
} from '../src/sources/searxng/engine-enablement.service.js';
import {
  SearxngEngineLog,
  classifyEngineFailure,
  deriveSourceOutcome,
  engineAnswered,
  engineAttempted,
  engineFailed,
  worstOutcome,
  type EngineOutcome,
} from '../src/sources/searxng/engine-health.js';
import {
  ALL_ENGINES,
  ENGINE_GOVERNANCE,
  engineFromSearxngName,
  integratedEngines,
} from '../src/sources/searxng/engine-governance.js';
import {
  SearxngClient,
  parseEnabledEngineNames,
  parseSearxngResponse,
  validateSearxngBaseUrl,
  type SearxngTransport,
  type SearxngTransportResult,
} from '../src/sources/searxng/searxng-client.js';
import {
  DEFAULT_SEARXNG_LIMITS,
  SearxngDiscoveryAdapter,
} from '../src/sources/searxng/searxng-discovery.adapter.js';
import type {
  ActiveSourceVersion,
  SourceVersionReader,
} from '../src/sources/source-version.service.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const CONTACT = 'https://erlystage.com/bots/adverse-search';
const BASE = 'http://127.0.0.1:28888';

/**
 * An approved version of the internal service.
 *
 * `firstContactApproval: null` and `robotsPosition: 'NOT_ESTABLISHED'` are the two fields that
 * refuse every publisher in this registry. They are left exactly as the real record carries them,
 * so the tests prove the internal path authorises **despite** them rather than being handed a
 * version dressed up as a publisher.
 */
const VERSION: ActiveSourceVersion = {
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
};

const TAXONOMY: TaxonomyVersion = {
  taxonomyVersionId: 'tax-1',
  version: 1,
  tenantId: 'tenant-1',
  categories: [
    { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 1, enabledCountries: ['US'] },
    { category: 'BRIBERY_CORRUPTION', severityWeight: 1, enabledCountries: ['US'] },
  ],
  lexicon: [],
  languages: [{ language: 'en', measuredRecall: null, measuredByEvaluationRunId: null }],
  status: 'ACTIVE',
  proposedBy: 'test',
  approvedBy: 'test',
  activatedAt: NOW.toISOString(),
};

function versions(active: ActiveSourceVersion | null = VERSION): SourceVersionReader {
  return {
    loadActive: (sourceId: string): Promise<ActiveSourceVersion | null> =>
      Promise.resolve(sourceId === SEARXNG_SOURCE_ID ? active : null),
    loadActiveByDomain: (): Promise<ActiveSourceVersion | null> => Promise.resolve(null),
  };
}

function gate(active: ActiveSourceVersion | null = VERSION): FetchGateService {
  return new FetchGateService(versions(active), 'LIVE', {
    mode: 'LIVE',
    contactUrl: CONTACT,
    region: 'eu-west-2',
  });
}

/**
 * Engine switches, without Mongo.
 *
 * Takes the engines to turn ON; everything else in the matrix is off but still present, which is
 * the state the `DISABLED_BY_POLICY` assertions depend on.
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

/**
 * A transport that answers per engine, and records every URL it was asked for.
 *
 * Keyed on the `engines` parameter, because the connector now issues one request per engine —
 * which is exactly what makes per-engine scripting possible and is the property under test.
 */
class PerEngineTransport implements SearxngTransport {
  readonly urls: string[] = [];
  constructor(private readonly replies: Readonly<Record<string, SearxngTransportResult>>) {}
  send(input: { url: string; timeoutMs: number }): Promise<SearxngTransportResult> {
    this.urls.push(input.url);
    const engine = new URL(input.url).searchParams.get('engines') ?? '';
    return Promise.resolve(
      this.replies[engine] ?? {
        kind: 'FAILURE',
        code: 'ECONNREFUSED',
        detail: `no scripted reply for ${engine}`,
      },
    );
  }
  /** Which engines were actually put on the wire, in request order. */
  enginesAsked(): readonly string[] {
    return this.urls.map((url) => new URL(url).searchParams.get('engines') ?? '');
  }
}

function body(payload: unknown): SearxngTransportResult {
  return { kind: 'RESPONSE', status: 200, body: JSON.stringify(payload) };
}

/** A response carrying `n` results attributed to exactly the engine that was asked. */
function resultsFor(engineName: string, urls: readonly string[]): SearxngTransportResult {
  return body({
    query: 'q',
    results: urls.map((url, index) => ({
      url,
      title: `Story ${String(index)}`,
      content: 'A snippet the publisher wrote.',
      engine: engineName,
      engines: [engineName],
      publishedDate: '2026-09-01T11:19:57+00:00',
      score: 1,
      category: 'news',
    })),
    unresponsive_engines: [],
  });
}

/** A response in which the instance reports the engine as unresponsive. */
function unresponsive(engineName: string, reason: string): SearxngTransportResult {
  return body({ query: 'q', results: [], unresponsive_engines: [[engineName, reason]] });
}

function queryFor(text = '"John Smith" fraud'): DiscoveryQuery {
  return {
    tenantId: 'tenant-1',
    run: {
      jobId: 'search-1',
      subjectId: 'subject-1',
      jurisdictions: ['US'],
      languages: ['en'],
      taxonomy: TAXONOMY,
    },
    queryId: 'q-1',
    family: 'F3',
    text,
    language: 'en',
    country: 'US',
    window: null,
    limit: 25,
  };
}

function adapterWith(
  transport: SearxngTransport,
  enablement: EngineEnablementPort,
  overrides: {
    readonly active?: ActiveSourceVersion | null;
    readonly client?: SearxngClient | null;
  } = {},
): { adapter: SearxngDiscoveryAdapter; engineLog: SearxngEngineLog } {
  const base = validateSearxngBaseUrl(BASE);
  if (base.kind !== 'OK') {
    throw new Error('the fixture base URL must validate');
  }
  const engineLog = new SearxngEngineLog();
  const active = overrides.active === undefined ? VERSION : overrides.active;
  const adapter = new SearxngDiscoveryAdapter({
    sourceId: SEARXNG_SOURCE_ID,
    versions: versions(active),
    gate: gate(active),
    client:
      overrides.client === undefined ? new SearxngClient(base.base, transport) : overrides.client,
    enablement,
    engineLog,
    clock: () => NOW,
  });
  return { adapter, engineLog };
}

const REUTERS = 'https://www.reuters.com/legal/smith-fraud-2026-09-01/';
const AP = 'https://apnews.com/article/smith-fraud';
const WIKI = 'https://en.wikinews.org/wiki/Smith_sentencing';

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

describe('three parse outcomes, not two', () => {
  it('parses a realistic response, keeping the fields some engines omit as null', () => {
    const parsed = parseSearxngResponse(
      JSON.stringify({
        query: '"John Smith" fraud',
        results: [
          {
            url: REUTERS,
            title: 'John Smith convicted of wire fraud',
            content: 'A federal jury convicted John Smith on Tuesday.',
            engine: 'bing news',
            engines: ['bing news'],
            publishedDate: '2026-09-01T11:19:57+00:00',
            score: 2.5,
            category: 'news',
          },
          {
            url: WIKI,
            title: 'Smith sentencing scheduled',
            // Several engines return no snippet and no date at all.
            content: null,
            engine: 'wikinews',
            engines: ['wikinews'],
            publishedDate: null,
            score: 0.5,
            category: 'news',
          },
        ],
        unresponsive_engines: [['google news', 'Suspended: CAPTCHA']],
      }),
    );
    expect(parsed.kind).toBe('OK');
    if (parsed.kind !== 'OK') {
      return;
    }
    const [first, second] = parsed.response.results;
    expect(first?.score).toBe(2.5);
    expect(first?.category).toBe('news');
    expect(second?.content).toBeNull();
    expect(second?.publishedDate).toBeNull();
    expect(parsed.response.unresponsiveEngines).toEqual([
      { engine: 'google news', reason: 'Suspended: CAPTCHA' },
    ]);
  });

  it('treats an empty results array as a genuine empty answer', () => {
    const parsed = parseSearxngResponse(JSON.stringify({ query: 'x', results: [] }));
    expect(parsed.kind).toBe('OK');
    if (parsed.kind === 'OK') {
      expect(parsed.response.results).toHaveLength(0);
    }
  });

  it('reports a body that is not JSON as UNPARSABLE, never as no results', () => {
    expect(parseSearxngResponse('<!doctype html><html></html>').kind).toBe('UNPARSABLE');
  });

  it('reports JSON with no results array as UNRECOGNISED, never as no results', () => {
    // The dangerous one: zero results from a working transport is indistinguishable from "this
    // person is not in the news", and it would read that way for every subject afterwards.
    const parsed = parseSearxngResponse(JSON.stringify({ query: 'x', answers: [] }));
    expect(parsed.kind).toBe('UNRECOGNISED');
    if (parsed.kind === 'UNRECOGNISED') {
      expect(parsed.detail).toContain('results');
    }
  });

  it('reads the instance engine list rather than assuming it', () => {
    expect(
      parseEnabledEngineNames(
        JSON.stringify({
          engines: [
            { name: 'wikinews', enabled: true },
            { name: 'google news', enabled: false },
          ],
        }),
      ),
    ).toEqual(['wikinews']);
    // Null, not an empty list: "could not be read" and "the instance has no engines" are
    // different claims and the second is much stronger.
    expect(parseEnabledEngineNames('not json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The two axes
// ---------------------------------------------------------------------------------------------

describe('integration and permission are independent', () => {
  it('integrates every engine the milestone names', () => {
    expect([...ALL_ENGINES].toSorted()).toEqual([
      'BING_NEWS',
      'BRAVE_NEWS',
      'DUCKDUCKGO_NEWS',
      'GOOGLE_NEWS',
      'REUTERS',
      'WIKINEWS',
    ]);
    for (const record of integratedEngines()) {
      expect(record.integrated).toBe(true);
      // Every engine carries a governance reading, a decision id and a real evidence note —
      // including the ones nobody has reviewed, where the note says so.
      expect(record.decisionId).not.toBe('');
      expect(record.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(record.evidenceNote.length).toBeGreaterThan(80);
      expect(['PERMITTED', 'REFUSED', 'PENDING']).toContain(record.governanceStatus);
    }
  });

  it('keeps the governance reading separate from the switch', () => {
    // The property that makes the control API safe: nothing computes one from the other. Google
    // stays integrated and fully reported while its reading is REFUSED, rather than being
    // deleted from the matrix by the refusal.
    //
    // Its default switch is separately OFF (2026-09-22) — the two gates are independent, and
    // `searxng-google-default-off.test.ts` holds that one against a simulated permitted reading.
    const google = ENGINE_GOVERNANCE.GOOGLE_NEWS;
    expect(google.integrated).toBe(true);
    expect(google.governanceStatus).toBe('REFUSED');
    expect(google.decisionId).toBe('D20');
    expect(google.reviewedBy).not.toBeNull();
    expect(google.defaultEnabledForDiscovery).toBe(false);
  });

  it('ties the reviewer to the reading in both directions', () => {
    // Since the D21 approval of 2026-09-22 no engine is PENDING, so the first half of this
    // invariant now guards an empty set. The second half is what carries it: a decided reading
    // must name the person who decided, or it is an approval nobody can point at. Asserting
    // both directions keeps the test load-bearing if an engine is ever added as PENDING.
    let decided = 0;
    for (const record of integratedEngines()) {
      if (record.governanceStatus === 'PENDING') {
        // An approval that names nobody is not one.
        expect(record.reviewedBy).toBeNull();
      } else {
        decided += 1;
        expect(record.reviewedBy).not.toBeNull();
        expect(record.reviewedBy?.trim()).not.toBe('');
      }
    }
    // All six are decided today: one REFUSED under D20, five PERMITTED under D21.
    expect(decided).toBe(6);
  });

  it('reports the tenant switch and policy-enforced execution state separately', () => {
    // Google: default switch off AND refused. Both gates shut, for different reasons.
    const google = defaultResolvedEngines().find((engine) => engine.engine === 'GOOGLE_NEWS');
    expect(google?.tenantEnabled).toBe(false);
    expect(google?.governanceStatus).toBe('REFUSED');
    expect(google?.effectiveEnabled).toBe(false);

    // Reuters: switch on and permitted, so the two fields are genuinely reporting different
    // things here rather than both happening to be false.
    const reuters = defaultResolvedEngines().find((engine) => engine.engine === 'REUTERS');
    expect(reuters?.tenantEnabled).toBe(true);
    expect(reuters?.governanceStatus).toBe('PERMITTED');
    expect(reuters?.effectiveEnabled).toBe(true);
  });

  it('maps the instance engine names back to our vocabulary, and refuses unknown ones', () => {
    expect(engineFromSearxngName('google news')).toBe('GOOGLE_NEWS');
    expect(engineFromSearxngName('Brave.News')).toBe('BRAVE_NEWS');
    expect(engineFromSearxngName('yandex')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Independent execution
// ---------------------------------------------------------------------------------------------

describe('engines are queried independently', () => {
  it('issues one request per permitted engine, naming that engine and no category', async () => {
    // The audit finding this encodes: SearXNG treats `engines` and `categories` as a UNION, so a
    // request naming the news category would run every news engine regardless of the switches.
    const transport = new PerEngineTransport({
      reuters: resultsFor('reuters', [REUTERS]),
      wikinews: resultsFor('wikinews', [WIKI]),
    });
    const { adapter } = adapterWith(transport, enablementFor('REUTERS', 'WIKINEWS'));

    await adapter.discover(queryFor());

    expect(transport.enginesAsked().toSorted()).toEqual(['reuters', 'wikinews']);
    for (const url of transport.urls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.has('categories')).toBe(false);
      expect(parsed.searchParams.get('format')).toBe('json');
      // One engine per request — that is what makes per-engine timing and isolation possible.
      expect(parsed.searchParams.get('engines')?.includes(',')).toBe(false);
    }
  });

  it('never puts a switched-off engine on the wire, but still reports it', async () => {
    const transport = new PerEngineTransport({ wikinews: resultsFor('wikinews', [WIKI]) });
    const { adapter, engineLog } = adapterWith(transport, enablementFor('WIKINEWS'));

    await adapter.discover(queryFor());

    expect(transport.enginesAsked()).toEqual(['wikinews']);

    const summary = engineLog.summaryFor('search-1');
    // Every integrated engine is in the table. Absence is never how a disabled engine is shown.
    expect(summary?.enginesConfigured).toBe(6);
    expect(summary?.enginesPermitted).toBe(1);
    expect(summary?.enginesAttempted).toBe(1);
    expect(summary?.perEngine).toHaveLength(6);

    const google = summary?.perEngine.find((stat) => stat.engine === 'GOOGLE_NEWS');
    expect(google?.attempted).toBe(false);
    expect(google?.outcome).toBe('DISABLED_BY_POLICY');
    expect(google?.resultsReturned).toBe(0);
    // And it names the decision, so "why is Google not here?" has an answer in the response.
    expect(google?.decisionId).toBe('D20');
    expect(google?.failureReasons.join(' ')).toContain('D20');
  });

  it('keeps every other engine when one times out, one is blocked and one refuses', async () => {
    // The §14 scenario, end to end. Three engines fail in three different ways and two answer.
    const transport = new PerEngineTransport({
      reuters: { kind: 'FAILURE', code: 'ETIMEDOUT', detail: 'No complete response in 15000ms.' },
      'brave.news': {
        kind: 'FAILURE',
        code: 'ECONNREFUSED',
        detail: 'connect ECONNREFUSED',
      },
      'google news': unresponsive('google news', 'Suspended: CAPTCHA'),
      'bing news': resultsFor('bing news', [REUTERS, AP]),
      wikinews: resultsFor('wikinews', [WIKI]),
    });
    const { adapter, engineLog } = adapterWith(
      transport,
      enablementFor('REUTERS', 'BRAVE_NEWS', 'GOOGLE_NEWS', 'BING_NEWS', 'WIKINEWS'),
    );

    const outcome = await adapter.discover(queryFor());

    // The source is NOT failed: two engines answered and their candidates survive intact.
    expect(outcome.status).toBe('OK');
    if (!('data' in outcome)) {
      throw new Error('expected leads');
    }
    expect(outcome.data.map((lead) => lead.url).toSorted()).toEqual([AP, REUTERS, WIKI].toSorted());

    const summary = engineLog.summaryFor('search-1');
    expect(summary?.sourceOutcome).toBe('PARTIAL');
    expect(summary?.enginesAttempted).toBe(4);
    expect(summary?.enginesReturnedResults).toBe(2);
    expect(summary?.enginesFailed).toBe(2);

    const outcomes = Object.fromEntries(
      (summary?.perEngine ?? []).map((stat) => [stat.engine, stat.outcome]),
    );
    expect(outcomes['REUTERS']).toBe('TIMEOUT');
    expect(outcomes['BRAVE_NEWS']).toBe('CONNECTION_ERROR');
    expect(outcomes['GOOGLE_NEWS']).toBe('DISABLED_BY_POLICY');
    expect(outcomes['BING_NEWS']).toBe('RETURNED_RESULTS');
    expect(outcomes['WIKINEWS']).toBe('RETURNED_RESULTS');
    // The engine switched off entirely is still a row, distinct from the ones that failed.
    expect(outcomes['DUCKDUCKGO_NEWS']).toBe('DISABLED_BY_POLICY');
  });

  it('records a duration and a result count for every engine', async () => {
    const transport = new PerEngineTransport({
      'bing news': resultsFor('bing news', [REUTERS, AP]),
      wikinews: resultsFor('wikinews', [WIKI]),
    });
    const { adapter, engineLog } = adapterWith(transport, enablementFor('BING_NEWS', 'WIKINEWS'));
    await adapter.discover(queryFor());

    const summary = engineLog.summaryFor('search-1');
    const bing = summary?.perEngine.find((stat) => stat.engine === 'BING_NEWS');
    expect(bing?.resultsReturned).toBe(2);
    expect(bing?.queriesAttempted).toBe(1);
    expect(bing?.queriesReturnedResults).toBe(1);
    expect(bing?.durationMs).toBeGreaterThanOrEqual(0);
    // A per-engine duration is only obtainable because each engine got its own request.
    expect(typeof bing?.durationMs).toBe('number');
  });

  it('distinguishes an engine that answered with nothing from one that failed', async () => {
    // `ZERO_RESULTS` is a working engine reporting a fact. Counting it as a failure is the
    // false-outage this whole vocabulary exists to prevent.
    const transport = new PerEngineTransport({
      'bing news': resultsFor('bing news', []),
      wikinews: resultsFor('wikinews', []),
    });
    const { adapter, engineLog } = adapterWith(transport, enablementFor('BING_NEWS', 'WIKINEWS'));

    const outcome = await adapter.discover(queryFor());
    expect(outcome.status).toBe('NO_RESULTS');

    const summary = engineLog.summaryFor('search-1');
    expect(summary?.sourceOutcome).toBe('COMPLETED');
    expect(summary?.enginesFailed).toBe(0);
    expect(summary?.perEngine.find((s) => s.engine === 'BING_NEWS')?.outcome).toBe('ZERO_RESULTS');
  });

  it('fails the source only when every attempted engine failed', async () => {
    const transport = new PerEngineTransport({
      'bing news': { kind: 'FAILURE', code: 'ECONNREFUSED', detail: 'refused' },
      wikinews: { kind: 'FAILURE', code: 'ETIMEDOUT', detail: 'timed out' },
    });
    const { adapter, engineLog } = adapterWith(transport, enablementFor('BING_NEWS', 'WIKINEWS'));

    const outcome = await adapter.discover(queryFor());
    expect(outcome.status).toBe('FAILED');
    expect(engineLog.summaryFor('search-1')?.sourceOutcome).toBe('FAILED');
  });

  it('discards a result credited to an engine the request did not name', async () => {
    // If the instance ever widens a request, the extra engine's work must not be silently
    // attributed to the engine we asked for — that would make the per-engine table a fiction.
    const transport = new PerEngineTransport({
      wikinews: body({
        query: 'q',
        results: [
          {
            url: REUTERS,
            title: 'Leaked in from somewhere else',
            content: null,
            engine: 'google news',
            engines: ['google news'],
            publishedDate: null,
            score: 1,
            category: 'news',
          },
        ],
        unresponsive_engines: [],
      }),
    });
    const { adapter, engineLog } = adapterWith(transport, enablementFor('WIKINEWS'));

    const outcome = await adapter.discover(queryFor());
    expect(outcome.status).toBe('NO_RESULTS');
    expect(
      engineLog.summaryFor('search-1')?.perEngine.find((s) => s.engine === 'WIKINEWS')?.outcome,
    ).toBe('ZERO_RESULTS');
  });
});

// ---------------------------------------------------------------------------------------------
// The outcome vocabulary
// ---------------------------------------------------------------------------------------------

describe('outcome vocabulary', () => {
  it('classifies the instance failure sentences, and keeps unknown ones readable', () => {
    expect(classifyEngineFailure('Suspended: CAPTCHA')).toBe('CAPTCHA');
    expect(classifyEngineFailure('HTTP error 403 Forbidden')).toBe('ACCESS_DENIED');
    expect(classifyEngineFailure('Too many requests')).toBe('RATE_LIMITED');
    expect(classifyEngineFailure('timeout')).toBe('TIMEOUT');
    expect(classifyEngineFailure('HTTP connection error')).toBe('CONNECTION_ERROR');
    expect(classifyEngineFailure('Suspended: too many errors')).toBe('RATE_LIMITED');
    // SearXNG's bare "HTTP error" carries no status. It is still the upstream's failure, and
    // INTERNAL_ERROR would put our name on it. Seen live from the `reuters` engine.
    expect(classifyEngineFailure('HTTP error')).toBe('CONNECTION_ERROR');
    // Unknown becomes INTERNAL_ERROR **and the sentence is carried**, which is why nothing in
    // the pipeline is allowed to read this classification.
    expect(classifyEngineFailure('something new upstream')).toBe('INTERNAL_ERROR');
  });

  it('separates answered, attempted and failed correctly', () => {
    expect(engineAnswered('ZERO_RESULTS')).toBe(true);
    expect(engineFailed('ZERO_RESULTS')).toBe(false);
    expect(engineAttempted('DISABLED_BY_POLICY')).toBe(false);
    expect(engineFailed('DISABLED_BY_POLICY')).toBe(false);
    expect(engineFailed('NOT_CONFIGURED')).toBe(false);
    expect(engineFailed('CAPTCHA')).toBe(true);
  });

  it('reports the worst outcome an engine had, not the last', () => {
    // An engine that answered nine queries and was rate-limited on the tenth is RATE_LIMITED for
    // the run: that is the fact that changes what a reader should do.
    expect(worstOutcome(['RETURNED_RESULTS', 'RATE_LIMITED', 'RETURNED_RESULTS'])).toBe(
      'RATE_LIMITED',
    );
    // Between the two non-failure outcomes the more informative one wins: an engine that
    // returned hits on some queries and nothing on others DID return results, and reporting it
    // as ZERO_RESULTS reads as "this engine found nothing". A failure still outranks both.
    expect(worstOutcome(['RETURNED_RESULTS', 'ZERO_RESULTS'])).toBe('RETURNED_RESULTS');
    expect(worstOutcome(['ZERO_RESULTS', 'ZERO_RESULTS'])).toBe('ZERO_RESULTS');
    expect(worstOutcome(['RETURNED_RESULTS', 'ZERO_RESULTS', 'TIMEOUT'])).toBe('TIMEOUT');
    expect(worstOutcome(['CAPTCHA', 'TIMEOUT'])).toBe('CAPTCHA');
  });

  it('derives the source outcome from the engine rows', () => {
    const row = (
      attempted: boolean,
      outcome: EngineOutcome,
    ): { attempted: boolean; outcome: EngineOutcome } => ({
      attempted,
      outcome,
    });
    // Nothing attempted is REFUSED, not FAILED: nothing failed.
    expect(deriveSourceOutcome([row(false, 'DISABLED_BY_POLICY')])).toBe('REFUSED');
    expect(deriveSourceOutcome([row(true, 'RETURNED_RESULTS')])).toBe('COMPLETED');
    // Zero results is never a failure.
    expect(deriveSourceOutcome([row(true, 'ZERO_RESULTS')])).toBe('COMPLETED');
    expect(deriveSourceOutcome([row(true, 'RETURNED_RESULTS'), row(true, 'CAPTCHA')])).toBe(
      'PARTIAL',
    );
    expect(deriveSourceOutcome([row(true, 'TIMEOUT'), row(true, 'CAPTCHA')])).toBe('FAILED');
    // A disabled engine alongside working ones does not drag the source down.
    expect(
      deriveSourceOutcome([row(false, 'DISABLED_BY_POLICY'), row(true, 'RETURNED_RESULTS')]),
    ).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------------------------
// Attribution and deduplication
// ---------------------------------------------------------------------------------------------

describe('multi-engine attribution and deduplication', () => {
  it('keeps every engine on one candidate rather than making one candidate per engine', async () => {
    // Three engines return the same Reuters article. That is ONE evidence item with three
    // channels, never three findings — the independence inflation FR-10 exists to prevent.
    const transport = new PerEngineTransport({
      'bing news': resultsFor('bing news', [REUTERS]),
      'brave.news': resultsFor('brave.news', [REUTERS]),
      'google news': resultsFor('google news', [REUTERS]),
    });
    const { adapter, engineLog } = adapterWith(
      transport,
      enablementFor('BING_NEWS', 'BRAVE_NEWS', 'GOOGLE_NEWS'),
    );

    const outcome = await adapter.discover(queryFor());
    if (!('data' in outcome)) {
      throw new Error('expected leads');
    }
    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]?.discovery?.discoveryEngines).toEqual(['BING_NEWS', 'BRAVE_NEWS']);

    const summary = engineLog.summaryFor('search-1');
    expect(summary?.totalRawResults).toBe(2);
    expect(summary?.uniqueCandidateUrls).toBe(1);
    // Stated rather than left to be subtracted. This is the number that proves the merge ran.
    expect(summary?.duplicatesCollapsed).toBe(1);
    expect(summary?.perEngine.find((stat) => stat.engine === 'GOOGLE_NEWS')?.outcome).toBe(
      'DISABLED_BY_POLICY',
    );
    // And no engine gets credit for a unique contribution it did not make.
    for (const stat of summary?.perEngine ?? []) {
      expect(stat.uniqueResultsContributed).toBe(0);
    }
  });

  it('credits a unique contribution to the only engine that found it', async () => {
    const transport = new PerEngineTransport({
      'bing news': resultsFor('bing news', [REUTERS, AP]),
      wikinews: resultsFor('wikinews', [REUTERS, WIKI]),
    });
    const { adapter, engineLog } = adapterWith(transport, enablementFor('BING_NEWS', 'WIKINEWS'));
    await adapter.discover(queryFor());

    const summary = engineLog.summaryFor('search-1');
    // Reuters came from both, so it is nobody's unique contribution. AP is Bing's alone and the
    // wiki article is Wikinews's alone.
    expect(summary?.perEngine.find((s) => s.engine === 'BING_NEWS')?.uniqueResultsContributed).toBe(
      1,
    );
    expect(summary?.perEngine.find((s) => s.engine === 'WIKINEWS')?.uniqueResultsContributed).toBe(
      1,
    );
    expect(summary?.uniqueCandidateUrls).toBe(3);
  });

  it('collapses the same article returned under different tracking parameters', async () => {
    const transport = new PerEngineTransport({
      'bing news': resultsFor('bing news', [`${REUTERS}?utm_source=bing&utm_campaign=news`]),
      wikinews: resultsFor('wikinews', [`${REUTERS}?fbclid=abc`]),
    });
    const { adapter, engineLog } = adapterWith(transport, enablementFor('BING_NEWS', 'WIKINEWS'));

    const outcome = await adapter.discover(queryFor());
    if (!('data' in outcome)) {
      throw new Error('expected leads');
    }
    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]?.discovery?.discoveryEngines).toEqual(['BING_NEWS', 'WIKINEWS']);
    expect(engineLog.summaryFor('search-1')?.duplicatesCollapsed).toBe(1);
  });

  it('names the internal service as the discovery source and the article host as the publisher', async () => {
    const transport = new PerEngineTransport({ 'bing news': resultsFor('bing news', [REUTERS]) });
    const { adapter } = adapterWith(transport, enablementFor('BING_NEWS'));

    const outcome = await adapter.discover(queryFor());
    if (!('data' in outcome)) {
      throw new Error('expected leads');
    }
    const lead = outcome.data[0];
    expect(lead?.discovery?.discoverySource).toBe(SEARXNG_SOURCE_ID);
    // SearXNG is never the evidence publisher, and neither is the engine.
    expect(lead?.publisher).toBe('www.reuters.com');
    expect(lead?.publisher).not.toContain('searxng');
    expect(lead?.publisher).not.toContain('BING');
  });

  it('never synthesises a snippet or a date', async () => {
    const transport = new PerEngineTransport({
      wikinews: body({
        query: 'q',
        results: [
          {
            url: WIKI,
            title: 'Smith sentencing scheduled',
            content: null,
            engine: 'wikinews',
            engines: ['wikinews'],
            publishedDate: null,
            score: 1,
            category: 'news',
          },
        ],
        unresponsive_engines: [],
      }),
    });
    const { adapter } = adapterWith(transport, enablementFor('WIKINEWS'));
    const outcome = await adapter.discover(queryFor());
    if (!('data' in outcome)) {
      throw new Error('expected leads');
    }
    // FR-06's relevance filter scores the snippet; an invented one would be scored as though the
    // publisher had written it. FR-07: a date nobody published is never invented.
    expect(outcome.data[0]?.snippet).toBeNull();
    expect(outcome.data[0]?.publishedAt).toEqual({ value: null, precision: 'UNKNOWN' });
  });
});

// ---------------------------------------------------------------------------------------------
// No classification from the query
// ---------------------------------------------------------------------------------------------

describe('query terms never become findings', () => {
  it('produces leads that cannot carry a category at all', async () => {
    const transport = new PerEngineTransport({ 'bing news': resultsFor('bing news', [REUTERS]) });
    const { adapter } = adapterWith(transport, enablementFor('BING_NEWS'));
    const outcome = await adapter.discover(queryFor('"John Smith" fraud bribery corruption'));
    if (!('data' in outcome)) {
      throw new Error('expected leads');
    }
    for (const lead of outcome.data) {
      const asRecord = lead as unknown as Record<string, unknown>;
      // Structural rather than a check on a value: `Lead` has no category field, so a discovery
      // adapter cannot classify and the compiler is what enforces it.
      expect(asRecord['category']).toBeUndefined();
      expect(asRecord['proceduralStage']).toBeUndefined();
      // And the query's conduct terms are nowhere on the record.
      expect(JSON.stringify(lead)).not.toContain('bribery');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

describe('the gate is not optional', () => {
  it('refuses when the tenant has every engine switched off, and sends nothing', async () => {
    // Not an empty request: a request naming no engine is served by the instance's own defaults,
    // which is the widening the matrix exists to prevent.
    const transport = new PerEngineTransport({});
    const { adapter, engineLog } = adapterWith(transport, enablementFor());

    const outcome = await adapter.discover(queryFor());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.detail).toContain('NO_ENGINE_PERMITTED');
      // Our own refusal, so it must never be recorded against the source's health.
      expect(outcome.signal).toEqual({ policyRefusal: true });
    }
    expect(transport.urls).toEqual([]);

    // Still fully reported: six rows, all DISABLED_BY_POLICY, and a REFUSED source outcome.
    const summary = engineLog.summaryFor('search-1');
    expect(summary?.sourceOutcome).toBe('REFUSED');
    expect(summary?.perEngine).toHaveLength(6);
    expect(summary?.perEngine.every((stat) => stat.outcome === 'DISABLED_BY_POLICY')).toBe(true);
  });

  it('reports NOT_CONFIGURED, not a failure, when no instance is configured', async () => {
    const transport = new PerEngineTransport({});
    const { adapter, engineLog } = adapterWith(transport, enablementFor('WIKINEWS'), {
      client: null,
    });
    const outcome = await adapter.discover(queryFor());
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.detail).toContain('INTERNAL_SERVICE_NOT_CONFIGURED');
    }
    const summary = engineLog.summaryFor('search-1');
    // A different fact from an engine that was asked and failed.
    expect(summary?.perEngine.every((stat) => stat.outcome === 'NOT_CONFIGURED')).toBe(true);
  });

  it('refuses a source with no active approved version', async () => {
    const transport = new PerEngineTransport({});
    const { adapter } = adapterWith(transport, enablementFor('WIKINEWS'), { active: null });
    const outcome = await adapter.discover(queryFor());
    expect(outcome.status).toBe('FAILED');
    expect(transport.urls).toEqual([]);
  });

  it('refuses a source recorded as a publisher connector on the internal path', async () => {
    // The check that stops this gate becoming a way past robots and first contact for a real
    // publisher. There is no argument a caller can pass that reaches it.
    const transport = new PerEngineTransport({});
    const { adapter } = adapterWith(transport, enablementFor('WIKINEWS'), {
      active: { ...VERSION, connectorType: 'NEWS_DISCOVERY_RSS' },
    });
    const outcome = await adapter.discover(queryFor());
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.detail).toContain('NOT_AN_INTERNAL_DISCOVERY_SERVICE');
    }
    expect(transport.urls).toEqual([]);
  });

  it('issues an authorisation that does not claim SEC-02 screening it did not perform', async () => {
    const decision = await gate().authoriseInternalDiscoveryService({
      sourceId: SEARXNG_SOURCE_ID,
      jurisdiction: 'US',
      language: 'en',
      runJurisdictions: ['US'],
      runLanguages: ['en'],
      taxonomy: TAXONOMY,
      serviceConfigured: true,
      permittedEngineCount: 1,
      now: NOW,
    });

    expect(decision.authorised).toBe(true);
    if (!decision.authorised) {
      return;
    }
    // Honest, not convenient. Neither half of SEC-02 ran on a hop to an address we configured.
    expect(decision.authorisation.urlPolicyPassed).toBe(false);
    expect(decision.authorisation.ssrfValidated).toBe(false);
    expect(decision.authorisation.robotsPosition).toBe('INTERNAL_SERVICE_NOT_A_PUBLISHER');
  });
});

// ---------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------

describe('bounds', () => {
  it('stops after maxQueriesPerSearch and records a bound rather than going quiet', async () => {
    const transport = new PerEngineTransport({ wikinews: resultsFor('wikinews', [WIKI]) });
    const { adapter } = adapterWith(transport, enablementFor('WIKINEWS'));

    for (let i = 0; i < DEFAULT_SEARXNG_LIMITS.maxQueriesPerSearch; i += 1) {
      await adapter.discover({ ...queryFor(), queryId: `q-${String(i)}` });
    }
    const past = await adapter.discover({ ...queryFor(), queryId: 'q-over' });
    expect(past.status).toBe('BOUNDED');
    if (past.status === 'BOUNDED') {
      expect(past.truncation.reason).toBe('BOUND_EXCEEDED');
      expect(past.truncation.limit).toBe(DEFAULT_SEARXNG_LIMITS.maxQueriesPerSearch);
    }
    // The connector stopped issuing requests at the bound rather than issuing one and discarding
    // the result. One engine enabled, so one request per query.
    expect(transport.urls).toHaveLength(DEFAULT_SEARXNG_LIMITS.maxQueriesPerSearch);
  });

  it('keeps the defaults conservative', () => {
    // A live plan is around 53 queries, so the per-search bound must sit well below it for the
    // truncation path to be exercised at all.
    expect(DEFAULT_SEARXNG_LIMITS.maxQueriesPerSearch).toBeLessThan(53);
    expect(DEFAULT_SEARXNG_LIMITS.maxPagesPerQuery).toBeLessThanOrEqual(2);
    expect(DEFAULT_SEARXNG_LIMITS.maxConcurrentEngines).toBeLessThanOrEqual(ALL_ENGINES.length);
  });
});
