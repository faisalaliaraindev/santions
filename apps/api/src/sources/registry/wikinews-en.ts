/**
 * `wikinews-en` — English Wikinews as a **publisher we may fetch from**, rung 5's first one.
 *
 * # This record exists because of an architectural rule, not because Wikinews is special
 *
 * **Discovery permission and publisher-fetch permission are separate decisions.** Approving
 * `searxng-adverse-media` approves *querying our own SearXNG instance*. It does not, and must
 * not, approve fetching articles from whatever that instance happens to name — that would turn
 * one signature on an internal record into an approval to contact every publisher on the open
 * web, which is the opposite of what D-042 is for. So the fetch gate authorises a discovered
 * document against the registry record covering **the domain being contacted**, and a domain no
 * record covers is refused per candidate (`PUBLISHER_NOT_APPROVED`) without stopping the others.
 *
 * The consequence is that metasearch discovery produces candidates from many publishers and
 * findings from none of them until somebody approves a publisher. This is the first such
 * approval, deliberately scoped to **one domain**.
 *
 * # Why this publisher first
 *
 * It is the one engine in the D21 matrix whose reading rests on published evidence rather than
 * on an acceptance of residual risk, and all three facts are published by the Wikimedia
 * Foundation rather than inferred:
 *
 * - SearXNG reaches it through the generic mediawiki engine against `en.wikinews.org`'s
 *   **MediaWiki Action API** — `use_official_api: true`. The publisher's own documented
 *   interface, used for what it is documented for.
 * - Wikimedia publish an **API etiquette** that expressly contemplates automated clients and
 *   asks for a descriptive user agent and serial requests. That is exactly what this service
 *   does: `FETCH_CONTACT_URL` builds the agent, and `RequestPacer` serialises.
 * - Wikinews content is **CC BY 2.5**, which permits commercial reuse with attribution, so
 *   there is no licence question of the kind D20 turned on for Google.
 *
 * It remains a **weak adverse-media source** and nobody should pretend otherwise — a volunteer
 * news wiki, not a wire service. `authorityTier: 4` says so. That is a statement about how much
 * weight a finding from it carries, and it is deliberately not a reason to refuse the fetch:
 * FR-11 bands the evidence, the registry decides whether we are allowed to read it at all.
 *
 * # What is NOT done here, and must not be done by editing this file
 *
 * This record is written as **PROPOSED and not activatable**, and two fields say so:
 *
 * - **`robotsPosition: 'NOT_ESTABLISHED'`** — nobody has read `en.wikinews.org/robots.txt`. The
 *   gate refuses a fetch on this value, correctly. Establishing it means making a request to a
 *   publisher this project has never contacted, which is the act the next field governs.
 * - **`firstContactApproval: null`** — no named person has accepted that this service would
 *   begin making requests to Wikimedia. D-042 is not weakened by this record and is not meant
 *   to be: a publisher can be fully configured, schema-valid and still unreachable.
 *
 * Filling either field is a **named human decision**, taken through the approval lifecycle with
 * two distinct principals, not a code edit made to get a test to pass. Until both are filled,
 * every Wikinews candidate is refused with a reason that names this record — which is the
 * honest state, not a gap to be closed by whoever reads this next.
 */

import { sourceContentSchema } from '@erly/adverse-contracts';

export const WIKINEWS_EN_SOURCE_ID = 'wikinews-en';

/** The single domain this approval would cover. Not `wikinews.org`, not `*.wikimedia.org`. */
export const WIKINEWS_EN_CANONICAL_DOMAIN = 'en.wikinews.org';

/**
 * The access policy.
 *
 * `endpointUrl: null` because this source is **never polled**. It has no feed of its own that we
 * read; it is reached only by following a link a discovery service produced, which is what
 * `EVIDENCE_FETCH_HTTP` means. A recorded endpoint here would be a second way to reach the
 * publisher that the discovery path does not go through (**D-043**).
 *
 * The rate ceiling and stop conditions are Wikimedia's etiquette expressed as machine-readable
 * limits: serial requests, and a hard stop on the two statuses that mean "stop asking".
 */
export const WIKINEWS_EN_ACCESS_POLICY = {
  requestCeilingPerSecond: 1,
  pollFloorSeconds: null,
  endpointUrl: null,
  endpointKind: 'FIXED_FEED',
  queryParam: null,
  conditionalGet: true,
  userAgentRequired: true,
  policyUrl: 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use',
  policySummary:
    'Wikinews content is licensed CC BY 2.5, which permits commercial reuse with attribution. ' +
    'Wikimedia publish an API etiquette that expressly contemplates automated clients and asks ' +
    'for a descriptive User-Agent identifying the application with a contact address, and for ' +
    'requests to be made serially rather than in parallel. This record commits to both. It ' +
    'covers en.wikinews.org and no other Wikimedia property: the other projects have their own ' +
    'communities and their own content, and an approval that covered them all would be an ' +
    'approval nobody scoped. ESTABLISHED BY DESK RESEARCH ONLY — robots.txt has NOT been read ' +
    'and no request has been made to this publisher.',
  stopConditions: {
    haltOnStatuses: [403, 429],
    haltOnRateLimit: true,
    rateLimitCooldownSeconds: 600,
    serverErrorStreakToHalt: 3,
    requiresFreshApprovalOnHalt: true,
  },
  // **Deliberately null.** See the file header. Filling this is a named human decision taken
  // through the approval lifecycle, and it is what stands between this record and a live
  // request to a publisher this project has never contacted (D-042).
  firstContactApproval: null,
};

/**
 * The proposed content.
 *
 * `authorityTier: 4` — a volunteer news wiki. Above a metasearch snippet (tier 5), below a wire
 * service, far below a regulator's own record. `cascadeRung: 5` because this is the rung the
 * candidates that reach it are discovered at.
 *
 * Budgets are small on purpose. This source is fetched one article at a time as candidates
 * arrive, never polled, so a large budget would only ever be a larger blast radius.
 */
export const WIKINEWS_EN_CONTENT = {
  sourceName: 'English Wikinews',
  publisher: 'Wikimedia Foundation',
  connectorType: 'EVIDENCE_FETCH_HTTP',
  canonicalDomains: [WIKINEWS_EN_CANONICAL_DOMAIN],
  authorityTier: 4,
  cascadeRung: 5,
  countries: ['US', 'GB'],
  languages: ['en'],
  credentialsRef: null,
  freeTierHourlyBudget: 60,
  freeTierDailyBudget: 240,
  stabilityClass: 'DOCUMENTED_STABLE',
  parserVersion: 'wikinews-article-1',
  licenceTermsVersion: 'wikinews-cc-by-2.5-2026-09-22',
  licenceExpiresAt: null,
  // **Deliberately NOT_ESTABLISHED.** Nobody has read en.wikinews.org/robots.txt. The gate
  // refuses on this value and that refusal is correct until somebody makes that read.
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'HTML',
  accessPolicy: WIKINEWS_EN_ACCESS_POLICY,
} as const;

/**
 * The content, parsed through the contract schema.
 *
 * `parse` rather than the literal, for the same reason the SEC records give: a field renamed in
 * the schema fails here, at the moment it is renamed, rather than becoming a conformance error
 * an administrator meets when they try to submit the proposal.
 */
export function wikinewsEnContent(): Record<string, unknown> {
  return sourceContentSchema.parse(WIKINEWS_EN_CONTENT);
}
