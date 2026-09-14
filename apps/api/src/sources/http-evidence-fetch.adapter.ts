/**
 * The real `EvidenceFetchPort` — Phase E step 1.
 *
 * # What this file is
 *
 * The first component in this service that can put a request on the wire to a publisher who did
 * not ask to hear from us. Everything Phase D built — the registry, the four-eyes approval, the
 * rights gate, the breaker, the budgets, the kill switch — exists so that this can be written
 * without it being reckless. This is where all of it either runs or does not.
 *
 * **No live source has been contacted by this project.** Nothing in this file changes that on its
 * own: the real transport is constructed only by the live composition root, and every test runs
 * against an injected one.
 *
 * # The order of operations is the specification
 *
 * 1. Refuse an unauthorised or unattributable request (`fetch-authorisation.ts`, shared with the
 *    mock so the two cannot drift).
 * 2. `screenUrl` — the SEC-02 gate on what the string alone can show.
 * 3. `checkAccess` **immediately before the socket opens**, and again before every redirect hop
 *    and before fetching robots.txt.
 * 4. robots.txt, fetched and cached per host. `DISALLOWED` refuses, and **`UNKNOWN` refuses**.
 * 5. The request: honest user agent, conditional GET, redirects followed one screened hop at a
 *    time.
 * 6. The budgets: wire bytes, decompressed bytes, redirect count, total elapsed time.
 * 7. Health fed back — `recordSuccess`, or `recordFailure` with the observed `FailureSignal`.
 *
 * # The two judgements worth arguing with
 *
 * **A gate refusal is never recorded as the source's failure.** A robots disallow and a refused
 * address are facts about one path and one address. Both classify as `HARD_BLOCK`, whose
 * `domainAction` is `SUSPEND`, and D5's breaker opens immediately on that — so handing either to
 * `recordFailure` would suspend an entire working news feed because one of the articles it listed
 * was unreachable. Health records only what **the server did**: a status code, a reset connection,
 * a timeout, an oversize body.
 *
 * **Who spends the budget.** The publisher counts requests, so the component that opens the
 * socket spends. The pipeline's pre-fetch check is a non-spending rights-and-breaker question;
 * this adapter spends once per request it actually issues — the robots.txt fetch included, which
 * is a real request to the publisher and was counted nowhere before.
 *
 * # What is deliberately absent
 *
 * No Playwright, no rendering, no escalation. FR-06 permits a rendered fetch only on a
 * deterministic logged trigger, and three of the four triggers are judgements about extracted
 * text — which is still a keyword placeholder. Inventing a trigger to justify rendering would put
 * a fabricated reason into a record that exists to be audited. `allowRender` is accepted and
 * ignored, and `renderTrigger` is always null, which is the truth.
 *
 * No CAPTCHA, challenge, paywall or login wall is ever solved, worked around or retried from a
 * different identity. A recognised challenge is abandoned and reported (T87).
 */

import { Logger } from '@nestjs/common';

import {
  classifyFailure,
  parseRobots,
  robotsAbsent,
  robotsUnavailable,
  robotsVerdict,
  screenUrl,
  type FailureSignal,
  type RobotsFile,
  type SourceCoverageOutcome,
} from '@erly/adverse-domain';

import { assertAttributable, assertAuthorised } from './fetch-authorisation.js';
import type { EvidenceFetchPort, FetchRequest, FetchResult } from './evidence-fetch.port.js';
import { NodeHttpsTransport, type HttpTransport, type TransportResult } from './http-transport.js';
import {
  failed,
  ok,
  type AdapterDescriptor,
  type Clock,
  type SourceOutcome,
} from './source-adapter.js';

export const HTTP_EVIDENCE_FETCH_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'http-evidence-fetch',
  portKind: 'EVIDENCE_FETCH',
  // A placeholder, and it is replaced per request. See `provenanceFor` below: the source a
  // document came from is the source whose approval permitted the fetch, and that is known only
  // once the request names it. A record stamped with a transport's own id could not be traced
  // back to an approval, which is what `AdapterDescriptor.sourceId` is for.
  sourceId: 'src-http-fetch',
  parserVersion: 'http-1',
  // HTTP itself is documented and versioned. The volatility FR-05 worries about belongs to the
  // *parsers* of undocumented feeds, not to the transport underneath them.
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'LIVE',
  // The transport is not jurisdiction-bound — it fetches whatever an approved source version
  // permitted, and the jurisdiction gate is `authorisation.jurisdictionEnabled`, decided
  // upstream. This declares the one enabled jurisdiction (D-010) so that a coverage view
  // grouping adapters by country does not show a transport claiming worldwide coverage.
  jurisdictions: ['CR'],
};

/**
 * The slice of `SourceHealthService` this adapter uses.
 *
 * Narrow on purpose: the adapter may ask whether it is allowed to make a call and report what
 * happened, and it may not engage a kill switch, release one, or read the operator view.
 */
export interface SourceAccessPort {
  checkAccess(input: {
    readonly sourceId: string;
    readonly now: Date;
    readonly queriesAffected?: number | undefined;
    readonly spend?: boolean | undefined;
  }): Promise<{
    readonly decision: { readonly allowed: boolean; readonly detail: string };
    readonly coverageOutcome: SourceCoverageOutcome | null;
  }>;
  recordFailure(input: {
    readonly sourceId: string;
    readonly signal: FailureSignal;
    readonly now: Date;
  }): Promise<unknown>;
  recordSuccess(input: { readonly sourceId: string; readonly now: Date }): Promise<unknown>;
}

export interface HttpEvidenceFetchOptions {
  readonly access: SourceAccessPort;
  /**
   * The contact URL the user agent carries. **Required, with no default.**
   *
   * FR-06: "The user agent identifies the service honestly with a contact URL." A default would
   * be a URL nobody reads, on a host nobody owns, and a publisher who wanted us to stop would
   * have nowhere to write. Missing configuration must stop the process, not produce a polite
   * lie — so `buildSourceAdapters` refuses to construct this adapter without one.
   */
  readonly contactUrl: string;
  readonly serviceName?: string;
  readonly transport?: HttpTransport;
  readonly clock?: Clock;
  /** How long a parsed robots.txt is trusted. Publishers change them; a day is the convention. */
  readonly robotsTtlMs?: number;
  /** A robots.txt larger than this is treated as unavailable rather than parsed. */
  readonly maxRobotsBytes?: number;
}

interface CachedRobots {
  readonly robots: RobotsFile;
  readonly expiresAt: number;
}

/** Recognised in a body that came back 200. Never solved, worked around, or retried elsewhere. */
const CHALLENGE_MARKERS: readonly string[] = [
  'captcha',
  'cf-challenge',
  'are you a robot',
  'enable javascript and cookies to continue',
  'verifying you are human',
  'ddos protection by',
];

export class HttpEvidenceFetchAdapter implements EvidenceFetchPort {
  readonly descriptor = HTTP_EVIDENCE_FETCH_DESCRIPTOR;

  private readonly logger = new Logger('HttpEvidenceFetch');
  private readonly access: SourceAccessPort;
  private readonly transport: HttpTransport;
  private readonly clock: Clock;
  private readonly userAgent: string;
  private readonly robotsTtlMs: number;
  private readonly maxRobotsBytes: number;
  /** Per host, not per URL: robots.txt is a property of the host and is fetched once for it. */
  private readonly robotsCache = new Map<string, CachedRobots>();

  constructor(options: HttpEvidenceFetchOptions) {
    if (options.contactUrl.trim() === '') {
      throw new Error(
        'HttpEvidenceFetchAdapter requires a contact URL. FR-06 requires the user agent to ' +
          'identify the service honestly with a contact URL, and a publisher who wants us to ' +
          'stop must have somewhere to write.',
      );
    }
    this.access = options.access;
    this.transport = options.transport ?? new NodeHttpsTransport();
    this.clock = options.clock ?? ((): Date => new Date());
    this.userAgent = `${options.serviceName ?? 'ErlyAdverseSearch'}/1.0 (+${options.contactUrl})`;
    this.robotsTtlMs = options.robotsTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxRobotsBytes = options.maxRobotsBytes ?? 512 * 1024;
  }

  /**
   * The robots.txt position for a URL, as currently understood.
   *
   * Fetches and caches on first sight of a host. Answers `UNKNOWN` when robots.txt could not be
   * read — never `ALLOWED`, because an outage at the publisher is not consent.
   */
  async robotsPositionFor(url: string): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'> {
    const screening = screenUrl(url);
    if (!screening.allowed) {
      // A URL we may not fetch has no robots position worth reporting, and reporting `ALLOWED`
      // for one would be the more dangerous of the two wrong answers.
      return 'UNKNOWN';
    }
    const parsed = new URL(url);
    // No source is named here, so this probe is not charged to a budget. It is cached per host
    // and, on the fetch path, the charged call happens first — so in practice this reads the
    // cache. A caller that asks about a host the service has never fetched issues one uncharged
    // request; step 2's gate service is where that call site gets a source to charge.
    const robots = await this.robotsFor(parsed, null);
    return robotsVerdict(robots, this.userAgent, `${parsed.pathname}${parsed.search}`);
  }

  async fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>> {
    // Programming errors first, and they throw: a caller that cannot name its authorisation or
    // its attribution has a bug, and turning that into a coverage gap would report a source as
    // unreachable when it was never reached for.
    assertAuthorised(request);
    assertAttributable(request);

    const sourceId = request.attribution.sourceId;
    const startedAt = this.clock().getTime();
    const deadline = startedAt + request.budget.timeoutMs;

    let currentUrl = request.url;
    let hops = 0;

    // Redirects are followed here, one screened hop at a time, rather than by the transport. A
    // transport that followed them would carry the request past the gate without the gate being
    // consulted — and a 302 to `http://169.254.169.254/` is the obvious way to try it.
    for (;;) {
      const screening = screenUrl(currentUrl);
      if (!screening.allowed) {
        return this.refuse(
          request,
          { policyRefusal: true },
          `${screening.rejection ?? 'REJECTED'}: ${screening.detail ?? currentUrl}`,
        );
      }
      const parsed = new URL(currentUrl);

      const robots = await this.robotsDecision(request, parsed, deadline);
      if (robots !== null) {
        return robots;
      }

      const access = await this.access.checkAccess({ sourceId, now: this.clock(), spend: true });
      if (!access.decision.allowed) {
        // Not a failure of the source — our own decision not to ask it, one instant before the
        // socket would have opened. This is what makes the D5 kill switch effective mid-run.
        return this.refuse(request, { policyRefusal: true }, access.decision.detail);
      }

      const remainingMs = deadline - this.clock().getTime();
      if (remainingMs <= 0) {
        return await this.observed(
          request,
          { syscallCode: 'ETIMEDOUT' },
          'Budget elapsed before the request was issued.',
        );
      }

      const result = await this.transport.send({
        url: currentUrl,
        headers: this.headersFor(request, hops === 0),
        timeoutMs: remainingMs,
        maxWireBytes: request.budget.maxBytes,
        maxDecompressedBytes: request.budget.maxDecompressedBytes,
      });

      if (result.kind === 'FAILURE') {
        // A refused address is our policy and never the source's fault; everything else is
        // something the server or the network did, and health hears about it.
        return result.signal.policyRefusal === true
          ? this.refuse(request, result.signal, result.detail)
          : await this.observed(request, result.signal, result.detail);
      }

      const location = result.headers['location'];
      if (isRedirect(result.status) && location !== undefined) {
        hops += 1;
        if (hops > request.budget.maxRedirects) {
          return await this.observed(
            request,
            { limitExceeded: true },
            `More than ${String(request.budget.maxRedirects)} redirects.`,
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        // Round the loop: screened again, robots checked again for the new host, access checked
        // again. A redirect is a new request to a possibly different publisher.
        continue;
      }

      return await this.complete(request, currentUrl, result);
    }
  }

  /**
   * The robots gate for one hop. Returns an outcome when the fetch must not proceed, else null.
   *
   * An approved exception skips the check and says so in the log — FR-06 requires the exception
   * to be per source and per jurisdiction with a named approver, and `assertAuthorised` has
   * already refused an unnamed one. **Open decision D6** decides how that name is recorded; until
   * it closes nothing can supply one, so in practice this branch is unreachable and the strict
   * path below is the only one taken.
   */
  private async robotsDecision(
    request: FetchRequest,
    url: URL,
    deadline: number,
  ): Promise<SourceOutcome<FetchResult> | null> {
    if (request.authorisation.robotsPosition === 'EXCEPTION_APPROVED') {
      this.logger.log(
        `${url.host}: robots exception applied, approved by ` +
          `${request.authorisation.robotsExceptionApprovedBy ?? 'nobody'} under source version ` +
          `${request.authorisation.sourceVersionId}.`,
      );
      return null;
    }

    const robots = await this.robotsFor(url, {
      sourceId: request.attribution.sourceId,
      deadline,
    });
    const verdict = robotsVerdict(robots, this.userAgent, `${url.pathname}${url.search}`);
    if (verdict === 'ALLOWED') {
      return null;
    }
    if (verdict === 'DISALLOWED') {
      return this.refuse(
        request,
        { robotsDisallow: true },
        `robots.txt at ${url.host} disallows ${url.pathname}.`,
      );
    }
    // UNKNOWN. Reading "we could not tell" as permission makes an outage at the publisher into
    // consent, which is the one reading `robots.ts` was written to refuse.
    return this.refuse(
      request,
      { policyRefusal: true },
      `robots.txt at ${url.host} could not be read, so permission is not established. ` +
        `Refusing rather than assuming: an outage at the publisher is not consent. A source ` +
        `that needs an exception needs one approved and recorded (open decision D6).`,
    );
  }

  /** Fetch and cache robots.txt for a host. `spend` counts it — it is a real request. */
  private async robotsFor(
    url: URL,
    charge: { readonly sourceId: string; readonly deadline: number } | null,
  ): Promise<RobotsFile> {
    const cached = this.robotsCache.get(url.host);
    const now = this.clock().getTime();
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.robots;
    }

    if (charge !== null) {
      const access = await this.access.checkAccess({
        sourceId: charge.sourceId,
        now: this.clock(),
        spend: true,
      });
      if (!access.decision.allowed) {
        // Not cached: a refusal is a fact about this instant, and caching it as "unavailable"
        // would keep refusing a host for a day after the source was released.
        return robotsUnavailable();
      }
    }

    const remainingMs = charge === null ? 10_000 : charge.deadline - now;
    if (remainingMs <= 0) {
      return robotsUnavailable();
    }

    const result = await this.transport.send({
      url: `${url.origin}/robots.txt`,
      headers: { 'user-agent': this.userAgent, accept: 'text/plain', 'accept-encoding': 'gzip' },
      timeoutMs: Math.min(remainingMs, 10_000),
      maxWireBytes: this.maxRobotsBytes,
      maxDecompressedBytes: this.maxRobotsBytes,
    });

    const robots = interpretRobotsResponse(result);
    this.robotsCache.set(url.host, { robots, expiresAt: now + this.robotsTtlMs });
    return robots;
  }

  /** Turn a successful response into a `FetchResult`, or into the failure it really was. */
  private async complete(
    request: FetchRequest,
    finalUrl: string,
    result: Extract<TransportResult, { kind: 'RESPONSE' }>,
  ): Promise<SourceOutcome<FetchResult>> {
    const now = this.clock();

    if (result.status === 304) {
      // A conditional hit is a successful fetch with no body, not an empty document. Conflating
      // them would let a caller store an empty version over a good one.
      await this.access.recordSuccess({ sourceId: request.attribution.sourceId, now });
      return ok(this.provenanceFor(request), now, {
        url: request.url,
        finalUrl,
        httpStatus: 304,
        headers: result.headers,
        body: null,
        notModified: true,
        contentType: null,
        bytes: 0,
        renderTrigger: null,
        egressIdentityId: request.attribution.egressIdentityId,
        fetchedAt: now.toISOString(),
      });
    }

    if (result.status >= 400) {
      const retryAfter = Number(result.headers['retry-after']);
      return await this.observed(
        request,
        {
          httpStatus: result.status,
          ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
        },
        `${String(result.status)} from ${finalUrl}.`,
      );
    }

    if (result.status !== 200) {
      // A 2xx or 3xx that is neither 200 nor a followed redirect — a 204, or a 3xx with no
      // Location. There is no document here, and treating one as an empty document is how an
      // empty finding gets written.
      return await this.observed(
        request,
        { httpStatus: result.status, emptyBody: true },
        `${String(result.status)} carried no document.`,
      );
    }

    const contentType = result.headers['content-type'] ?? null;
    const challenge = detectChallenge(result.body, contentType);
    if (challenge !== null) {
      // FR-06 and T87: abandoned, recorded, never solved by any path. The classifier reads
      // `challengeDetected` as a soft block, which cools the identity and degrades the domain.
      return await this.observed(request, { challengeDetected: true, httpStatus: 200 }, challenge);
    }

    if (result.body.byteLength === 0) {
      return await this.observed(request, { emptyBody: true, httpStatus: 200 }, 'Empty 200 body.');
    }

    await this.access.recordSuccess({ sourceId: request.attribution.sourceId, now });
    return ok(this.provenanceFor(request), now, {
      url: request.url,
      finalUrl,
      httpStatus: 200,
      headers: result.headers,
      body: result.body,
      notModified: false,
      contentType,
      bytes: result.body.byteLength,
      // Always null. See the file header: a rendered fetch must name a real trigger, and there
      // is no rendering in this step.
      renderTrigger: null,
      egressIdentityId: request.attribution.egressIdentityId,
      fetchedAt: now.toISOString(),
    });
  }

  private headersFor(request: FetchRequest, first: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
    };
    // Conditional headers go on the first hop only. Replaying an `If-None-Match` to whatever a
    // redirect points at asks a different document about a different document's ETag, and a
    // server that answered 304 to it would be answering about nothing we hold.
    if (first && request.conditional.etag !== null) {
      headers['if-none-match'] = request.conditional.etag;
    }
    if (first && request.conditional.lastModified !== null) {
      headers['if-modified-since'] = request.conditional.lastModified;
    }
    return headers;
  }

  /**
   * A refusal: **our** decision not to ask, so health never hears about it.
   *
   * Returned as `FAILED` rather than thrown because it is a fact about the world discovered while
   * fetching — a publisher's robots.txt, a third party's redirect — and not a bug at the call
   * site. The lead survives with its reason attached.
   */
  private refuse(
    request: FetchRequest,
    signal: FailureSignal,
    detail: string,
  ): SourceOutcome<FetchResult> {
    this.logger.warn(`Refusing ${request.url}: ${detail}`);
    return failed(this.provenanceFor(request), this.clock(), signal);
  }

  /**
   * A failure **the server produced**. Recorded against the source's health, deliberately.
   *
   * Awaited rather than fired and forgotten: the breaker exists to stop the *next* request, and a
   * write still in flight when the next request is decided is a breaker that opens one request
   * too late. That is the request the breaker was there to prevent.
   */
  private async observed(
    request: FetchRequest,
    signal: FailureSignal,
    detail: string,
  ): Promise<SourceOutcome<FetchResult>> {
    const policy = classifyFailure(signal);
    this.logger.warn(`${request.url} failed as ${policy.failureClass}: ${detail}`);
    await this.access.recordFailure({
      sourceId: request.attribution.sourceId,
      signal,
      now: this.clock(),
    });
    return failed(this.provenanceFor(request), this.clock(), signal);
  }

  /**
   * The descriptor stamped onto this request's provenance.
   *
   * `sourceId` is the one the request names, not the transport's own: `AdapterDescriptor.sourceId`
   * exists "so a record can be traced to its approval", and a document stamped `src-http-fetch`
   * traces to a transport rather than to the source version that permitted it.
   */
  private provenanceFor(request: FetchRequest): AdapterDescriptor {
    return { ...this.descriptor, sourceId: request.attribution.sourceId };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * What a robots.txt response means.
 *
 * A 404 is permission — the publisher chose not to write one, which is the settled convention.
 * A 5xx, a timeout, a redirect or an HTML error page is `UNKNOWN`, which the caller refuses on.
 * The difference is the whole point of `robots.ts`: "no rule found" and "we could not tell" are
 * not the same fact, and only one of them is consent.
 */
export function interpretRobotsResponse(result: TransportResult): RobotsFile {
  if (result.kind === 'FAILURE') {
    return robotsUnavailable();
  }
  if (result.status === 404 || result.status === 410) {
    return robotsAbsent();
  }
  if (result.status !== 200) {
    return robotsUnavailable();
  }
  const contentType = result.headers['content-type'] ?? '';
  if (contentType !== '' && !contentType.toLowerCase().includes('text/plain')) {
    // An HTML error page served as 200 is the commonest way a robots.txt "succeeds" while telling
    // us nothing. Parsing it would find no rules and read as permission.
    return robotsUnavailable();
  }
  return parseRobots(new TextDecoder().decode(result.body));
}

/**
 * Recognise a challenge or interstitial in a body that came back 200.
 *
 * Deliberately conservative and deliberately dumb: it looks at the first few kilobytes of an HTML
 * body for well-known markers. A false positive costs one lead and is reported honestly; a false
 * negative stores a CAPTCHA page as evidence about a person, which is much worse.
 */
export function detectChallenge(body: Uint8Array, contentType: string | null): string | null {
  if (contentType !== null && !contentType.toLowerCase().includes('html')) {
    return null;
  }
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(body.subarray(0, 4096))
    .toLowerCase();
  const marker = CHALLENGE_MARKERS.find((candidate) => head.includes(candidate));
  return marker === undefined
    ? null
    : `A bot challenge or interstitial was served (matched "${marker}"). Abandoned without any ` +
        `attempt to solve, work around or retry it from elsewhere (FR-06, T87).`;
}
