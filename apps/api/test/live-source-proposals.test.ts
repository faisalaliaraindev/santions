/**
 * The two source proposals this milestone adds, read as an approver would read them.
 *
 * Neither is an activation. What these tests protect is that each record says what it is
 * supposed to say **before** anybody submits it — because after submission the record is what
 * the fetch gate reads, and a wrong field there is a request nobody approved.
 *
 * The two are deliberately opposite shapes, and most of the value here is in the contrast:
 *
 * - `sec-press-releases` is a **FIXED_FEED** that shares a publisher, a policy, a licence and a
 *   domain with a source that is already live, and must not be confusable with it.
 * - `gdelt-doc-v2` is a **QUERY_FEED** at a publisher this project has never contacted, and must
 *   stay unreachable until four separate human acts have happened.
 */

import { describe, expect, it } from 'vitest';

import { sourceContentSchema } from '@erly/adverse-contracts';
import { registrableDomain } from '@erly/adverse-domain';

import {
  GDELT_DOC_V2_CONTENT,
  GDELT_DOC_V2_DAILY_BUDGET,
  GDELT_DOC_V2_DOMAIN,
  GDELT_DOC_V2_ENDPOINT_URL,
  GDELT_DOC_V2_HOURLY_BUDGET,
  GDELT_DOC_V2_QUERY_PARAM,
  GDELT_DOC_V2_SOURCE_ID,
  gdeltDocV2Content,
} from '../src/sources/registry/gdelt-doc-v2.js';
import { GDELT_TEMPLATE } from '../src/sources/registry/discovery-rungs.js';
import {
  SEC_LITIGATION_RELEASES_CONTENT,
  SEC_LITIGATION_RELEASES_SOURCE_ID,
  SEC_PRESS_RELEASES_FEED_URL,
  SEC_STOP_CONDITIONS,
} from '../src/sources/registry/sec-litigation-releases.js';
import {
  SEC_PRESS_RELEASES_CONTENT,
  SEC_PRESS_RELEASES_SOURCE_ID,
  secPressReleasesContent,
} from '../src/sources/registry/sec-press-releases.js';
import {
  SEARXNG_CONTENT,
  SEARXNG_HOURLY_BUDGET,
  searxngAdverseMediaContent,
} from '../src/sources/registry/searxng-adverse-media.js';
import { DEFAULT_SEARXNG_LIMITS } from '../src/sources/searxng/searxng-discovery.adapter.js';

describe('SEC press releases is a second source, not a second URL', () => {
  it('is submittable against the FR-05 schema', () => {
    expect(() => secPressReleasesContent()).not.toThrow();
  });

  it('carries its own id, which is not the litigation feed’s', () => {
    expect(SEC_PRESS_RELEASES_SOURCE_ID).toBe('sec-press-releases');
    expect(SEC_PRESS_RELEASES_SOURCE_ID).not.toBe(SEC_LITIGATION_RELEASES_SOURCE_ID);
  });

  it('points at the press-releases feed, and the litigation source still points at its own', () => {
    // The failure this catches is a copy-paste that leaves both records on one URL, which would
    // read as two sources in coverage and be one feed polled twice.
    expect(SEC_PRESS_RELEASES_CONTENT.accessPolicy.endpointUrl).toBe(SEC_PRESS_RELEASES_FEED_URL);
    expect(SEC_LITIGATION_RELEASES_CONTENT.accessPolicy.endpointUrl).not.toBe(
      SEC_PRESS_RELEASES_FEED_URL,
    );
  });

  it('is a FIXED_FEED and names no query parameter', () => {
    // The SEC publishes a list, not a search. Recording it as a QUERY_FEED would make its cost
    // one request per planned query at a publisher whose whole free tier is 120 an hour.
    expect(SEC_PRESS_RELEASES_CONTENT.accessPolicy.endpointKind).toBe('FIXED_FEED');
    expect(SEC_PRESS_RELEASES_CONTENT.accessPolicy.queryParam).toBeNull();
  });

  it('uses the RSS connector, so it needed no adapter', () => {
    // D-043: adding a publisher is an approval, not a deployment. A new connector type here
    // would have meant the same parse existing twice.
    expect(SEC_PRESS_RELEASES_CONTENT.connectorType).toBe('NEWS_DISCOVERY_RSS');
    expect(SEC_PRESS_RELEASES_CONTENT.connectorType).toBe(
      SEC_LITIGATION_RELEASES_CONTENT.connectorType,
    );
  });

  it('shares the publisher’s domain, and therefore the sec.gov domain breaker', () => {
    // Domain health is keyed on the registrable domain, so both feeds already sit behind one
    // publisher-level breaker. That is correct and is asserted rather than assumed.
    const press = SEC_PRESS_RELEASES_CONTENT.canonicalDomains[0];
    const litigation = SEC_LITIGATION_RELEASES_CONTENT.canonicalDomains[0];
    expect(registrableDomain(press)).toBe(registrableDomain(litigation));
    expect(registrableDomain(press)).toBe('sec.gov');
  });

  it('reuses the publisher’s stop conditions exactly', () => {
    // One published policy, one set of stop conditions. A second feed that quietly softened them
    // would be a path on which a 403 is retried at a publisher who said not to.
    const stops = SEC_PRESS_RELEASES_CONTENT.accessPolicy.stopConditions;
    expect(stops.haltOnStatuses).toEqual(SEC_STOP_CONDITIONS.haltOnStatuses);
    expect(stops.haltOnRateLimit).toBe(SEC_STOP_CONDITIONS.haltOnRateLimit);
    expect(stops.rateLimitCooldownSeconds).toBe(SEC_STOP_CONDITIONS.rateLimitCooldownMs / 1000);
    expect(stops.serverErrorStreakToHalt).toBe(SEC_STOP_CONDITIONS.serverErrorStreakToHalt);
    expect(stops.requiresFreshApprovalOnHalt).toBe(SEC_STOP_CONDITIONS.requiresFreshApprovalOnHalt);
  });

  it('reuses the licence terms, because there is one set of them', () => {
    expect(SEC_PRESS_RELEASES_CONTENT.licenceTermsVersion).toBe(
      SEC_LITIGATION_RELEASES_CONTENT.licenceTermsVersion,
    );
  });

  it('does not reuse the parser version or the budget', () => {
    // Both are properties of the feed rather than of the publisher. A shared parser version
    // would hide a shape change in one feed behind the other's contract probe; a shared budget
    // would let a loop in one exhaust the other's allowance with neither record saying so.
    expect(SEC_PRESS_RELEASES_CONTENT.parserVersion).not.toBe(
      SEC_LITIGATION_RELEASES_CONTENT.parserVersion,
    );
    expect(SEC_PRESS_RELEASES_CONTENT.freeTierHourlyBudget).toBe(6);
    expect(SEC_PRESS_RELEASES_CONTENT.freeTierDailyBudget).toBe(120);
  });

  it('carries D17, which named this feed', () => {
    // Not a borrowed approval: D17's own text is "the SEC litigation-releases RSS feed ... with
    // the press-releases feed as a second, later".
    const approval = SEC_PRESS_RELEASES_CONTENT.accessPolicy.firstContactApproval;
    expect(approval?.decision).toBe('D17');
    expect(approval?.approvedBy).toBe('Faisal Ali');
  });

  it('establishes no robots position for its own path', () => {
    // The recorded robots read checked the litigation path. Recording HONOURED here would be
    // recording a check nobody performed, in the record the fetch gate reads.
    expect(SEC_PRESS_RELEASES_CONTENT.robotsPosition).toBe('NOT_ESTABLISHED');
    expect(SEC_PRESS_RELEASES_CONTENT.accessPolicy.policySummary).toContain(
      'ROBOTS POSITION NOT ESTABLISHED FOR THIS PATH',
    );
  });

  it('sits at rung 1, beside the litigation feed', () => {
    expect(SEC_PRESS_RELEASES_CONTENT.cascadeRung).toBe(1);
    expect(SEC_PRESS_RELEASES_CONTENT.authorityTier).toBe(1);
  });
});

describe('GDELT DOC 2.0 is proposed as a query feed and stays inert', () => {
  it('is submittable against the FR-05 schema', () => {
    expect(() => gdeltDocV2Content()).not.toThrow();
    expect(() => sourceContentSchema.parse(GDELT_DOC_V2_CONTENT)).not.toThrow();
  });

  it('is a QUERY_FEED on the parameter the API documents', () => {
    expect(GDELT_DOC_V2_CONTENT.accessPolicy.endpointKind).toBe('QUERY_FEED');
    expect(GDELT_DOC_V2_QUERY_PARAM).toBe('query');
    expect(GDELT_DOC_V2_CONTENT.accessPolicy.queryParam).toBe('query');
  });

  it('uses the GDELT connector, at rung 3', () => {
    expect(GDELT_DOC_V2_CONTENT.connectorType).toBe('NEWS_DISCOVERY_GDELT');
    expect(GDELT_DOC_V2_CONTENT.cascadeRung).toBe(3);
    // Tier 5: an index of other publishers is provenance, never independent corroboration (I6).
    expect(GDELT_DOC_V2_CONTENT.authorityTier).toBe(5);
    expect(GDELT_DOC_V2_CONTENT.contentFormat).toBe('JSON');
  });

  it('records the documented endpoint and does not drift from the template', () => {
    expect(GDELT_DOC_V2_ENDPOINT_URL).toBe('https://api.gdeltproject.org/api/v2/doc/doc');
    expect(GDELT_DOC_V2_ENDPOINT_URL).toBe(GDELT_TEMPLATE.accessPolicy.endpointUrl);
    expect(GDELT_DOC_V2_CONTENT.canonicalDomains).toEqual(GDELT_TEMPLATE.canonicalDomains);
    expect(new URL(GDELT_DOC_V2_ENDPOINT_URL).host).toBe(GDELT_DOC_V2_DOMAIN);
  });

  it('is a different publisher from the SEC, and therefore a different domain breaker', () => {
    // The point of the mixed live test: two domains, isolated. If these ever resolved to one
    // registrable domain, a failure at one publisher would suspend the other.
    expect(registrableDomain(GDELT_DOC_V2_DOMAIN)).not.toBe(
      registrableDomain(SEC_PRESS_RELEASES_CONTENT.canonicalDomains[0]),
    );
  });

  it('carries a budget sized for a query feed, below one full plan', () => {
    // Deliberate. A query feed costs one request per planned query, and a live plan for one
    // subject in one language is 53. A budget below that makes fan-out truncation happen inside
    // a single run, visibly, rather than at an unpredictable point in the next one.
    expect(GDELT_DOC_V2_HOURLY_BUDGET).toBe(24);
    expect(GDELT_DOC_V2_CONTENT.freeTierHourlyBudget).toBe(GDELT_DOC_V2_HOURLY_BUDGET);
    expect(GDELT_DOC_V2_CONTENT.freeTierDailyBudget).toBe(GDELT_DOC_V2_DAILY_BUDGET);
    expect(GDELT_DOC_V2_HOURLY_BUDGET).toBeLessThan(53);
  });

  it('records no poll floor, because a query feed has nothing to collapse', () => {
    // A floor here would be a rule `FixedFeedPollCache` never applies — the cache serves fixed
    // feeds only — and a rule enforced nowhere is the defect the SEC poll floor already was.
    expect(GDELT_DOC_V2_CONTENT.accessPolicy.pollFloorSeconds).toBeNull();
  });

  it('names no first-contact approval, so the fetch gate refuses it', () => {
    // D-042. The SEC's D17 is a decision about www.sec.gov and must never be copied here: an
    // approval that travelled between publishers would be no approval at all.
    expect(GDELT_DOC_V2_CONTENT.accessPolicy.firstContactApproval).toBeNull();
  });

  it('establishes no robots position, so the gate refuses it again', () => {
    // The two refusals are independent on purpose. Editing one must not make the source live.
    expect(GDELT_DOC_V2_CONTENT.robotsPosition).toBe('NOT_ESTABLISHED');
  });

  it('says in the record itself that nobody has loaded the endpoint', () => {
    expect(GDELT_DOC_V2_CONTENT.accessPolicy.policySummary).toContain('ENDPOINT NOT VERIFIED');
  });

  it('names no licence terms it has not read', () => {
    // `UNVERIFIED` is what a template records, and the gate refuses a source without named
    // terms. Whoever replaces it is stating they read them.
    expect(GDELT_DOC_V2_CONTENT.licenceTermsVersion).toBe('UNVERIFIED');
  });

  it('keeps the id the template is filed under, so the two name one source', () => {
    expect(GDELT_DOC_V2_SOURCE_ID).toBe('gdelt-doc-v2');
  });
});

/**
 * `searxng-adverse-media` — the internal metasearch service, proposed as a rung-5 source.
 *
 * A third shape again, and the contrast with the two above is where the value is. The SEC feed is
 * a publisher we have permission to contact; GDELT is a publisher we have not. This is **not a
 * publisher at all**, and the two fields that refuse every publisher in this registry are null
 * and unestablished here on purpose. The tests below exist so that nobody later "fixes" them.
 */
describe('searxng-adverse-media is an internal service, not a publisher', () => {
  it('is submittable against the FR-05 schema', () => {
    expect(() => searxngAdverseMediaContent()).not.toThrow();
  });

  it('records no endpoint URL, because the address is configuration rather than an approval', () => {
    // A loopback URL sitting in an approved record would be read by the next person as the
    // published address of a publisher. The connector reads SEARXNG_URL and addresses nothing
    // else; the registry has no business holding a second copy of a deployment detail.
    expect(SEARXNG_CONTENT.accessPolicy.endpointUrl).toBeNull();
  });

  it('records no first-contact approval, and that is not an omission to fill in', () => {
    // Everywhere else in this registry, null here means the fetch gate refuses. Here
    // `authoriseInternalDiscoveryService` does not read the field, because there is no third
    // party on the hop it authorises. It is null because it would be FALSE: nobody approved a
    // first contact with a service we started ourselves.
    expect(SEARXNG_CONTENT.accessPolicy.firstContactApproval).toBeNull();
  });

  it('records robots as NOT_ESTABLISHED, which is true and inert', () => {
    // There is no robots.txt to establish a position from. The gate issues
    // INTERNAL_SERVICE_NOT_A_PUBLISHER instead of reading this, and the publisher transport
    // refuses that value — so this record cannot authorise a document fetch by any route.
    expect(SEARXNG_CONTENT.robotsPosition).toBe('NOT_ESTABLISHED');
  });

  it('names us as the publisher, never an engine', () => {
    // The single confusion this whole milestone is written against. A record naming Google as
    // the publisher would put a search engine on the provenance line of a finding about a person.
    expect(SEARXNG_CONTENT.publisher).toContain('Erly');
    for (const engine of ['Google', 'Bing', 'Brave', 'DuckDuckGo', 'Reuters']) {
      expect(SEARXNG_CONTENT.publisher).not.toContain(engine);
      expect(SEARXNG_CONTENT.sourceName).not.toContain(engine);
    }
  });

  it('is lead-only authority, because a metasearch hit is a headline', () => {
    // Tier 5 is what stops axis D reading a discovery hit as corroboration in its own right.
    expect(SEARXNG_CONTENT.authorityTier).toBe(5);
  });

  it('sits at rung 5 with a connector type of its own', () => {
    expect(SEARXNG_CONTENT.cascadeRung).toBe(5);
    expect(SEARXNG_CONTENT.connectorType).toBe('NEWS_DISCOVERY_SEARXNG');
    // And it is NOT the Phase D placeholder, which names the `WebDiscoveryPort` seam that was
    // never built behind. The two are different types on purpose.
    expect(SEARXNG_CONTENT.connectorType).not.toBe('WEB_DISCOVERY_SEARX');
  });

  it('declares GLOBAL scope explicitly rather than leaving the country list empty', () => {
    // FR-05: an empty country list never means global on its own.
    expect(SEARXNG_CONTENT.jurisdictionScope).toBe('GLOBAL');
    expect(SEARXNG_CONTENT.countries).toEqual([]);
  });

  it('records a budget above the connector’s own per-search bound', () => {
    // The registry budget is a backstop against a loop, not the thing that shapes a normal run.
    // A budget that bites during ordinary use reads as a limit and behaves as an outage.
    expect(SEARXNG_HOURLY_BUDGET).toBeGreaterThan(DEFAULT_SEARXNG_LIMITS.maxQueriesPerSearch);
    expect(SEARXNG_CONTENT.freeTierHourlyBudget).toBe(SEARXNG_HOURLY_BUDGET);
  });

  it('says in the record itself that activating it authorises no engine', () => {
    // The policy summary is what an approver reads. If the separation between activating the
    // source and approving an engine is only in a code comment, the approver never sees it.
    const summary = SEARXNG_CONTENT.accessPolicy.policySummary;
    expect(summary).toContain('does NOT approve any upstream search engine');
    expect(summary).toContain('engine-governance.ts');
    expect(summary).toContain('D20');
  });

  it('holds no credential, which is part of why the external data cost is zero', () => {
    expect(SEARXNG_CONTENT.credentialsRef).toBeNull();
  });

  it('does not let a publisher borrow the no-endpoint exemption', () => {
    // The exemption exists because an internal service's address is configuration. A publisher
    // claiming it would be a QUERY_FEED with nowhere to send the query, which is exactly the
    // guess the original rule refuses to make at somebody else's server.
    expect(() =>
      sourceContentSchema.parse({
        ...SEARXNG_CONTENT,
        connectorType: 'NEWS_DISCOVERY_GDELT',
        jurisdictionScope: 'NAMED_COUNTRIES',
        countries: ['US'],
      }),
    ).toThrow(/must record the endpoint it queries/u);
  });

  it('refuses an internal service that records an endpoint URL after all', () => {
    // The rule in the other direction, and it matters more than it looks: a loopback URL on an
    // approved version is the single most likely way somebody later reads this record as a
    // publisher's published address.
    expect(() =>
      sourceContentSchema.parse({
        ...SEARXNG_CONTENT,
        accessPolicy: {
          ...SEARXNG_CONTENT.accessPolicy,
          endpointUrl: 'http://127.0.0.1:28888/search',
        },
      }),
    ).toThrow(/must NOT record an endpoint URL/u);
  });
});
