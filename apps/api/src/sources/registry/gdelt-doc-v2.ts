/**
 * GDELT DOC 2.0 — rung 3, and the first **QUERY_FEED** this project proposes for live use.
 *
 * # Template, proposal, record
 *
 * `discovery-rungs.ts` holds `GDELT_TEMPLATE`: the widely documented shape of this API, written
 * down so that the cost of adding rung 3 could be assessed without anybody calling it. This file
 * is the **proposal** built from it — the thing an administrator submits through the D1
 * lifecycle. It derives from the template rather than restating it, so the two cannot drift: the
 * endpoint, the query parameter, the rung, the connector type, the authority tier and the
 * country and language lists are the template's, and what is added here is the part a proposal
 * owes that a template does not.
 *
 * What is added, and why each one:
 *
 * - **Budgets sized for a query feed.** The template carried 60/500, copied across all three
 *   rung templates. That is the wrong shape of number for this source. A `FIXED_FEED` costs one
 *   request per poll floor; a `QUERY_FEED` costs **one request per planned query**, and a live
 *   plan for one subject in one language is 53 queries (one F1, one F4, 51 F3). A budget of 60
 *   therefore permits roughly one search an hour and then refuses — which is a budget that reads
 *   as a limit and behaves as an outage. `24` an hour and `200` a day is the opposite choice: it
 *   is deliberately *smaller* than one full plan, so the fan-out stops inside a single run,
 *   visibly, as a recorded coverage gap, rather than at an unpredictable point in the next one.
 *   See "Why a budget below one plan" below — it is not a mistake.
 * - **Stop conditions.** The template's defaults, unchanged, and they stay soft on 403 for the
 *   reason the template gives: GDELT publishes no statement that a 403 means our user agent is
 *   wrong, so escalating beyond FR-06 would be inventing a rule on their behalf.
 * - **A named licence-terms version.** `UNVERIFIED` is what a template records. A proposal has
 *   to name the terms an approver read, and until somebody does, the gate refuses the source for
 *   want of a licence as well as for want of everything below.
 *
 * # It is inert, and it must stay inert until a person acts
 *
 * Both of the template's independent refusals are preserved:
 *
 * - `firstContactApproval: null` — **this project has never contacted GDELT.** The fetch gate
 *   refuses every request to a source without a named approval (**D-042**). The SEC's D17 does
 *   not cover this publisher and must never be copied here: D17 is a decision about
 *   `www.sec.gov`, and an approval that travelled between publishers would be no approval.
 * - `robotsPosition: 'NOT_ESTABLISHED'` — nobody has read `api.gdeltproject.org/robots.txt`.
 *
 * `policySummary` keeps the template's `ENDPOINT NOT VERIFIED` sentence for the same reason:
 * `https://api.gdeltproject.org/api/v2/doc/doc` is the documented address and a documented
 * address is still a guess until somebody loads it. Whoever removes that sentence is claiming to
 * have loaded it.
 *
 * Activating this source therefore takes four acts by people, in this order: read their
 * robots.txt and record the position, read and name their terms, record a named first-contact
 * approval, and take the version through propose → approve → activate. None of them is a
 * deployment, and none of them is automatable without becoming a lie.
 *
 * # Why a budget below one plan is the right conservative choice
 *
 * The alternative — a budget above one plan — makes the first *interesting* behaviour of a query
 * feed invisible. Fan-out truncation is the property that separates a `QUERY_FEED` from a
 * `FIXED_FEED` operationally, and a budget nobody reaches is one nobody has tested. At 24 an
 * hour a live run makes at most 24 outbound requests, spends the rest of its plan as recorded
 * `HOURLY_BUDGET_EXHAUSTED` refusals, and finishes `PARTIAL`/`INCOMPLETE` **accurately**. That
 * is a bounded, honest result, and raising the number later is one approved version, not a code
 * change.
 */

import { sourceContentSchema } from '@adverse-search/contracts';

import { GDELT_TEMPLATE } from './discovery-rungs.js';

/** The registry id. The same id the template is keyed under, so the two name one source. */
export const GDELT_DOC_V2_SOURCE_ID = 'gdelt-doc-v2';

/** The documented DOC 2.0 endpoint. Unverified by this project — see the file header. */
export const GDELT_DOC_V2_ENDPOINT_URL = GDELT_TEMPLATE.accessPolicy.endpointUrl;

/** The parameter the connector sets the planned query on. A name, never a `{query}` template. */
export const GDELT_DOC_V2_QUERY_PARAM = GDELT_TEMPLATE.accessPolicy.queryParam;

/** The host, and therefore the domain-health key. Distinct from `sec.gov` — that is the point. */
export const GDELT_DOC_V2_DOMAIN = 'api.gdeltproject.org';

/**
 * The hourly budget, and the number a live run is bounded by.
 *
 * Exported because two things read it and they must not disagree: the proposal below, and any
 * check that wants to state the maximum number of requests a live run can make to GDELT.
 */
export const GDELT_DOC_V2_HOURLY_BUDGET = 24;

/** The daily backstop underneath the hourly one. */
export const GDELT_DOC_V2_DAILY_BUDGET = 200;

/**
 * The proposed source version content, exactly as it will be submitted.
 *
 * Derived from `GDELT_TEMPLATE` rather than restated. The overrides are listed in the header and
 * are the whole of the difference between a template and a proposal.
 */
export const GDELT_DOC_V2_CONTENT = {
  ...GDELT_TEMPLATE,
  freeTierHourlyBudget: GDELT_DOC_V2_HOURLY_BUDGET,
  freeTierDailyBudget: GDELT_DOC_V2_DAILY_BUDGET,
  accessPolicy: {
    ...GDELT_TEMPLATE.accessPolicy,
    // A query feed has no poll floor: every request carries a different query, so there is no
    // "same bytes again" for a floor to bound. Recording one would be recording a rule that
    // `FixedFeedPollCache` would then never be asked to apply, because the cache serves fixed
    // feeds only — and a rule enforced nowhere is exactly the defect the SEC poll floor was.
    pollFloorSeconds: null,
  },
} as const;

/**
 * The content, parsed through the contract schema.
 *
 * `parse` rather than the literal, for the reason `secLitigationReleasesContent` gives: a field
 * renamed in the schema fails here, at the moment it is renamed, rather than becoming a
 * conformance error an administrator meets when they try to submit the proposal.
 */
export function gdeltDocV2Content(): Record<string, unknown> {
  return sourceContentSchema.parse(GDELT_DOC_V2_CONTENT);
}
