/**
 * One bounded, real query per engine against the SearXNG instance this deployment runs.
 *
 * # What it contacts, and what that costs
 *
 * The instance is ours, on loopback, so reaching it costs nobody anything. What it can cost is
 * **upstream**: the instance forwards each query to the engine it is asked for, and those are
 * third parties. So it asks for exactly the engines the platform defaults enable, one request
 * each, one page each — and it never sends `categories`, which is the parameter that would pull
 * in the whole news category regardless of the matrix.
 *
 * One request per engine costs the upstreams nothing extra: a merged request naming six engines
 * forwards to all six anyway. What it buys is the per-engine table below — an outcome, a
 * duration and a result count for every engine, and a failure in one that cannot take another
 * down with it.
 *
 * # Two gates
 *
 * **Not in any project a normal run executes.** `vitest.config.mts` puts `tests/live` in a
 * project called `live`; `pnpm test:unit`, `test:integration`, `test:security` and `test:e2e:api`
 * cannot reach it.
 *
 * **Refuses without `SEARXNG_LIVE_SMOKE=yes-query-the-instance`.**
 *
 * # It is deliberately not a full pipeline run
 *
 * `combined-adverse-search.test.ts` is where the whole path is exercised end to end. This is the
 * connector's own contract against the real instance, so that when the combined run reports
 * something there is a separate record of what each engine actually did and said.
 *
 * Requires the local stack (`pnpm local:up`) and `SEARXNG_URL` set.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  NodeSearxngTransport,
  SearxngClient,
  parseEnabledEngineNames,
  parseSearxngResponse,
  validateSearxngBaseUrl,
} from '../../apps/api/src/sources/searxng/searxng-client.js';
import {
  ALL_ENGINES,
  ENGINE_GOVERNANCE,
  engineFromSearxngName,
} from '../../apps/api/src/sources/searxng/engine-governance.js';
import { defaultResolvedEngines } from '../../apps/api/src/sources/searxng/engine-enablement.service.js';
import { classifyEngineFailure } from '../../apps/api/src/sources/searxng/engine-health.js';

const CONFIRMATION = 'yes-query-the-instance';

/**
 * A harmless, well-known public subject.
 *
 * A real person whose adverse coverage is a matter of public record, so a working engine has
 * something to return and an empty result means something. Not a customer, not a screening
 * subject, and nothing from this run is stored.
 */
const SUBJECT = 'Bernard Madoff';
const QUERY = `"${SUBJECT}" fraud`;

const TIMEOUT_MS = 20_000;

const BASE_URL = process.env['SEARXNG_URL'] ?? 'http://127.0.0.1:28888';

interface EngineRow {
  readonly engine: string;
  readonly outcome: string;
  readonly results: number;
  readonly durationMs: number;
  readonly detail: string;
}

describe('SearXNG live smoke', () => {
  let client: SearxngClient;

  beforeAll(() => {
    if (process.env['SEARXNG_LIVE_SMOKE'] !== CONFIRMATION) {
      throw new Error(
        `This suite issues real queries to the configured SearXNG instance, which forwards them ` +
          `to whichever upstream engines are enabled. Set SEARXNG_LIVE_SMOKE=${CONFIRMATION} ` +
          `to run it.`,
      );
    }
    const validation = validateSearxngBaseUrl(BASE_URL);
    if (validation.kind !== 'OK') {
      throw new Error(`SEARXNG_URL is not usable: ${validation.detail}`);
    }
    client = new SearxngClient(validation.base, new NodeSearxngTransport());
  });

  it('reads /config and reports the matrix against what the instance actually has', async () => {
    const result = await client.config(TIMEOUT_MS);
    expect(result.kind).toBe('RESPONSE');
    if (result.kind !== 'RESPONSE') {
      return;
    }
    expect(result.status).toBe(200);

    const names = parseEnabledEngineNames(result.body);
    // Null, not an empty list: "could not be read" and "the instance has no engines" are
    // different claims and the second is much stronger.
    expect(names).not.toBeNull();
    const enabledOnInstance = names ?? [];

    console.log('\n--- SearXNG instance ---');
    console.log(`base URL           ${client.baseUrl}`);
    console.log(`engines enabled    ${String(enabledOnInstance.length)}`);
    for (const engine of ALL_ENGINES) {
      const record = ENGINE_GOVERNANCE[engine];
      const onInstance = enabledOnInstance.includes(record.searxngEngineName);
      console.log(
        `  ${record.engine.padEnd(18)} integrated=${String(record.integrated).padEnd(5)} ` +
          `instance=${onInstance ? 'enabled ' : 'disabled'} ` +
          `governance=${record.governanceStatus.padEnd(9)}(${record.decisionId.padEnd(4)}) ` +
          `defaultOn=${String(record.defaultEnabledForDiscovery)}`,
      );
    }

    // Every engine the connector integrates must exist on the instance and be runnable, or the
    // matrix and the deployment have drifted and an enabled engine would silently never run.
    // Google is the one exception: `disabled: true` on the instance under D20, so it is present
    // as a definition rather than as a runnable engine.
    for (const engine of ALL_ENGINES) {
      const record = ENGINE_GOVERNANCE[engine];
      expect(record.integrated).toBe(true);
      if (record.engine !== 'GOOGLE_NEWS') {
        expect(enabledOnInstance).toContain(record.searxngEngineName);
      }
    }

    // The instance must not be running news engines the matrix has never heard of. One that
    // appears here is configuration drift: our connector would never name it, but a request
    // carrying `categories` would reach it, and this is how that gets noticed.
    const ungoverned = enabledOnInstance.filter((name) => engineFromSearxngName(name) === null);
    console.log(`ungoverned engines: ${ungoverned.join(', ') || 'none'}`);
    // `duckduckgo` and `wikipedia` are general-category engines kept from the original settings
    // file and are not news engines. What must not appear here is a news engine.
    expect(ungoverned.toSorted()).toEqual(['duckduckgo', 'wikipedia']);
  });

  it(
    'issues one bounded query per enabled engine, independently',
    async () => {
      const resolved = defaultResolvedEngines();
      const permitted = resolved.filter((engine) => engine.effectiveEnabled);
      const withheld = resolved.filter((engine) => !engine.effectiveEnabled);

      console.log('\n--- SearXNG smoke query ---');
      console.log(`subject            ${SUBJECT}`);
      console.log(`query              ${QUERY}`);
      console.log(`engines enabled    ${permitted.map((r) => r.engine).join(', ') || '(none)'}`);

      const rows: EngineRow[] = [];
      const allUrls = new Set<string>();
      let totalRaw = 0;

      for (const engine of permitted) {
        const params = {
          q: QUERY,
          // One engine, and no category. See the connector's header for why naming a category
          // would make the whole matrix decorative.
          engines: [engine.searxngEngineName],
          language: 'en',
          pageno: 1,
          timeRange: null,
        } as const;

        // Printed before the request, so the run's own record names the exact URL issued. Safe to
        // print: the subject is a public figure chosen for this file, not a customer.
        console.log(`\nrequest  ${client.searchUrl(params)}`);

        const started = Date.now();
        const result = await client.search(params, TIMEOUT_MS);
        const durationMs = Date.now() - started;

        if (result.kind !== 'RESPONSE') {
          rows.push({
            engine: engine.engine,
            outcome: result.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'CONNECTION_ERROR',
            results: 0,
            durationMs,
            detail: result.detail,
          });
          continue;
        }
        if (result.status !== 200) {
          rows.push({
            engine: engine.engine,
            outcome: `HTTP_${String(result.status)}`,
            results: 0,
            durationMs,
            detail: '',
          });
          continue;
        }

        const parsed = parseSearxngResponse(result.body);
        // Never "no results" on a shape change: a failure here means the parser and the instance
        // have diverged and recall is about to go to zero silently (T84).
        expect(parsed.kind).toBe('OK');
        if (parsed.kind !== 'OK') {
          rows.push({
            engine: engine.engine,
            outcome: 'INTERNAL_ERROR',
            results: 0,
            durationMs,
            detail: parsed.detail,
          });
          continue;
        }

        const down = parsed.response.unresponsiveEngines[0];
        if (down !== undefined) {
          rows.push({
            engine: engine.engine,
            outcome: classifyEngineFailure(down.reason),
            results: 0,
            durationMs,
            detail: down.reason,
          });
          continue;
        }

        const urls = parsed.response.results
          .map((entry) => entry.url)
          .filter((url): url is string => url !== null);
        totalRaw += urls.length;
        for (const url of urls) {
          allUrls.add(url);
        }
        rows.push({
          engine: engine.engine,
          outcome: urls.length > 0 ? 'RETURNED_RESULTS' : 'ZERO_RESULTS',
          results: urls.length,
          durationMs,
          detail: '',
        });

        // **The instance must not have run an engine we did not name.** The live proof that the
        // engine list is real rather than decorative, and the exact failure that sending
        // `categories=news` would have produced.
        for (const entry of parsed.response.results) {
          for (const credited of entry.engines) {
            expect(credited.toLowerCase()).toBe(engine.searxngEngineName.toLowerCase());
          }
        }
      }

      console.log('\n--- per-engine outcomes ---');
      for (const row of rows) {
        console.log(
          `  ${row.engine.padEnd(18)} ${row.outcome.padEnd(18)} ` +
            `${String(row.results).padStart(3)} results ${String(row.durationMs).padStart(6)}ms  ` +
            row.detail,
        );
      }
      for (const engine of withheld) {
        // Reported, never omitted. A disabled engine is a visible, explained zero.
        console.log(
          `  ${engine.engine.padEnd(18)} ${'DISABLED_BY_POLICY'.padEnd(18)}   0 results      0ms  ` +
            engine.decisionId,
        );
      }

      console.log('\n--- totals ---');
      console.log(`total raw results  ${String(totalRaw)}`);
      console.log(`unique URLs        ${String(allUrls.size)}`);
      console.log(`duplicates merged  ${String(totalRaw - allUrls.size)}`);
      console.log('\noriginal publisher URLs (first eight):');
      for (const url of [...allUrls].slice(0, 8)) {
        console.log(`  ${url}`);
      }

      // No result here is a supported finding. Everything is a lead, and a lead's URL must be an
      // original publisher's — never a URL on the metasearch instance.
      const instanceHost = new URL(client.baseUrl).host;
      for (const url of allUrls) {
        expect(url).not.toContain(instanceHost);
      }

      // **One engine failing never removes another engine's results.** Where any engine answered,
      // the run has candidates regardless of what the others did.
      if (rows.some((row) => row.outcome === 'RETURNED_RESULTS')) {
        expect(allUrls.size).toBeGreaterThan(0);
      }

      // And every enabled engine produced a row. An engine that was asked and reported nothing at
      // all would be the one state the diagnostics cannot explain.
      expect(rows).toHaveLength(permitted.length);
      // Six engines, each bounded by TIMEOUT_MS, issued one after another so the printed durations
      // are each engine's own rather than a share of a parallel batch. The connector runs them
      // concurrently; this file trades that for a readable table, and the bound below is the sum.
    },
    ALL_ENGINES.length * TIMEOUT_MS + 10_000,
  );

  it('refuses to address any host but the configured instance', () => {
    // The narrow rule this client claims: no method takes a host, and the assembled URL is
    // compared back to the base immediately before the socket opens.
    const url = client.searchUrl({
      q: 'x',
      engines: ['wikinews'],
      language: 'en',
      pageno: 1,
      timeRange: null,
    });
    expect(new URL(url).origin).toBe(client.baseUrl);
    expect(new URL(url).pathname).toBe('/search');
  });
});
