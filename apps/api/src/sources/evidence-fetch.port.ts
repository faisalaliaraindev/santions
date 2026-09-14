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
export interface FetchAuthorisation {
  /** The active source version that approved this domain. */
  readonly sourceVersionId: string;
  readonly robotsPosition: 'HONOURED' | 'EXCEPTION_APPROVED' | 'NOT_ESTABLISHED';
  /** Set only when `robotsPosition` is `EXCEPTION_APPROVED`: who approved it (FR-06, D6). */
  readonly robotsExceptionApprovedBy: string | null;
  readonly jurisdictionEnabled: boolean;
  readonly languageEnabled: boolean;
  readonly urlPolicyPassed: boolean;
  readonly ssrfValidated: boolean;
  /** FR-06 relevance threshold. The score that cleared it, for the coverage view. */
  readonly relevanceScore: number;
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
