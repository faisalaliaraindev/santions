/**
 * `searxng-adverse-media` — the internal metasearch service, proposed as a rung-5 source.
 *
 * # One source, several engines, and why that is the right shape
 *
 * Every other source in this registry is a publisher. This one is a **service we run**, and the
 * publishers are downstream of it. That could have been modelled two ways and the other way is
 * worse:
 *
 * - *One source per engine* — `searxng-google-news`, `searxng-bing-news`, and so on. It would
 *   put the engine on the coverage line, which reads well, and it would be a lie about what was
 *   asked: one metasearch request serves every engine at once, so five sources would each
 *   record a request that was one request. It would also make one story found by four engines
 *   four coverage contributions, which is the independence-inflation FR-10 exists to stop,
 *   reintroduced at the registry layer where clustering cannot see it.
 * - *One source, engines in the result metadata* — this. One request, one budget, one coverage
 *   outcome, and the engines carried per candidate on `Lead.discovery` where a merged result
 *   carries all of them at once.
 *
 * The engine is therefore **not** in the registry at all. Engine approval lives in
 * `apps/api/src/sources/searxng/engine-governance.ts`, as code under review, because it is a
 * reading of somebody else's terms of use rather than a configuration value — and an admin form
 * is the wrong place to make a legal judgement. Activating this source does not activate a
 * single upstream engine; the two are deliberately separate acts.
 *
 * # What `authorityTier: 5` says
 *
 * The weakest tier: lead-only. It is the honest value twice over. A metasearch instance has no
 * authority over anything — it is a channel — and every candidate it produces is a headline
 * until the article behind it has been fetched and read. Tier 5 is what stops axis D counting a
 * discovery hit as corroboration on its own.
 *
 * # Why the budgets are small
 *
 * A `QUERY_FEED` costs one request per planned query, and a live plan for one subject in one
 * language is around 53 queries. The connector's own `maxQueriesPerSearch` bound is 12, so a
 * single search cannot exceed that however large the plan — and these numbers sit just above it
 * so that the registry budget is a backstop against a loop rather than the thing that shapes a
 * normal run. A budget that bites during ordinary use reads as a limit and behaves as an outage.
 *
 * # Fields that mean something different here, and say so
 *
 * - `canonicalDomains: ['searxng.internal']` — a placeholder for a service that has no public
 *   domain. `canonicalDomainSchema` requires a registrable-looking hostname and the field is
 *   used for domain health keying, so a value is required; `.internal` is the reserved suffix
 *   for exactly this and cannot resolve publicly. **Nothing fetches it.** The connector reads
 *   `SEARXNG_URL` from configuration and will address no other host.
 * - `accessPolicy.endpointUrl: null` — the address is deployment configuration, not something
 *   an approver signs. Recording one would put a loopback URL into an approved record where a
 *   reader would reasonably take it for the published address of a publisher.
 * - `accessPolicy.firstContactApproval: null` — and this one is **load-bearing in the opposite
 *   direction from every other source**. Everywhere else, null means the fetch gate refuses.
 *   Here `authoriseInternalDiscoveryService` does not read it, because there is no third party
 *   on the hop it authorises. It is null because it would be false: nobody approved a first
 *   contact with a service we started ourselves, and recording an approval to satisfy a field
 *   would put a signature on the record that nobody gave.
 * - `robotsPosition: 'NOT_ESTABLISHED'` — true, and inert. There is no robots.txt to establish a
 *   position on. The gate issues `INTERNAL_SERVICE_NOT_A_PUBLISHER` rather than reading this,
 *   and the publisher transport refuses that value, so it cannot authorise a document fetch.
 *
 * Those last two are the two fields that would let somebody read this record as a publisher
 * approval. They are null and unestablished, and the gate that would have read them is not the
 * gate this source goes through.
 *
 * # It is inert until a person activates it, and inert again until a person enables an engine
 *
 * Propose → submit → approve → activate, four-eyes intact. And then: `enabledEngines()` returns
 * whatever the governance table permits, and the gate refuses the query outright when that is
 * empty. Activating this source with no engine enabled produces a source that sits on the ladder
 * and records `NO_ENGINE_PERMITTED` on every run — which is a visible, accurate, entirely
 * useless source, and exactly what it should be until somebody decides on an engine.
 */

import { sourceContentSchema } from '@adverse-search/contracts';

/** The registry id. Stable, because it is written into every stored provenance record. */
export const SEARXNG_SOURCE_ID = 'searxng-adverse-media';

/**
 * The placeholder domain. See the file header — nothing resolves or fetches it.
 *
 * Exported so the one place that needs to recognise it does not re-spell it, and so a test can
 * assert that no fetch is ever addressed to it.
 */
export const SEARXNG_CANONICAL_DOMAIN = 'searxng.internal';

/** The rung. Rung 5 is "self-hosted metasearch over an approved engine mix" in FR-05's table. */
export const SEARXNG_CASCADE_RUNG = 5;

/**
 * Hourly and daily request budgets.
 *
 * Above the connector's own `maxQueriesPerSearch` of 12 so a normal search is never truncated by
 * the registry, and far below anything a loop could spend unnoticed. Exported because two things
 * read them and must not disagree: the proposal below, and any check stating the maximum number
 * of metasearch requests a live run can make.
 */
export const SEARXNG_HOURLY_BUDGET = 60;
export const SEARXNG_DAILY_BUDGET = 600;

export const SEARXNG_CONTENT = {
  sourceName: 'SearXNG adverse-media discovery (self-hosted)',
  // Us. Not Google, not Bing, not any engine — naming one here would be the exact confusion the
  // whole engine-governance arrangement exists to prevent.
  publisher: 'Adverse Search (self-hosted SearXNG instance)',
  connectorType: 'NEWS_DISCOVERY_SEARXNG',
  canonicalDomains: [SEARXNG_CANONICAL_DOMAIN],
  // Lead-only. See the file header.
  authorityTier: 5,
  cascadeRung: SEARXNG_CASCADE_RUNG,
  // A metasearch instance is not bounded by geography, and D-044 revised this deployment's
  // scope to worldwide. GLOBAL is declared explicitly rather than left as an empty country
  // list, because FR-05 is clear that an empty list never means global on its own.
  jurisdictionScope: 'GLOBAL',
  countries: [],
  languages: ['en'],
  // SEC-04: the registry holds a reference, never a value. There is no credential here at all —
  // the instance takes none, which is part of what makes the external data cost zero.
  credentialsRef: null,
  freeTierHourlyBudget: SEARXNG_HOURLY_BUDGET,
  freeTierDailyBudget: SEARXNG_DAILY_BUDGET,
  // See the adapter's descriptor comment: the JSON envelope is documented and versioned, and the
  // shape that actually breaks is what a scraping engine puts inside it, which nobody versions.
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  parserVersion: 'searxng-json-1',
  // Our own deployment of AGPL-3.0 software, queried by us. There is no third-party licence on
  // this hop to record — the upstream engines' terms are the real question, and they are
  // governed per engine rather than by one string here.
  licenceTermsVersion: 'self-hosted-searxng-agpl-3.0',
  licenceExpiresAt: null,
  // True and inert. See the file header.
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'JSON',
  accessPolicy: {
    // No published ceiling to honour: the instance is ours, and what bounds the traffic the
    // upstream engines see is the connector's own per-search query bound.
    requestCeilingPerSecond: null,
    // A query feed has no poll floor: every request carries a different query, so there is no
    // "same bytes again" for a floor to bound.
    pollFloorSeconds: null,
    // Configuration, not an approved address. See the file header.
    endpointUrl: null,
    endpointKind: 'QUERY_FEED',
    queryParam: 'q',
    conditionalGet: false,
    userAgentRequired: false,
    policyUrl: null,
    policySummary:
      'INTERNAL SERVICE, NOT A PUBLISHER. This record approves querying a SearXNG instance this ' +
      'deployment runs; the address comes from SEARXNG_URL and is never recorded here. It does ' +
      'NOT approve any upstream search engine. Engine approval is recorded per engine in ' +
      'apps/api/src/sources/searxng/engine-governance.ts, as reviewed code rather than ' +
      'configuration, because it is a reading of a third party’s terms of use. Google is ' +
      'refused there under D20 and is additionally disabled on the instance itself. A query ' +
      'naming no permitted engine is refused by the gate rather than sent, because a request ' +
      'naming no engine is served by the instance defaults. Every article this service names is ' +
      'a LEAD: it is fetched from its original publisher through the ordinary fetch gate, under ' +
      'that publisher’s own approval, robots position and first-contact approval, or it ' +
      'produces no supported finding at all.',
    stopConditions: {
      // Nothing to halt on by status: a status from our own instance is a fact about our
      // deployment, and the FR-06 table already decides what a 5xx means.
      haltOnStatuses: [] as number[],
      // The instance's limiter is off and the only client is this service, so a rate limit from
      // it would mean our own bound is wrong — which is worth stopping to look at.
      haltOnRateLimit: true,
      rateLimitCooldownSeconds: 600,
      serverErrorStreakToHalt: 3,
      requiresFreshApprovalOnHalt: false,
    },
    // Null, and deliberately so. See the file header: there is no third party on this hop, and
    // a signature recorded to satisfy a field is a signature nobody gave.
    firstContactApproval: null,
  },
} as const;

/**
 * The content, parsed through the contract schema.
 *
 * `parse` rather than the literal, for the reason every other proposal in this directory gives:
 * a field renamed in the schema fails here, at the moment it is renamed, rather than becoming a
 * conformance error an administrator meets when they try to submit.
 */
export function searxngAdverseMediaContent(): Record<string, unknown> {
  return sourceContentSchema.parse(SEARXNG_CONTENT);
}
