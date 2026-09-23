/**
 * The local Google diagnostic — every condition required, nothing persisted, D20 untouched.
 *
 * What this file protects, one property per block:
 *
 * 1–5. **No condition is optional.** Production, a non-loopback request, the missing flag, the
 *      wrong tenant, a missing or wrong header — each alone refuses (or, for a missing header,
 *      leaves the search a normal one).
 * 6–7. **Nothing is persisted.** The real `EngineEnablementService` over an in-memory collection
 *      sees no write during a diagnostic run, and resolves Google disabled afterwards.
 * 8.   **A normal search cannot execute Google**, even in a process with the flag set.
 * 9.   **A granted diagnostic run executes Google**, through the real connector.
 * 10.  **The engine diagnostics say so** — GOOGLE_NEWS attempted, `diagnosticOverride`, and the
 *      governance reading still REFUSED beside it.
 *
 * **Nothing here opens a socket.** The SearXNG transport is injected.
 */

import { describe, expect, it } from 'vitest';

import type { Db } from 'mongodb';

import type { TaxonomyVersion } from '@erly/adverse-domain';

import { loadConfig } from '../src/config/config.js';
import { FetchGateService } from '../src/sources/fetch-gate.service.js';
import type { DiscoveryQuery } from '../src/sources/lead.js';
import { SEARXNG_SOURCE_ID } from '../src/sources/registry/searxng-adverse-media.js';
import {
  EngineEnablementService,
  type StoredEngineSetting,
} from '../src/sources/searxng/engine-enablement.service.js';
import { ENGINE_GOVERNANCE } from '../src/sources/searxng/engine-governance.js';
import { SearxngEngineLog } from '../src/sources/searxng/engine-health.js';
import {
  applyLocalDiagnostic,
  decideLocalDiagnostic,
  processPermitsLocalDiagnostic,
  type LocalDiagnosticPolicy,
  type LocalDiagnosticRequest,
} from '../src/sources/searxng/local-diagnostic.js';
import {
  SearxngClient,
  validateSearxngBaseUrl,
  type SearxngTransport,
  type SearxngTransportResult,
} from '../src/sources/searxng/searxng-client.js';
import { SearxngDiscoveryAdapter } from '../src/sources/searxng/searxng-discovery.adapter.js';
import type {
  ActiveSourceVersion,
  SourceVersionReader,
} from '../src/sources/source-version.service.js';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const TENANT = 'tenant-zquence';
const OTHER_TENANT = 'tenant-other';

const POLICY: LocalDiagnosticPolicy = {
  isProduction: false,
  allowLocalGoogleDiagnostic: true,
  googleDiagnosticTenantId: TENANT,
};

const REQUEST: LocalDiagnosticRequest = {
  tenantId: TENANT,
  header: 'GOOGLE_NEWS',
  hostname: '127.0.0.1',
  remoteAddress: '::ffff:127.0.0.1',
};

// ---------------------------------------------------------------------------------------------
// 1–5. The request-level decision
// ---------------------------------------------------------------------------------------------

describe('every condition is required', () => {
  it('grants GOOGLE_NEWS, and only GOOGLE_NEWS, when every condition holds', () => {
    expect(decideLocalDiagnostic(POLICY, REQUEST)).toEqual({
      kind: 'GRANTED',
      engines: ['GOOGLE_NEWS'],
    });
    expect(decideLocalDiagnostic(POLICY, { ...REQUEST, hostname: 'localhost' }).kind).toBe(
      'GRANTED',
    );
  });

  it('1. refuses in a production runtime, even with every other condition met', () => {
    const decision = decideLocalDiagnostic({ ...POLICY, isProduction: true }, REQUEST);
    expect(decision.kind).toBe('REFUSED');
    expect(processPermitsLocalDiagnostic({ ...POLICY, isProduction: true }, TENANT)).toBe(false);
  });

  it('1. production refuses to start with the flag set at all', () => {
    const env = {
      NODE_ENV: 'production',
      ADVERSE_SEARCH_MODE: 'live',
      MONGODB_URI: 'mongodb://db.internal:27017/x',
      OIDC_ISSUER: 'https://id.erlystage.com/realms/x',
      OIDC_CLIENT_ID: 'panel',
      OIDC_CLIENT_SECRET: 'a-real-looking-secret-value',
      SESSION_SECRET: 'a-real-looking-session-secret',
      ALLOW_LOCAL_GOOGLE_DIAGNOSTIC: 'true',
      GOOGLE_DIAGNOSTIC_TENANT_ID: TENANT,
    };
    expect(() => loadConfig(env)).toThrow(/ALLOW_LOCAL_GOOGLE_DIAGNOSTIC is set in production/);
  });

  it('refuses a request that was not made to and from loopback', () => {
    expect(decideLocalDiagnostic(POLICY, { ...REQUEST, hostname: 'api.erlystage.com' }).kind).toBe(
      'REFUSED',
    );
    expect(decideLocalDiagnostic(POLICY, { ...REQUEST, remoteAddress: '10.0.0.4' }).kind).toBe(
      'REFUSED',
    );
    expect(decideLocalDiagnostic(POLICY, { ...REQUEST, hostname: undefined }).kind).toBe('REFUSED');
  });

  it('2. refuses a tenant other than GOOGLE_DIAGNOSTIC_TENANT_ID', () => {
    expect(decideLocalDiagnostic(POLICY, { ...REQUEST, tenantId: OTHER_TENANT }).kind).toBe(
      'REFUSED',
    );
    // And an unset tenant id permits nobody, rather than everybody.
    expect(decideLocalDiagnostic({ ...POLICY, googleDiagnosticTenantId: null }, REQUEST).kind).toBe(
      'REFUSED',
    );
  });

  it('3. refuses when ALLOW_LOCAL_GOOGLE_DIAGNOSTIC is not true', () => {
    expect(
      decideLocalDiagnostic({ ...POLICY, allowLocalGoogleDiagnostic: false }, REQUEST).kind,
    ).toBe('REFUSED');
    const config = loadConfig({
      MONGODB_URI: 'mongodb://127.0.0.1:28017/x',
      OIDC_ISSUER: 'http://127.0.0.1:8080/realms/x',
      OIDC_CLIENT_ID: 'panel',
      OIDC_CLIENT_SECRET: 'local-development-secret',
      SESSION_SECRET: 'local-development-session',
      GOOGLE_DIAGNOSTIC_TENANT_ID: TENANT,
    });
    // Defaults to off: a tenant id alone does not turn it on.
    expect(config.localGoogleDiagnostic.allowLocalGoogleDiagnostic).toBe(false);
  });

  it('4. a request without the header is not a diagnostic at all', () => {
    expect(decideLocalDiagnostic(POLICY, { ...REQUEST, header: undefined })).toEqual({
      kind: 'NOT_REQUESTED',
    });
  });

  it('5. refuses a wrong header value, another engine, or a repeated header', () => {
    for (const header of ['BING_NEWS', 'google_news', 'GOOGLE_NEWS,BING_NEWS', 'true', '']) {
      expect(decideLocalDiagnostic(POLICY, { ...REQUEST, header }).kind).toBe('REFUSED');
    }
    expect(
      decideLocalDiagnostic(POLICY, { ...REQUEST, header: ['GOOGLE_NEWS', 'GOOGLE_NEWS'] }).kind,
    ).toBe('REFUSED');
  });

  it('can never widen an engine other than GOOGLE_NEWS, whatever a run record says', async () => {
    const service = new EngineEnablementService(inMemoryDb([]).db);
    const widened = applyLocalDiagnostic(await service.resolveFor(TENANT), [
      'GOOGLE_NEWS',
      'BING_NEWS',
      'SOMETHING_ELSE',
    ]);
    expect(widened.filter((engine) => engine.diagnosticOverride).map((e) => e.engine)).toEqual([
      'GOOGLE_NEWS',
    ]);
    const google = widened.find((engine) => engine.engine === 'GOOGLE_NEWS');
    // The reading and the tenant switch travel through unchanged.
    expect(google?.governanceStatus).toBe('REFUSED');
    expect(google?.tenantEnabled).toBe(false);
    expect(google?.defaultEnabledForDiscovery).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 6–10. Through the real connector and the real enablement service
// ---------------------------------------------------------------------------------------------

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
  tenantId: TENANT,
  categories: [{ category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 1, enabledCountries: ['US'] }],
  lexicon: [],
  languages: [{ language: 'en', measuredRecall: null, measuredByEvaluationRunId: null }],
  status: 'ACTIVE',
  proposedBy: 'test',
  approvedBy: 'test',
  activatedAt: NOW.toISOString(),
};

const versions: SourceVersionReader = {
  loadActive: (sourceId: string) =>
    Promise.resolve(sourceId === SEARXNG_SOURCE_ID ? VERSION : null),
  loadActiveByDomain: () => Promise.resolve(null),
};

/** An in-memory settings collection that counts every write. */
function inMemoryDb(rows: StoredEngineSetting[]): { db: Db; writes: () => number } {
  let writes = 0;
  const db = {
    collection: () => ({
      find: (filter: { tenantId: string }) => ({
        toArray: () => Promise.resolve(rows.filter((row) => row.tenantId === filter.tenantId)),
      }),
      createIndex: () => Promise.resolve('ok'),
      updateOne: () => {
        writes += 1;
        return Promise.resolve({ acknowledged: true });
      },
      insertOne: () => {
        writes += 1;
        return Promise.resolve({ acknowledged: true });
      },
      deleteOne: () => {
        writes += 1;
        return Promise.resolve({ acknowledged: true });
      },
    }),
  } as unknown as Db;
  return { db, writes: () => writes };
}

/** Answers every engine; Google with two original-publisher URLs. */
class Transport implements SearxngTransport {
  readonly asked: string[] = [];
  send(input: { url: string; timeoutMs: number }): Promise<SearxngTransportResult> {
    const engine = new URL(input.url).searchParams.get('engines') ?? '';
    this.asked.push(engine);
    const urls =
      engine === 'google news'
        ? [
            'https://www.bloomberg.com/news/articles/madoff-sentenced',
            'https://www.reuters.com/article/madoff-fraud',
          ]
        : [];
    return Promise.resolve({
      kind: 'RESPONSE',
      status: 200,
      body: JSON.stringify({
        query: 'q',
        results: urls.map((url, index) => ({
          url,
          title: `Madoff story ${String(index)}`,
          content: 'A snippet.',
          engine,
          engines: [engine],
          publishedDate: '2009-06-29T00:00:00+00:00',
          score: 1,
          category: 'news',
        })),
        unresponsive_engines: [],
      }),
    });
  }
}

function query(diagnosticEngines?: readonly string[], tenantId = TENANT): DiscoveryQuery {
  return {
    tenantId,
    run: {
      jobId: 'search-diag-1',
      subjectId: 'subject-1',
      jurisdictions: ['US'],
      languages: ['en'],
      taxonomy: TAXONOMY,
      ...(diagnosticEngines === undefined ? {} : { diagnosticEngines }),
    },
    queryId: 'q-1',
    family: 'F3',
    text: '"Bernard Madoff" fraud',
    language: 'en',
    country: 'US',
    window: null,
    limit: 25,
  };
}

function harness(policy: LocalDiagnosticPolicy | undefined) {
  const base = validateSearxngBaseUrl('http://127.0.0.1:28888');
  if (base.kind !== 'OK') {
    throw new Error('fixture base URL must validate');
  }
  const store = inMemoryDb([]);
  const enablement = new EngineEnablementService(store.db);
  const transport = new Transport();
  const engineLog = new SearxngEngineLog();
  const adapter = new SearxngDiscoveryAdapter({
    sourceId: SEARXNG_SOURCE_ID,
    versions,
    gate: new FetchGateService(versions, 'LIVE', {
      mode: 'LIVE',
      contactUrl: 'https://erlystage.com/bots/adverse-search',
      region: 'eu-west-2',
    }),
    client: new SearxngClient(base.base, transport),
    enablement,
    engineLog,
    clock: () => NOW,
    ...(policy === undefined ? {} : { localDiagnostic: policy }),
  });
  return { adapter, enablement, transport, engineLog, store };
}

describe('the diagnostic through the real connector', () => {
  it('8. a normal search cannot execute Google, even in a process with the flag set', async () => {
    const h = harness(POLICY);
    await h.adapter.discover(query());
    expect(h.transport.asked).not.toContain('google news');
    const google = h.engineLog
      .summaryFor('search-diag-1')
      ?.perEngine.find((row) => row.engine === 'GOOGLE_NEWS');
    expect(google?.attempted).toBe(false);
    expect(google?.outcome).toBe('DISABLED_BY_POLICY');
    expect(google?.diagnosticOverride).toBeUndefined();
  });

  it('9. a granted diagnostic run executes Google locally', async () => {
    const h = harness(POLICY);
    const outcome = await h.adapter.discover(query(['GOOGLE_NEWS']));
    expect(h.transport.asked).toContain('google news');
    // The other engines still ran — Google is added, nothing is replaced.
    expect(h.transport.asked).toContain('bing news');
    expect(outcome.status).toBe('OK');
    if (outcome.status !== 'OK') {
      return;
    }
    expect(outcome.data.length).toBeGreaterThan(0);
    for (const lead of outcome.data) {
      // Google is a channel, never the publisher: the lead names the article's own host.
      expect(lead.publisherDomain).not.toMatch(/google\./);
      expect(lead.discovery?.discoveryEngines).toContain('GOOGLE_NEWS');
    }
  });

  it('10. GOOGLE_NEWS appears in the engine diagnostics as a diagnostic override', async () => {
    const h = harness(POLICY);
    await h.adapter.discover(query(['GOOGLE_NEWS']));
    const summary = h.engineLog.summaryFor('search-diag-1');
    const google = summary?.perEngine.find((row) => row.engine === 'GOOGLE_NEWS');
    expect(google).toMatchObject({
      attempted: true,
      outcome: 'RETURNED_RESULTS',
      resultsReturned: 2,
      diagnosticOverride: true,
      diagnosticOnly: true,
      effectiveEnabled: true,
      // The reading is reported unchanged beside the diagnostic.
      governanceStatus: 'REFUSED',
      decisionId: 'D20',
    });
    // No other engine is marked as a diagnostic.
    expect(summary?.perEngine.filter((row) => row.diagnosticOverride === true)).toHaveLength(1);
  });

  it('6–7. nothing is persisted, and Google resolves disabled after the run', async () => {
    const h = harness(POLICY);
    await h.adapter.discover(query(['GOOGLE_NEWS']));
    expect(h.store.writes()).toBe(0);

    const after = (await h.enablement.resolveFor(TENANT)).find((e) => e.engine === 'GOOGLE_NEWS');
    expect(after).toMatchObject({
      integrated: true,
      governanceStatus: 'REFUSED',
      defaultEnabledForDiscovery: false,
      tenantEnabled: false,
      effectiveEnabled: false,
      configuredByTenant: false,
    });
    // And the matrix itself is untouched.
    expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.governanceStatus).toBe('REFUSED');
    expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.defaultEnabledForDiscovery).toBe(false);
  });

  it('the worker re-checks: a run marker is ignored without the flag, for another tenant, or in production', async () => {
    for (const policy of [
      undefined,
      { ...POLICY, allowLocalGoogleDiagnostic: false },
      { ...POLICY, isProduction: true },
      { ...POLICY, googleDiagnosticTenantId: OTHER_TENANT },
    ]) {
      const h = harness(policy);
      await h.adapter.discover(query(['GOOGLE_NEWS']));
      expect(h.transport.asked).not.toContain('google news');
    }
  });
});
