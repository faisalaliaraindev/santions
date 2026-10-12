/**
 * The SEC **press-releases** feed — the second feed D17 names, proposed as its own source.
 *
 * # Why a second source rather than a second URL on the first
 *
 * `sec-litigation-releases` and this are two lists the same publisher maintains at two
 * addresses. They are one *publisher* and two *sources*, and the registry model is the reason
 * that distinction has to be kept:
 *
 * - **A source version records one `endpointUrl`.** A source with two would have to choose one
 *   per call, and the thing choosing would be code rather than an approval (**D-043**).
 * - **Coverage is reported per source.** Folding the press releases into the litigation source
 *   would make "the litigation feed answered" true when what answered was a different list — and
 *   a coverage statement that cannot name what was read is not one.
 * - **Source health is per source; domain health is per domain.** Both feeds live on `sec.gov`,
 *   so they *already* share the publisher-level breaker through `DomainHealthService`, which is
 *   keyed on the registrable domain. Giving them one source record as well would also merge the
 *   budgets and the parser version, which are properties of the feed, not of the publisher.
 *
 * So: a distinct `sourceId`, its own budget, its own parser version, its own coverage outcome —
 * and the same publisher policy, the same licence terms and the same `sec.gov` domain health,
 * because those really are shared.
 *
 * # What is reused from `sec-litigation-releases.ts`, and why each one is correct
 *
 * - `SEC_STOP_CONDITIONS` — published by the SEC about requests to `sec.gov`, not about a path.
 * - `SEC_REQUEST_CEILING_PER_SECOND` — the same fair-access ceiling, per IP, aggregated.
 * - `SEC_POLL_FLOOR_MS` — our own recorded minimum interval; press releases are no busier.
 * - The policy URL and summary — one published policy page covers the whole host.
 * - `licenceTermsVersion` — one set of terms, one version string.
 * - `canonicalDomains` — literally the same host.
 *
 * **Not reused: the parser version and the budgets.** `sec-press-rss-1` is a different item
 * shape to track under FR-05's volatility control, and a budget shared between two feeds would
 * let a loop in one exhaust the other's allowance without either record saying so.
 *
 * # The first-contact approval
 *
 * `firstContactApproval` carries **D17**, and that is not a borrowed approval. D17's own text
 * names this feed: "the SEC litigation-releases RSS feed ... with the press-releases feed as a
 * second, later." The approval is for contacting **this publisher**, by a named person, on a
 * named date, and the decision recorded both addresses at the time it was closed.
 *
 * # `robotsPosition` is `NOT_ESTABLISHED`, deliberately
 *
 * `docs/sources/sec-robots-evidence.json` records a real read of `https://www.sec.gov/robots.txt`
 * on 2026-09-16, and the path this feed sits on — `/news/pressreleases.rss` — is not disallowed
 * by the body it captured. That is evidence an approver can act on. It is **not** a position this
 * file may record on their behalf: the evidence names `feedPathChecked:
 * /enforcement-litigation/litigation-releases/rss`, so somebody has to look at the other path and
 * say so. Until they do, the fetch gate refuses this source, which is the safe direction.
 *
 * The runtime check is unaffected either way — `HttpEvidenceFetchAdapter` re-reads robots at
 * fetch time rather than trusting this record.
 */

import { sourceContentSchema, type SourceAccessPolicy } from '@adverse-search/contracts';

import {
  SEC_POLL_FLOOR_MS,
  SEC_PRESS_RELEASES_FEED_URL,
  SEC_REQUEST_CEILING_PER_SECOND,
  SEC_STOP_CONDITIONS,
} from './sec-litigation-releases.js';

/** The registry id. Stable, because it is written into every stored provenance record. */
export const SEC_PRESS_RELEASES_SOURCE_ID = 'sec-press-releases';

/** The endpoint, re-exported so a caller need not reach into the litigation-releases module. */
export { SEC_PRESS_RELEASES_FEED_URL };

/** The one domain both SEC feeds share, and therefore share a domain breaker on. */
export const SEC_CANONICAL_DOMAIN = 'www.sec.gov';

const SEC_PRESS_RELEASES_ACCESS_POLICY: SourceAccessPolicy = {
  requestCeilingPerSecond: SEC_REQUEST_CEILING_PER_SECOND,
  pollFloorSeconds: SEC_POLL_FLOOR_MS / 1000,
  endpointUrl: SEC_PRESS_RELEASES_FEED_URL,
  // The whole feed, polled and matched locally. The SEC publishes press releases as a list, not
  // as a search — so this is a FIXED_FEED for the same reason the litigation feed is, and the
  // consequence is the one that matters operationally: its request cost is a property of the
  // feed and the poll floor, never of the size of the query plan.
  endpointKind: 'FIXED_FEED',
  queryParam: null,
  conditionalGet: true,
  userAgentRequired: true,
  policyUrl: 'https://www.sec.gov/about/webmaster-frequently-asked-questions',
  policySummary:
    'Every request must carry a descriptive User-Agent naming the application and a contact ' +
    'email address; requests without one are refused with 403 and the originating IP may be ' +
    'blocked for approximately ten minutes. The rate ceiling is 10 requests per second per IP, ' +
    'aggregated across machines; exceeding it returns 429 and a temporary block. The same ' +
    'published policy covers every path on www.sec.gov, so it is recorded identically here and ' +
    'on sec-litigation-releases. ROBOTS POSITION NOT ESTABLISHED FOR THIS PATH: the recorded ' +
    'read of www.sec.gov/robots.txt on 2026-09-16 checked ' +
    '/enforcement-litigation/litigation-releases/rss, not /news/pressreleases.rss. Establish it ' +
    'before activating.',
  stopConditions: {
    haltOnStatuses: [...SEC_STOP_CONDITIONS.haltOnStatuses],
    haltOnRateLimit: SEC_STOP_CONDITIONS.haltOnRateLimit,
    rateLimitCooldownSeconds: SEC_STOP_CONDITIONS.rateLimitCooldownMs / 1000,
    serverErrorStreakToHalt: SEC_STOP_CONDITIONS.serverErrorStreakToHalt,
    requiresFreshApprovalOnHalt: SEC_STOP_CONDITIONS.requiresFreshApprovalOnHalt,
  },
  // D17 named this feed alongside the litigation one. See the file header.
  firstContactApproval: {
    approvedBy: 'Faisal Ali',
    role: 'Source admin',
    approvedOn: '2026-09-15',
    decision: 'D17',
  },
};

/**
 * The proposed source version content, exactly as it will be submitted.
 *
 * Budgets are this feed's own — six an hour, a hundred and twenty a day — rather than a share of
 * the litigation feed's. At a fifteen-minute floor a feed needs four polls an hour; the rest is
 * headroom for a cold-cache robots read and nothing more. A mistake exhausts one feed's budget
 * and produces a recorded coverage gap on one source, which is precisely the blast radius a
 * separate record buys.
 *
 * `authorityTier: 1` — a regulator's own record of an action it took. Authority for the reported
 * act, never confidence that the person named is the subject being screened.
 *
 * `cascadeRung: 1` — the same rung as the litigation feed. Two sources at one rung is ordinary:
 * `CascadeService` asks every entry at a rung, and each records its own attempt.
 */
export const SEC_PRESS_RELEASES_CONTENT = {
  sourceName: 'SEC press releases (RSS)',
  publisher: 'US Securities and Exchange Commission',
  connectorType: 'NEWS_DISCOVERY_RSS',
  canonicalDomains: [SEC_CANONICAL_DOMAIN],
  authorityTier: 1,
  cascadeRung: 1,
  countries: ['US'],
  languages: ['en'],
  credentialsRef: null,
  freeTierHourlyBudget: 6,
  freeTierDailyBudget: 120,
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  // A different list in a different template. Tracked separately under FR-05's volatility
  // control so a shape change in one feed does not read as a shape change in the other.
  parserVersion: 'sec-press-rss-1',
  licenceTermsVersion: 'sec-fair-access-2026-09-15',
  licenceExpiresAt: null,
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'XML_FEED',
  accessPolicy: SEC_PRESS_RELEASES_ACCESS_POLICY,
} as const;

/**
 * The content, parsed through the contract schema.
 *
 * `parse` rather than the literal, for the reason `secLitigationReleasesContent` gives: a field
 * renamed in the schema fails here, at the moment it is renamed, rather than becoming a
 * conformance error an administrator meets when they try to submit the proposal.
 */
export function secPressReleasesContent(): Record<string, unknown> {
  return sourceContentSchema.parse(SEC_PRESS_RELEASES_CONTENT);
}
