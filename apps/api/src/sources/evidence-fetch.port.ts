/**
 * `EvidenceFetchPort` — the FR-06 fetch seam.
 *
 * Everything that turns a URL into bytes goes through here: the gate, the budgets, the egress
 * identity, the conditional GET, the HTTP-first / Playwright-by-exception escalation. **None of
 * it is implemented in Phase D.** The seam is defined now because the fetch layer is the part
 * of the system with the most ways to do quiet harm — bypassing robots, retrying a hard block,
 * pulling an unbounded body — and every one of those is a rule the interface can carry rather
 * than a habit the implementer must have.
 *
 * Three rules are expressed in the types rather than the prose.
 *
 * **1. The gate decision is an input, not an afterthought.** `FetchRequest` requires a
 * `FetchAuthorisation` — the record that every FR-06 gate passed, naming which source approval
 * and which robots position permitted this URL. There is no overload without it. A fetch that
 * cannot name its authorisation cannot be issued, so "we forgot to check robots for this path"
 * is not reachable.
 *
 * **2. A rendered fetch must name its trigger.** FR-06 allows Playwright only on "a
 * deterministic, logged trigger". `RenderTrigger` is a closed union and `FetchResult` records
 * which one fired, so "we rendered it because the HTTP fetch looked thin" is a value in the
 * record rather than a judgement nobody can reconstruct.
 *
 * **3. Every request is attributable.** FR-06: "An unattributable outbound request is a
 * defect." Tenant, job, subject, query, source and egress identity are all required on the
 * request, so an unattributable one does not type-check.
 */

import type { AdapterDescriptor, SourceOutcome } from './source-adapter.js';

export const EVIDENCE_FETCH_PORT = 'EVIDENCE_FETCH_PORT';

/**
 * An egress identity (FR-06): an address, a user agent, a cookie jar, a language header set
 * and a health state. Bound sticky per (domain, job) — rotation is a capacity and geography
 * decision, never block evasion.
 */
export interface EgressIdentity {
  readonly identityId: string;
  readonly region: string;
  readonly userAgent: string;
  readonly acceptLanguage: readonly string[];
  readonly health: 'healthy' | 'cooling' | 'suspended';
}

/** Who this request is for. All of it required — an unattributable request is a defect. */
export interface FetchAttribution {
  readonly tenantId: string;
  readonly jobId: string;
  readonly subjectId: string;
  readonly queryId: string;
  readonly sourceId: string;
  readonly egressIdentityId: string;
}

/**
 * Evidence that every FR-06 gate passed, recorded by whoever passed them.
 *
 * The fetch layer does not re-derive these; it refuses to run without them. Splitting the
 * decision from the action is what lets the decision be audited independently — and what stops
 * a second, subtly different copy of the gate growing inside the HTTP client.
 */
/**
 * Where a source stands on robots.txt, as the authorisation records it.
 *
 * The first three are the registry's own vocabulary (`sourceContentSchema.robotsPosition`) and
 * mean what an approver recorded. `FIXTURE_NOT_A_PUBLISHER` is **not** a registry value and can
 * never be approved: it is issued only by `FetchGateService`, only in a `MOCK`-mode process, and
 * only for a source whose connector type is `FIXTURE_MOCK`. It says the honest thing about a
 * fixture — there is no publisher here, so there is no robots.txt position to honour — instead
 * of the pipeline claiming `HONOURED` for a local fixture, which is what it used to do.
 * `HttpEvidenceFetchAdapter` refuses it outright, so the value cannot reach a real publisher.
 */
export type RobotsPosition =
  'HONOURED' | 'EXCEPTION_APPROVED' | 'NOT_ESTABLISHED' | 'FIXTURE_NOT_A_PUBLISHER';

export interface FetchAuthorisation {
  /** The active source version that approved this domain. */
  readonly sourceVersionId: string;
  /**
   * The licence terms version that was recorded, and unexpired, when this was issued (FR-06).
   *
   * On the authorisation rather than looked up later because "the terms had not expired" is a
   * statement about the instant the request was made, and the registry is mutable afterwards.
   */
  readonly licenceTermsVersion: string;
  readonly robotsPosition: RobotsPosition;
  /** Set only when `robotsPosition` is `EXCEPTION_APPROVED`: who approved it (FR-06, D6). */
  readonly robotsExceptionApprovedBy: string | null;
  /**
   * The ceiling the approved version records, in requests per second, or null when it records
   * none.
   *
   * On the authorisation for the same reason `licenceTermsVersion` is: it is what was approved at
   * the instant this request was authorised, and the registry is mutable afterwards. The adapter
   * needs it because **fetching robots.txt is itself a request to the publisher** — it leaves
   * this process, it appears in their logs, and it is refused by their rate limiter exactly as
   * any other request is. Pacing the document fetch while hammering robots.txt would honour the
   * ceiling everywhere except the one request that decides whether we may make the others.
   */
  readonly requestCeilingPerSecond: number | null;
  readonly jurisdictionEnabled: boolean;
  readonly languageEnabled: boolean;
  /** `screenUrl` passed on this exact URL. */
  readonly urlPolicyPassed: boolean;
  /**
   * The SEC-02 address policy is in force for this request.
   *
   * Precisely what it asserts, because the field used to be set to `true` by a pipeline that
   * screened nothing: the gate ran the **literal** half — a URL whose host is an IP address in a
   * forbidden range is rejected by `screenUrl` before this is set — and the **resolved** half is
   * structural, performed inside the connection's own `lookup` by the transport (D-034), on
   * every hop, at the moment the socket is opened. No caller can satisfy this field by asserting
   * it; the gate sets it, and the transport enforces the half the gate cannot.
   */
  readonly ssrfValidated: boolean;
  /**
   * FR-06 relevance. The score this candidate carried at the gate, for the coverage view.
   *
   * **Null when relevance does not apply**, which is one case and only one: a poll of a source's
   * own endpoint — a feed, an index — rather than a fetch of a document discovered through it.
   * Nothing has been judged at that point, because the thing being fetched is the list rather
   * than an item on it, and putting a 1 there to satisfy the type would be recording a judgement
   * that was never made in the record that exists to be audited. `relevanceMethod` says which
   * case it is either way.
   */
  readonly relevanceScore: number | null;
  /**
   * How that score was produced, so a reviewer can tell a measured score from a preliminary one.
   *
   * A bare number is uninterpretable — 0.4 from the FR-06 signal set and 0.4 from a name-presence
   * heuristic mean different things — and the record exists to be audited.
   */
  readonly relevanceMethod: string;
  /** The component that issued this authorisation, and when. Only the fetch gate issues one. */
  readonly issuedBy: string;
  readonly issuedAt: string;
}

/** The byte, time and redirect budget for one fetch. Exceeding any of it is `OVERSIZE`. */
export interface FetchBudget {
  readonly maxBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
}

/** The only reasons a rendered fetch may be used (FR-06). Closed on purpose. */
export type RenderTrigger =
  | 'CONTENT_BELOW_THRESHOLD'
  | 'CLIENT_RENDER_SHELL_SIGNATURE'
  | 'STRUCTURED_METADATA_ABSENT'
  | 'DOMAIN_FLAGGED_RENDER_REQUIRED';

export interface FetchRequest {
  readonly url: string;
  readonly attribution: FetchAttribution;
  readonly authorisation: FetchAuthorisation;
  readonly budget: FetchBudget;
  /** Stored ETag / Last-Modified for a conditional GET. Null on first sight of the URL. */
  readonly conditional: { readonly etag: string | null; readonly lastModified: string | null };
  /**
   * Idempotent fetch key (FR-06). A redelivered queue message re-uses the stored response
   * instead of hitting the source again — which is both politeness and correctness, since two
   * fetches of a news page can return different text.
   */
  readonly fetchKey: string;
  /**
   * Permission to escalate to a rendered fetch if a trigger fires. Off by default at the call
   * site; the trigger still has to fire, and is recorded when it does.
   */
  readonly allowRender: boolean;
}

export interface FetchResult {
  readonly url: string;
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Null when the server answered 304. A conditional hit is a successful fetch with no body,
   * not an empty document — conflating them would store an empty version over a good one.
   */
  readonly body: Uint8Array | null;
  readonly notModified: boolean;
  readonly contentType: string | null;
  readonly bytes: number;
  /** Null when the fetch was plain HTTP. Set to the trigger that justified rendering. */
  readonly renderTrigger: RenderTrigger | null;
  readonly egressIdentityId: string;
  readonly fetchedAt: string;
}

export interface EvidenceFetchPort {
  readonly descriptor: AdapterDescriptor;

  fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>>;

  /**
   * The robots.txt position for a URL, as currently understood.
   *
   * On the port because robots is a property of the transport's view of the host, and because
   * FR-06 requires the exception process to be per-source and per-jurisdiction rather than a
   * global setting — which means somebody has to be able to ask, per URL, what the position is.
   */
  robotsPositionFor(url: string): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'>;
}
