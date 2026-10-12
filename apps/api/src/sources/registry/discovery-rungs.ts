/**
 * Source version **templates** for the discovery rungs — FR-05 rungs 2, 3 and 4.
 *
 * # These are templates, not proposals. Read why before using one.
 *
 * `sec-litigation-releases.ts` is a *proposal*: every fact in it was established by desk research
 * on a named date, and it carries a named first-contact approval. These are not that. **Nobody
 * has verified these endpoints**, and this project has made no request to any of them.
 *
 * So each one is deliberately inert, in two independent ways:
 *
 * - `firstContactApproval: null` — the fetch gate refuses every request to a source without one
 *   (**D-042**), so a template cannot be used by accident even if it were activated.
 * - `robotsPosition: 'NOT_ESTABLISHED'` — the gate refuses that too, because nobody has read the
 *   publisher's robots.txt.
 *
 * Both have to be filled in by a person who has actually checked, through the approval lifecycle.
 * Until then a template activates into a source that sits on the ladder and is never called.
 *
 * **What is genuinely unverified is the `endpointUrl` of each.** The shapes below are the widely
 * documented ones, and a widely documented URL is still a guess until somebody loads it. That is
 * why `policySummary` says so on every one of them, in the record itself rather than only here —
 * a record is read by whoever approves it, and this file is not.
 *
 * # What rungs 3 and 4 cost in code, and why they differ
 *
 * **Rung 4, Bing News RSS: no code at all.** It is `NEWS_DISCOVERY_RSS` — the same connector as
 * the SEC feed, at a different approved address, with `endpointKind: QUERY_FEED` so the query
 * goes in as one parameter. That is D-043 working: adding a publisher is an approval.
 *
 * **Rung 3, GDELT: a parser.** It returns JSON rather than a feed, so it needed
 * `GdeltDiscoveryAdapter` and a connector type of its own. A new connector type means a new
 * *response format*, not a new source — and if adding a publisher ever seems to need one, the
 * question to ask is whether it really does.
 */

import { sourceContentSchema } from '@adverse-search/contracts';

/**
 * The stop conditions a discovery source gets by default.
 *
 * Softer than the SEC's, deliberately. The SEC publishes a policy saying a 403 means the user
 * agent is wrong, so D17 records "403 halts". These publishers publish no such statement, so
 * escalating beyond FR-06 on a 403 would be inventing a rule on their behalf. What stays is the
 * part that is ours to decide: being rate-limited means the recorded rate was wrong, and the
 * answer to a wrong rate is to stop and look at it.
 */
const DEFAULT_STOP_CONDITIONS = {
  haltOnStatuses: [] as number[],
  haltOnRateLimit: true,
  rateLimitCooldownSeconds: 600,
  serverErrorStreakToHalt: 3,
  requiresFreshApprovalOnHalt: true,
};

const UNVERIFIED =
  'ENDPOINT NOT VERIFIED. This address is the widely documented one and has not been loaded by ' +
  'this project. Confirm it, read the publisher robots.txt, and record a named first-contact ' +
  'approval before activating. Until all three are done the fetch gate refuses every request to ' +
  'this source, which is the safe direction.';

/**
 * Rung 2 — Google News RSS, per language and edition.
 *
 * # DO NOT ACTIVATE THIS. It is refused, not merely unverified. See D20.
 *
 * Every other template in this file is inert because nobody has checked it yet. This one is inert
 * because somebody checked, on 2026-09-22, and the answer was no. The difference matters: the
 * others are waiting for evidence, and this one **has** its evidence
 * (`docs/sources/evidence/google-news-rss-en-us.json`).
 *
 * **The licence.** Google's News Terms of Use restrict the service to *"your own personal use
 * (i.e., non-commercial use)"* and separately forbid *"any robot, spider, other device or manual
 * process to monitor or copy any content from the Service"*. This is a commercial screening
 * product that would poll automatically. Either clause alone excludes it. That the `/rss/search`
 * endpoint is undocumented is not a loophole — an undocumented endpoint carries no separate grant,
 * so the general terms are the only terms there are.
 *
 * **This project has never sent a request to `news.google.com`, and must not.** The terms were read
 * before the endpoint, and loading the feed to "verify" it would be performing the prohibited act
 * in order to decide whether the act is prohibited.
 *
 * **A second defect that outlives the licence question.** Since late 2024 the feed's `<item><link>`
 * is a Google redirect (`/rss/articles/CBMi<token>`), not the publisher's article URL. Resolving it
 * needs either another request to Google or reverse-engineering a signed protobuf token, and
 * `<source url>` gives only the publisher's *domain*. FR-09 provenance names a document, never a
 * domain — so even with permission, a finding from here could not be checked by a reviewer.
 *
 * The connector was never the missing piece: `NEWS_DISCOVERY_RSS` below already works, and would
 * have fetched this feed mechanically on day one. What is missing is the right to use it.
 *
 * `discovery-rungs.test.ts` fails if this template stops recording the refusal.
 */
export const GOOGLE_NEWS_RSS_TEMPLATE = {
  sourceName: 'Google News RSS (en-US edition)',
  publisher: 'Google',
  connectorType: 'NEWS_DISCOVERY_RSS',
  canonicalDomains: ['news.google.com'],
  // Tier 5: an aggregator is provenance, never independent corroboration. Ten copies of one wire
  // story are one report (I6), and the tier is what stops axis D counting them as more.
  authorityTier: 5,
  cascadeRung: 2,
  countries: ['US'],
  languages: ['en'],
  credentialsRef: null,
  freeTierHourlyBudget: 60,
  freeTierDailyBudget: 500,
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  parserVersion: 'google-news-rss-1',
  licenceTermsVersion: 'UNVERIFIED',
  licenceExpiresAt: null,
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'XML_FEED',
  accessPolicy: {
    requestCeilingPerSecond: null,
    pollFloorSeconds: null,
    endpointUrl: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en',
    // A search, so one request per planned query. That is the expensive kind, and recording it
    // is what lets the budget above mean something.
    endpointKind: 'QUERY_FEED',
    queryParam: 'q',
    conditionalGet: true,
    userAgentRequired: false,
    policyUrl: null,
    policySummary:
      `${UNVERIFIED} Google publishes no fair-access figures for this feed, so the ceiling is ` +
      `recorded as unknown rather than guessed. ` +
      `REFUSED 2026-09-22 (D20) — DO NOT ACTIVATE. Google's News Terms of Use permit only ` +
      `"your own personal use (i.e., non-commercial use)" and forbid "any robot, spider, other ` +
      `device or manual process to monitor or copy any content from the Service". This service is ` +
      `commercial and automated, so both clauses are engaged. Separately, the feed's item links are ` +
      `Google redirects rather than publisher article URLs, so FR-09 provenance cannot be met even ` +
      `with permission. The endpoint has deliberately never been loaded by this project.`,
    stopConditions: DEFAULT_STOP_CONDITIONS,
    firstContactApproval: null,
  },
} as const;

/** Rung 3 — GDELT DOC 2.0. Template only. Needs `GdeltDiscoveryAdapter`. */
export const GDELT_TEMPLATE = {
  sourceName: 'GDELT DOC 2.0 (global article index)',
  publisher: 'The GDELT Project',
  connectorType: 'NEWS_DISCOVERY_GDELT',
  canonicalDomains: ['api.gdeltproject.org'],
  authorityTier: 5,
  cascadeRung: 3,
  // GDELT is global by construction. Listing every country it indexes would be a fiction; what
  // is recorded is what this deployment intends to search with it, and FR-05 forbids a regional
  // pseudo-code standing in for that.
  countries: ['US'],
  languages: ['en'],
  credentialsRef: null,
  freeTierHourlyBudget: 60,
  freeTierDailyBudget: 500,
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  parserVersion: 'gdelt-doc-2.0-artlist-1',
  licenceTermsVersion: 'UNVERIFIED',
  licenceExpiresAt: null,
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'JSON',
  accessPolicy: {
    requestCeilingPerSecond: null,
    pollFloorSeconds: null,
    endpointUrl: 'https://api.gdeltproject.org/api/v2/doc/doc',
    endpointKind: 'QUERY_FEED',
    queryParam: 'query',
    // GDELT's article list carries no ETag worth conditioning on, and the connector sets
    // `mode` and `format` itself so a recorded endpoint cannot override them.
    conditionalGet: false,
    userAgentRequired: false,
    policyUrl: null,
    policySummary: `${UNVERIFIED} GDELT asks for reasonable use rather than publishing a numeric ceiling, so the ceiling is recorded as unknown.`,
    stopConditions: DEFAULT_STOP_CONDITIONS,
    firstContactApproval: null,
  },
} as const;

/** Rung 4 — Bing News RSS. Template only. **No code**: the RSS connector at another address. */
export const BING_NEWS_RSS_TEMPLATE = {
  sourceName: 'Bing News RSS',
  publisher: 'Microsoft',
  connectorType: 'NEWS_DISCOVERY_RSS',
  canonicalDomains: ['www.bing.com'],
  authorityTier: 5,
  cascadeRung: 4,
  countries: ['US'],
  languages: ['en'],
  credentialsRef: null,
  freeTierHourlyBudget: 60,
  freeTierDailyBudget: 500,
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  // The same parser as every other RSS source. It is the *source* that differs, not the code.
  parserVersion: 'bing-news-rss-1',
  licenceTermsVersion: 'UNVERIFIED',
  licenceExpiresAt: null,
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'XML_FEED',
  accessPolicy: {
    requestCeilingPerSecond: null,
    pollFloorSeconds: null,
    endpointUrl: 'https://www.bing.com/news/search?format=RSS',
    endpointKind: 'QUERY_FEED',
    queryParam: 'q',
    conditionalGet: true,
    userAgentRequired: false,
    policyUrl: null,
    policySummary: `${UNVERIFIED} Microsoft publishes no fair-access figures for this feed, so the ceiling is recorded as unknown rather than guessed.`,
    stopConditions: DEFAULT_STOP_CONDITIONS,
    firstContactApproval: null,
  },
} as const;

/** Every template, keyed by the id it would be proposed under. */
export const DISCOVERY_RUNG_TEMPLATES = {
  'google-news-rss-en-us': GOOGLE_NEWS_RSS_TEMPLATE,
  'gdelt-doc-v2': GDELT_TEMPLATE,
  'bing-news-rss': BING_NEWS_RSS_TEMPLATE,
} as const;

/**
 * A template parsed through the contract schema.
 *
 * Calling `parse` rather than exporting the literal is what turns a renamed schema field into a
 * failing test here, at the moment it is renamed, rather than a conformance error an
 * administrator meets when they try to submit.
 */
export function discoveryRungTemplate(
  id: keyof typeof DISCOVERY_RUNG_TEMPLATES,
): Record<string, unknown> {
  return sourceContentSchema.parse(DISCOVERY_RUNG_TEMPLATES[id]);
}
