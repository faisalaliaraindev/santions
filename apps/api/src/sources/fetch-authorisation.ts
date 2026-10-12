/**
 * The FR-06 refusals every `EvidenceFetchPort` implementation must make, in one place.
 *
 * These were written first inside `MockEvidenceFetchAdapter`, because the mock's job is to
 * perform every *refusal* the real adapter must perform — a fetch mock that happily returns
 * bytes lets a caller pass its tests while omitting the gate. Phase E adds the real adapter, and
 * the header of `evidence-fetch.port.ts` is explicit about what would happen next if each
 * implementation kept its own copy: "a second, subtly different copy of the gate growing inside
 * the HTTP client". Two copies is how the live one ends up the more permissive of the two.
 *
 * So there is one copy, and both adapters call it.
 *
 * **Why these throw rather than returning `FAILED`.** A gate refusal is our decision not to ask,
 * not the source's failure to answer. Recording it as a coverage gap would say a source was
 * consulted and did not respond, when it was never consulted at all. And every condition here is
 * a programming error at the call site — a caller that could not name its authorisation or its
 * attribution has a bug, not a bad day.
 *
 * The runtime refusals that are **not** here, deliberately, are the ones that are facts about the
 * world rather than about the caller: a robots.txt that disallows the path, a host that resolves
 * to a private address, a redirect into one. Those are discovered while fetching, they are not
 * the caller's mistake, and they are returned as outcomes so that the lead survives with its
 * reason attached.
 */

import type { FetchRequest } from './evidence-fetch.port.js';

/**
 * Refuse a request whose authorisation does not show every FR-06 gate passing.
 *
 * @throws if any gate is unmet, listing all of them rather than the first.
 */
export function assertAuthorised(request: FetchRequest): void {
  const a = request.authorisation;
  const failures: string[] = [];
  if (!a.jurisdictionEnabled) {
    failures.push('jurisdiction not enabled');
  }
  if (!a.languageEnabled) {
    failures.push('language not enabled');
  }
  if (!a.urlPolicyPassed) {
    failures.push('URL policy not passed');
  }
  if (!a.ssrfValidated) {
    failures.push('SSRF validation not performed');
  }
  if (a.robotsPosition === 'NOT_ESTABLISHED') {
    failures.push('robots position not established');
  }
  if (a.issuedBy.trim() === '' || a.issuedAt.trim() === '') {
    // An authorisation that cannot say who issued it and when is not auditable, which is the
    // one job this record has. `FetchGateService` is the only issuer; see `fetch-gate.service.ts`.
    failures.push('authorisation names no issuer');
  }
  if (a.robotsPosition === 'EXCEPTION_APPROVED' && a.robotsExceptionApprovedBy === null) {
    // FR-06: the exception process is "approved by a named person — never a global setting".
    // An unattributed exception is a global setting wearing a record's clothes. D6 closed on
    // 2026-09-21 and decided how the name is recorded — on the approved version, beside the
    // hosts it covers — so this now refuses a real malformed record rather than every record.
    failures.push('robots exception approved by nobody');
  }
  if (a.robotsPosition === 'EXCEPTION_APPROVED' && a.robotsExceptionDeliveryHosts.length === 0) {
    // D6: an exception naming no host is not a narrow exception with an empty scope, it is an
    // unbounded one. Refusing here is what makes "fail closed if the redirect leaves the expected
    // delivery infrastructure" true even if a later change forgets to populate the list.
    failures.push('robots exception names no delivery host');
  }
  if (failures.length > 0) {
    throw new Error(
      `Refusing to fetch ${request.url}: ${failures.join('; ')}. Every FR-06 gate must pass ` +
        `before a fetch is issued, and a gate failure is our decision not to ask — not the ` +
        `source's failure to answer.`,
    );
  }
}

/**
 * Refuse a request that cannot be attributed.
 *
 * FR-06: "Every outbound request records tenant, job, subject, query, source, egress identity,
 * region and policy decision. An unattributable outbound request is a defect."
 *
 * @throws naming every missing field.
 */
export function assertAttributable(request: FetchRequest): void {
  const missing = Object.entries(request.attribution)
    .filter(([, value]) => value === '' || value === null || value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Unattributable outbound request (missing: ${missing.join(', ')}). FR-06: an ` +
        `unattributable outbound request is a defect.`,
    );
  }
}

/**
 * Refuse a fixture authorisation handed to a live transport.
 *
 * `FIXTURE_NOT_A_PUBLISHER` is the honest robots position for a `FIXTURE_MOCK` source in a
 * mock-mode process: there is no publisher, so there is no position to honour. It is therefore
 * the one robots value that must never justify a request to a real host. `MockModeWitness`
 * already stops a mock *adapter* existing in a live process; this stops a mock *authorisation*
 * reaching the real one, which is the same rule from the other end (T55).
 *
 * @throws if the authorisation is a fixture authorisation.
 */
export function assertNotFixtureAuthorisation(request: FetchRequest): void {
  if (request.authorisation.robotsPosition === 'FIXTURE_NOT_A_PUBLISHER') {
    throw new Error(
      `Refusing to fetch ${request.url} on a fixture authorisation. ` +
        `FIXTURE_NOT_A_PUBLISHER says there is no publisher behind this source, and it is issued ` +
        `only in mock mode for a FIXTURE_MOCK connector. A live transport that honoured it would ` +
        `be fetching a real host under a record saying no real host was involved (T55).`,
    );
  }
  // The same rule for the other non-publisher position. An internal-discovery authorisation
  // records both SEC-02 assertions — the URL policy and the SSRF validation — as **false**,
  // because neither half runs on the hop to a service we configured ourselves. Handing it to the
  // publisher transport would therefore fetch a third party's document under an authorisation
  // that truthfully says neither screening happened, which is the one combination
  // `assertFetchAuthorised` cannot catch precisely because the fields are honest.
  //
  // (The two field names are spelt out in prose rather than in code here on purpose: the
  // "only the gate issues an authorisation" test in fetch-gate.test.ts greps this directory for
  // the literal assignment, and a comment that looked like one would read as an offender.)
  if (request.authorisation.robotsPosition === 'INTERNAL_SERVICE_NOT_A_PUBLISHER') {
    throw new Error(
      `Refusing to fetch ${request.url} on an internal-discovery authorisation. ` +
        `INTERNAL_SERVICE_NOT_A_PUBLISHER is issued only for a query to a service this ` +
        `deployment runs, where no robots position, no first-contact approval and neither half ` +
        `of the SEC-02 address screening applies. A publisher fetch must carry an authorisation ` +
        `on which all three did.`,
    );
  }
}
