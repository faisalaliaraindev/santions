/**
 * The SEC litigation-releases feed — the source **D17** names as this project's first
 * deliberate live contact.
 *
 * # What this file is, and what it is not
 *
 * It is the **content of a source version, written down before anybody proposes it**, so that
 * the record an approver signs can be read in a diff rather than typed into a form. It is not
 * an activation. Nothing here puts a source in the registry: that happens through the D1
 * lifecycle — proposed by one person, approved by a second, activated — and the named approval
 * D17 requires is an act of the source admin, not of a deployment.
 *
 * **No live request has been made to this or any other source at the time this file is
 * written.** Phase B of the current plan makes the first one, and it is a single GET of
 * `robots.txt`.
 *
 * # Why this source and not a Costa Rican one
 *
 * D17 asked for a source "whose terms permit automated access in plain words and whose
 * robots.txt allows the path, so that the first request this project ever makes is one nobody
 * has to argue about afterwards". The SEC publishes these feeds as a service, publishes a
 * fair-access policy stating the ceiling in numbers, and is an institution whose expectations
 * are written down rather than inferred. A Costa Rican official publisher is the opposite
 * proposition on every count, and the first contact this project makes should not be the one
 * that needs a judgement call.
 *
 * It is **not Costa Rican coverage** and must never be read as any. It is a US enforcement feed,
 * in English, and its role is to be the source against which the live path is proved. D-010
 * enables Costa Rica; the CR evidence base is open decision **D15**.
 *
 * # The facts recorded below
 *
 * Established on **2026-09-15** by desk research, from the SEC's published pages. They are
 * recorded here as of that date and the policy itself says it may change, which is why the
 * plan's first live act is to re-read `robots.txt` at fetch time rather than to trust this file.
 *
 * - The user agent must be descriptive and carry a contact address. Without one, requests are
 *   refused with **403** and the IP may be blocked for about ten minutes. That is why a plain
 *   in-browser fetch cannot work at all: browser JavaScript cannot set a user agent, so this
 *   must be server-side.
 * - The rate ceiling is **10 requests per second per IP**, aggregated across machines.
 *   Exceeding it returns **429** and a temporary block.
 * - Our recorded usage is **one conditional GET every fifteen minutes** — about 0.001 req/s,
 *   roughly a thousandth of the ceiling. Most polls return **304** and no body.
 */

import { sourceContentSchema, type SourceAccessPolicy } from '@erly/adverse-contracts';
import type { StopConditionPolicy } from '@erly/adverse-domain';

/** The registry id. Stable, because it is written into every stored provenance record. */
export const SEC_LITIGATION_RELEASES_SOURCE_ID = 'sec-litigation-releases';

/** The feed itself. */
export const SEC_LITIGATION_RELEASES_FEED_URL =
  'https://www.sec.gov/enforcement-litigation/litigation-releases/rss';

/** The second feed named in the plan. Not proposed here — one source goes live at a time. */
export const SEC_PRESS_RELEASES_FEED_URL = 'https://www.sec.gov/news/pressreleases.rss';

/** Where the SEC publishes the feed index, for the record. */
export const SEC_RSS_INDEX_URL = 'https://www.sec.gov/about/rss-feeds';

/**
 * The minimum interval between polls, in milliseconds.
 *
 * Fifteen minutes. It is a **floor**, not a schedule: a scheduler may poll less often, never
 * more. Litigation releases appear a handful of times a week, so a faster poll would buy
 * nothing and spend somebody else's bandwidth to buy it.
 */
export const SEC_POLL_FLOOR_MS = 15 * 60_000;

/** The SEC's published ceiling, per IP, aggregated across machines. Recorded, never a target. */
export const SEC_REQUEST_CEILING_PER_SECOND = 10;

/**
 * The D17 stop conditions, in the domain's vocabulary.
 *
 * Derived from the same `accessPolicy` block below — this constant exists so a test can assert
 * the two agree, because the registry record is what runs and a constant that drifts from it
 * would be a stop condition somebody believes is in force and is not.
 *
 * Each one is an escalation of FR-06, never a relaxation:
 *
 * - **403 halts.** FR-06 would treat it as a soft block and retry once from another identity.
 *   The SEC's policy says a 403 means the user agent is wrong, so a retry is not a recovery —
 *   it is repeating the thing they asked us not to do. Resuming needs a person.
 * - **429 halts after its cooldown.** The cooldown is honoured in full — ten minutes, matching
 *   the block duration their policy states — and then polling stops rather than resumes. Being
 *   rate-limited at roughly a thousandth of the published ceiling would mean the recorded rate
 *   is wrong, and the answer to a wrong rate is to look at it.
 * - **Three consecutive server errors halt.** Backing off further is still traffic at a site
 *   that is not answering.
 *
 * The daily cap is a separate, dumber backstop: `freeTierDailyBudget` below, which D5's breaker
 * already enforces without anything new being written. So is the kill switch.
 */
export const SEC_STOP_CONDITIONS: StopConditionPolicy = {
  haltOnStatuses: [403],
  haltOnRateLimit: true,
  rateLimitCooldownMs: 10 * 60_000,
  serverErrorStreakToHalt: 3,
  requiresFreshApprovalOnHalt: true,
};

const SEC_ACCESS_POLICY: SourceAccessPolicy = {
  requestCeilingPerSecond: SEC_REQUEST_CEILING_PER_SECOND,
  pollFloorSeconds: SEC_POLL_FLOOR_MS / 1000,
  endpointUrl: SEC_LITIGATION_RELEASES_FEED_URL,
  conditionalGet: true,
  userAgentRequired: true,
  policyUrl: 'https://www.sec.gov/about/webmaster-frequently-asked-questions',
  policySummary:
    'Every request must carry a descriptive User-Agent naming the application and a contact ' +
    'email address; requests without one are refused with 403 and the originating IP may be ' +
    'blocked for approximately ten minutes. The rate ceiling is 10 requests per second per IP, ' +
    'aggregated across machines; exceeding it returns 429 and a temporary block. The SEC ' +
    'publishes these RSS feeds as a service and states the policy may change, so robots.txt is ' +
    're-read at fetch time rather than trusted from this record. Established by desk research ' +
    'on 2026-09-15.',
  stopConditions: {
    haltOnStatuses: [...SEC_STOP_CONDITIONS.haltOnStatuses],
    haltOnRateLimit: SEC_STOP_CONDITIONS.haltOnRateLimit,
    rateLimitCooldownSeconds: SEC_STOP_CONDITIONS.rateLimitCooldownMs / 1000,
    serverErrorStreakToHalt: SEC_STOP_CONDITIONS.serverErrorStreakToHalt,
    requiresFreshApprovalOnHalt: SEC_STOP_CONDITIONS.requiresFreshApprovalOnHalt,
  },
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
 * `freeTierHourlyBudget: 6` and `freeTierDailyBudget: 120` are the dumb backstop, not the rate.
 * At a fifteen-minute floor the feed itself needs four polls an hour and ninety-six a day, and
 * each poll also fetches or re-reads `robots.txt` on a cold cache. Six and a hundred and twenty
 * leave room for that without leaving room for a loop: a mistake exhausts the budget and
 * produces a recorded coverage gap, rather than producing an incident at the publisher.
 *
 * `stabilityClass: 'UNDOCUMENTED_VOLATILE'` even though the SEC is about as documented a
 * publisher as exists. The class is a statement about the **feed shape we parse**, not about
 * the institution: nobody has promised us the item shape will not change, and a silent shape
 * change drops recall to zero while the service keeps reporting clean results. That is the
 * failure FR-05's volatility control exists for, and claiming `DOCUMENTED_STABLE` here would
 * exempt this source from the scheduled contract test that detects it (step 6, T84).
 *
 * `robotsPosition: 'NOT_ESTABLISHED'`, deliberately, and it is the honest value **today**: no
 * request has been made, so nobody has read their robots.txt. Phase B's first live act reads it
 * and the position is updated through the lifecycle on what it actually says. Recording
 * `HONOURED` now would be recording a check that has not happened, in the record the fetch gate
 * reads.
 */
export const SEC_LITIGATION_RELEASES_CONTENT = {
  sourceName: 'SEC litigation releases (RSS)',
  publisher: 'US Securities and Exchange Commission',
  connectorType: 'NEWS_DISCOVERY_RSS',
  canonicalDomains: ['www.sec.gov'],
  // Tier 1: a regulator's own record of an enforcement action it brought. Authority for the
  // reported act — never confidence that the person named is the subject being screened.
  authorityTier: 1,
  // Rung 1 of the FR-05 cascade: a known primary source queried directly, not web discovery.
  cascadeRung: 1,
  countries: ['US'],
  languages: ['en'],
  credentialsRef: null,
  freeTierHourlyBudget: 6,
  freeTierDailyBudget: 120,
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  parserVersion: 'sec-litigation-rss-1',
  licenceTermsVersion: 'sec-fair-access-2026-09-15',
  licenceExpiresAt: null,
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'XML_FEED',
  accessPolicy: SEC_ACCESS_POLICY,
} as const;

/**
 * The content, parsed through the contract schema.
 *
 * Calling `parse` rather than exporting the literal is the point: a field renamed in the schema
 * becomes a failure in the test that reads this, at the moment it is renamed, rather than a
 * conformance error an administrator meets when they try to submit the proposal.
 */
export function secLitigationReleasesContent(): Record<string, unknown> {
  return sourceContentSchema.parse(SEC_LITIGATION_RELEASES_CONTENT);
}
