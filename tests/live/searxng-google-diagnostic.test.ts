/**
 * **One** bounded, real query to Google News through our own SearXNG instance — D20-A only.
 *
 * # What this is, and what it emphatically is not
 *
 * D20 refused Google as a discovery source on Google's own Terms of Use, and closed **without
 * contacting the publisher**. That was right on the licence question and it left an engineering
 * question open: what does Google actually *do* when this infrastructure asks it? The twenty-
 * fourth session observed `CAPTCHA` at 6ms. The twenty-fifth observed `DISABLED_BY_POLICY` at
 * 0ms, because the governance gate had started refusing before the socket opened — a better
 * behaviour that also erased the observation. So nobody can currently say whether `GOOGLE_NEWS`
 * is integrated-and-unusable from this egress or integrated-and-would-work.
 *
 * **D20-A** (`docs/open-decisions.md`) authorises exactly one request to answer that, and
 * nothing more. This file is that request.
 *
 * It is **not** a governance change. `ENGINE_GOVERNANCE.GOOGLE_NEWS.governanceStatus` is
 * `REFUSED` and this file asserts that it still is, before and after. It is not a smoke test, not
 * part of any suite, and it produces no lead, no candidate, no document and no tenant finding —
 * nothing here writes to a database at all.
 *
 * # Why it can reach an engine the instance has disabled, and why that is not a hole
 *
 * `infra/local/searxng/settings.yml` keeps `google news` in `keep_only` and sets
 * `disabled: true`, and its comment says why: "it never runs for a request that merely names
 * `categories=news`; only a request naming the engine explicitly could reach it, and our
 * connector's allowlist will not name it." That is the property being used, deliberately and
 * visibly. The instance is not reconfigured, the matrix is not edited, and the connector still
 * will not name it — this file names it, once, under a decision that says it may.
 *
 * # Three gates, all of which must be open
 *
 * 1. `tests/live` is the `live` vitest project. No ordinary suite can reach it.
 * 2. `SEARXNG_GOOGLE_DIAGNOSTIC` must equal the confirmation below. It is **deliberately a
 *    different variable** from `SEARXNG_LIVE_SMOKE`, so arming the routine live smoke can never
 *    arm this.
 * 3. `SEARXNG_LIVE_SMOKE` must *not* be what arms it, and the file skips itself entirely when its
 *    own variable is absent rather than throwing — a throw would fail `pnpm test:live` for
 *    everyone who did not ask for a Google request.
 *
 * # What is forbidden inside it
 *
 * No retry. No proxy, no alternate egress, no header forged to look like a browser — the request
 * carries exactly what `NodeSearxngTransport` sends to every other engine. No CAPTCHA is solved
 * or submitted. A refusal is the result, not an obstacle.
 */

import { describe, expect, it } from 'vitest';

import {
  NodeSearxngTransport,
  SearxngClient,
  parseSearxngResponse,
  validateSearxngBaseUrl,
} from '../../apps/api/src/sources/searxng/searxng-client.js';
import { ENGINE_GOVERNANCE } from '../../apps/api/src/sources/searxng/engine-governance.js';
import { defaultResolvedEngines } from '../../apps/api/src/sources/searxng/engine-enablement.service.js';
import { classifyEngineFailure } from '../../apps/api/src/sources/searxng/engine-health.js';

const CONFIRMATION = 'yes-one-google-request-under-d20a';

/**
 * The same public subject the live smoke uses.
 *
 * Deliberately identical, so this run's result is comparable with the five engines' results from
 * the same day rather than being a second variable. A public figure whose adverse coverage is a
 * matter of record; not a customer and not a screening subject.
 */
const SUBJECT = 'Bernard Madoff';
const QUERY = `"${SUBJECT}" fraud`;

const TIMEOUT_MS = 20_000;
const BASE_URL = process.env['SEARXNG_URL'] ?? 'http://127.0.0.1:28888';

const ARMED = process.env['SEARXNG_GOOGLE_DIAGNOSTIC'] === CONFIRMATION;

describe.skipIf(!ARMED)('D20-A — single Google News diagnostic', () => {
  it(
    'issues exactly one Google News query and records what Google did',
    async () => {
      const google = ENGINE_GOVERNANCE.GOOGLE_NEWS;

      // The reading this diagnostic runs *under*, not against. Asserted first so a run that
      // somehow happened after somebody flipped it is not mistaken for this one.
      expect(google.integrated).toBe(true);
      expect(google.governanceStatus).toBe('REFUSED');
      expect(google.decisionId).toBe('D20');
      const resolvedBefore = defaultResolvedEngines().find((e) => e.engine === 'GOOGLE_NEWS');
      expect(resolvedBefore?.effectiveEnabled).toBe(false);

      const validation = validateSearxngBaseUrl(BASE_URL);
      expect(validation.kind).toBe('OK');
      if (validation.kind !== 'OK') {
        return;
      }
      const client = new SearxngClient(validation.base, new NodeSearxngTransport());

      const params = {
        q: QUERY,
        // One engine, named explicitly. No category — naming one would pull in the whole news
        // category and this run would stop being a single-engine observation.
        engines: [google.searxngEngineName],
        language: 'en',
        pageno: 1,
        timeRange: null,
      } as const;

      console.log('\n=== D20-A Google News diagnostic — ONE request ===');
      console.log(`governance         ${google.governanceStatus} (${google.decisionId})`);
      console.log(`effectiveEnabled   ${String(resolvedBefore?.effectiveEnabled)}`);
      console.log(`subject            ${SUBJECT}`);
      console.log(`query              ${QUERY}`);
      console.log(`engine named       ${google.searxngEngineName}`);
      console.log(`request            ${client.searchUrl(params)}`);
      console.log(`attempted          true`);

      const started = Date.now();
      const result = await client.search(params, TIMEOUT_MS);
      const durationMs = Date.now() - started;

      // ----- outcome, as facts -----
      let outcome: string;
      let detail = '';
      let httpStatus: number | null = null;
      let rawCount = 0;
      let uniqueCount = 0;
      let publisherUrls: readonly string[] = [];
      let unresponsive: readonly { engine: string; reason: string }[] = [];

      if (result.kind !== 'RESPONSE') {
        outcome = result.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'CONNECTION_ERROR';
        detail = `${result.code}: ${result.detail}`;
      } else {
        httpStatus = result.status;
        if (result.status !== 200) {
          outcome = `HTTP_${String(result.status)}`;
          detail = result.body.slice(0, 300);
        } else {
          const parsed = parseSearxngResponse(result.body);
          if (parsed.kind !== 'OK') {
            outcome = 'INTERNAL_ERROR';
            detail = parsed.detail;
          } else {
            unresponsive = parsed.response.unresponsiveEngines.map((e) => ({
              engine: e.engine,
              reason: e.reason,
            }));
            const down = parsed.response.unresponsiveEngines[0];
            const urls = parsed.response.results
              .map((entry) => entry.url)
              .filter((url): url is string => url !== null);
            rawCount = urls.length;
            const unique = new Set(urls);
            uniqueCount = unique.size;
            publisherUrls = [...unique];

            if (down !== undefined) {
              // SearXNG's own account of why the engine did not answer. This is the line that
              // says "Suspended: CAPTCHA" — the whole reason this diagnostic exists.
              outcome = classifyEngineFailure(down.reason);
              detail = `${down.engine}: ${down.reason}`;
            } else {
              outcome = rawCount > 0 ? 'RETURNED_RESULTS' : 'ZERO_RESULTS';
            }
          }
        }
      }

      // ----- the record -----
      console.log('\n--- result ---');
      console.log(`outcome            ${outcome}`);
      console.log(`http status        ${httpStatus === null ? 'no response' : String(httpStatus)}`);
      console.log(`duration ms        ${String(durationMs)}`);
      console.log(`raw results        ${String(rawCount)}`);
      console.log(`unique results     ${String(uniqueCount)}`);
      console.log(`detail             ${detail || '(none)'}`);
      console.log(
        `unresponsive       ${
          unresponsive.map((e) => `${e.engine} => ${e.reason}`).join('; ') || '(none)'
        }`,
      );

      console.log('\n--- are these original publisher URLs? ---');
      if (publisherUrls.length === 0) {
        console.log('  (no URLs returned — the question does not arise on this run)');
      }
      const instanceHost = new URL(client.baseUrl).host;
      let googleHosted = 0;
      for (const url of publisherUrls.slice(0, 20)) {
        const host = (() => {
          try {
            return new URL(url).host;
          } catch {
            return '(unparsable)';
          }
        })();
        // The D20 provenance defect, restated as a live check: a `news.google.com/rss/articles/...`
        // redirect names a token, not a document, and a finding that cannot name its document is
        // one a reviewer cannot check.
        const hosted = /(^|\.)google\.(com|[a-z.]+)$/i.test(host);
        if (hosted) {
          googleHosted += 1;
        }
        console.log(`  ${hosted ? 'GOOGLE-HOSTED' : 'publisher    '}  ${url}`);
      }
      console.log(
        `\nusable original publisher URLs: ${
          publisherUrls.length === 0
            ? 'N/A — nothing returned'
            : `${String(publisherUrls.length - googleHosted)}/${String(
                publisherUrls.length,
              )} (${String(googleHosted)} Google-hosted redirects)`
        }`,
      );

      // ----- invariants that must hold whatever Google did -----

      // The instance must not have run an engine we did not name. Same property the live smoke
      // asserts, and it matters more here: a second engine running would mean this "one Google
      // request" was several requests to several third parties.
      if (result.kind === 'RESPONSE' && result.status === 200) {
        const parsed = parseSearxngResponse(result.body);
        if (parsed.kind === 'OK') {
          for (const entry of parsed.response.results) {
            for (const credited of entry.engines) {
              expect(credited.toLowerCase()).toBe(google.searxngEngineName.toLowerCase());
            }
          }
        }
      }

      // No lead may ever point at the metasearch instance itself.
      for (const url of publisherUrls) {
        expect(url).not.toContain(instanceHost);
      }

      // **The reading did not move, and this run did not move it.** Whatever the outcome above —
      // including an unexpected success — Google is still REFUSED and still not executable. If
      // this assertion ever fails, somebody inferred permission from an engine having worked,
      // which is the one thing the engine matrix exists to prevent.
      expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.governanceStatus).toBe('REFUSED');
      expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.integrated).toBe(true);
      const resolvedAfter = defaultResolvedEngines().find((e) => e.engine === 'GOOGLE_NEWS');
      expect(resolvedAfter?.effectiveEnabled).toBe(false);

      console.log('\n--- governance after the diagnostic (unchanged, by assertion) ---');
      console.log(`integrated         ${String(ENGINE_GOVERNANCE.GOOGLE_NEWS.integrated)}`);
      console.log(`governanceStatus   ${ENGINE_GOVERNANCE.GOOGLE_NEWS.governanceStatus}`);
      console.log(`effectiveEnabled   ${String(resolvedAfter?.effectiveEnabled)}`);
      console.log('=== end of the single authorised request ===\n');
    },
    TIMEOUT_MS + 10_000,
  );
});
