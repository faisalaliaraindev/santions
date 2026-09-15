/**
 * The egress identity — Phase E step 2, the **E3 minimum**.
 *
 * FR-06 requires every outbound request to record the identity it was made under, and the
 * pipeline has been writing `egressIdentityId: 'mock-egress-1'` into attribution records since
 * the Phase E slice was built for a demo. Against the mock that was a fixture naming itself. With
 * a real transport in the process it would be a live request attributed to an identity that does
 * not exist — in the record whose purpose is to say who made the request.
 *
 * So there is exactly one real identity, and it is built from configuration that has to be real:
 *
 * - the **user agent** is derived from the contact URL, never free text. A free-text user agent
 *   can be set to a string with no contact in it at all, which is the dishonest case FR-06
 *   forbids. `.env.example` records the same reasoning for `FETCH_CONTACT_URL`.
 * - a **live process with no contact URL gets no identity**, and therefore no fetch. An anonymous
 *   crawler is not a degraded honest one.
 * - a **mock process gets a mock identity**, plainly named, which cannot be mistaken for a live
 *   one in a record (T55).
 *
 * The pool, the sticky per-(domain, job) binding and the `ProxyPort` are **step 7**. One identity
 * is not a pool and does not pretend to be: `region` is declared once, rotation does not exist,
 * and nothing here reads a block response. Rotation is capacity and geography, never evasion.
 */

import type { EgressIdentity } from './evidence-fetch.port.js';
import type { OperatingMode } from './source-adapter.js';

/** The service name carried in the user agent. Matches `HttpEvidenceFetchAdapter`'s default. */
export const EGRESS_SERVICE_NAME = 'ErlyAdverseSearch';

/** The single live identity's id. Stable, because it is written into stored attribution. */
export const PRIMARY_EGRESS_IDENTITY_ID = 'egress-primary';

/** The mock identity's id. Deliberately unmistakable in a stored record. */
export const MOCK_EGRESS_IDENTITY_ID = 'egress-mock-fixture';

export interface EgressIdentityOptions {
  readonly mode: OperatingMode;
  /** Required in live mode. Null means no identity, which means no live fetch. */
  readonly contactUrl: string | null;
  /**
   * Where requests leave from, as the operator declares it. Not measured, and not inferred from
   * an outbound IP — an inferred region in an attribution record is a guess presented as a fact.
   */
  readonly region?: string;
  /**
   * The `Accept-Language` this identity sends.
   *
   * Spanish first because D-010 enables Costa Rica, and an identity asking for English gets the
   * English edition of a Spanish-language publisher — a recall loss that looks like an absence of
   * coverage rather than a header.
   */
  readonly acceptLanguage?: readonly string[];
}

/**
 * Build the one egress identity this process may use, or `null` when it cannot have an honest one.
 *
 * Returns null rather than throwing so the composition root can report the capability as
 * unavailable in the same breath as the fetch adapter it belongs to; `buildSourceAdapters`
 * already refuses to construct that adapter without a contact URL, and this is the same rule
 * applied to the identity written into the record.
 */
export function buildEgressIdentity(options: EgressIdentityOptions): EgressIdentity | null {
  const region = options.region ?? 'unspecified';
  const acceptLanguage = options.acceptLanguage ?? ['es', 'en'];

  if (options.mode === 'MOCK') {
    return {
      identityId: MOCK_EGRESS_IDENTITY_ID,
      region: 'fixture',
      // Says what it is. A mock user agent that looked live could be copied into a live
      // configuration and would then be a lie about who is calling.
      userAgent: `${EGRESS_SERVICE_NAME}/1.0 (fixture; no outbound request is made)`,
      acceptLanguage,
      health: 'healthy',
    };
  }

  const contactUrl = options.contactUrl?.trim() ?? '';
  if (contactUrl === '') {
    return null;
  }

  return {
    identityId: PRIMARY_EGRESS_IDENTITY_ID,
    region,
    // Identical to the user agent `HttpEvidenceFetchAdapter` builds from the same contact URL.
    // Two spellings of the same identity would make the record and the wire disagree about who
    // called, and the record is what a publisher's complaint would be checked against.
    userAgent: `${EGRESS_SERVICE_NAME}/1.0 (+${contactUrl})`,
    acceptLanguage,
    health: 'healthy',
  };
}

/**
 * Assert, at startup, that this process cannot make an anonymous outbound request.
 *
 * The adapter already refuses to be constructed without a contact URL, and
 * `buildSourceAdapters` already returns `null` instead of one. Both of those fail **late and
 * quietly**: the process starts, serves traffic, and reports fetching as unavailable — which
 * reads to an operator as "nothing has been configured yet" rather than as "this deployment is
 * misconfigured and is silently doing no work".
 *
 * So a live process asserts the user agent here instead, and refuses to start without one. FR-06
 * requires the user agent to identify the service honestly with a contact URL; a deployment that
 * cannot satisfy that must stop at boot, where somebody is watching, rather than at the first
 * search, where nobody is.
 *
 * Checks the **derived** string rather than the configuration value, because the string is what
 * goes on the wire: an assertion on the input would pass for a contact URL that produced an
 * empty or contactless user agent through some later edit of `buildEgressIdentity`.
 *
 * Mock mode is exempt and is not merely skipped: it is asserted too, against the fixture
 * identity, so that the rule is proved on every boot rather than only on the boots that matter.
 */
export function assertOutboundUserAgent(options: EgressIdentityOptions): string {
  const identity = buildEgressIdentity(options);
  if (identity === null) {
    throw new Error(
      'Refusing to start in live mode without FETCH_CONTACT_URL. FR-06 requires every ' +
        'outbound request to carry a user agent that identifies this service and gives a ' +
        'publisher somewhere to write. There is deliberately no default: a default would be a ' +
        'URL nobody reads on a host nobody owns.',
    );
  }

  const userAgent = identity.userAgent.trim();
  if (userAgent === '' || !userAgent.startsWith(EGRESS_SERVICE_NAME)) {
    throw new Error(
      `Refusing to start: the outbound user agent "${identity.userAgent}" does not name this ` +
        `service. A request a publisher cannot attribute is one they cannot ask us to stop.`,
    );
  }

  const contactUrl = options.contactUrl?.trim() ?? '';
  if (options.mode === 'LIVE' && (contactUrl === '' || !userAgent.includes(contactUrl))) {
    throw new Error(
      `Refusing to start: the outbound user agent "${identity.userAgent}" does not carry the ` +
        `configured contact URL. FR-06 requires the contact to be on the wire, not only in ` +
        `configuration.`,
    );
  }

  return userAgent;
}
