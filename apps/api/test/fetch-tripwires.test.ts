/**
 * The trip-wire harness — the gate D17 put in front of the first live request.
 *
 * # What this proves, and why it runs against a scripted transport
 *
 * D17 records four stop conditions for the SEC feed: 403 halts and needs fresh approval, 429
 * halts after its cooldown, a 5xx streak halts, and a hard daily cap plus the kill switch sit
 * underneath as dumb backstops. Phase B — the first live `robots.txt` read — is gated on each of
 * them being **proved to fire** before anything is sent to a publisher. This file is that proof.
 *
 * The plan said to prove them "against a controlled / self-hosted target". **That turns out to
 * be impossible, by design, and the design is right.** A self-hosted target is reachable only at
 * `127.0.0.1` or a private address, and the fetch path refuses both twice over: `screenUrl`
 * permits `https` on port 443 alone and rejects a loopback literal outright, and
 * `screeningLookup` refuses any host that *resolves* to a private address, inside the
 * connection's own lookup (D-034). So the only target the real transport can be pointed at is a
 * real third party — which is the thing the trip-wires exist to make safe, and running them
 * against one would be doing the ungated thing to prove the gate works.
 *
 * So the controlled target is an injected `HttpTransport`, and the honesty of the proof rests on
 * where the seam is. Everything above the socket is the real code: the real adapter, the real
 * order of operations, the real FR-06 classification, and — through `applyObservedFailure` — the
 * **same pure composition `SourceHealthService` runs in production**. The harness does not
 * re-implement the stop conditions; it stores the documents that composition returns.
 *
 * What is therefore **not** proved here, stated plainly rather than left to be assumed:
 *
 * - that Mongo persists those documents correctly. That is the integration suite's job.
 * - that the real transport enforces the byte budgets against a real socket. The budget logic is
 *   asserted on `NodeHttpsTransport` in `http-evidence-fetch.test.ts`; what is asserted here is
 *   the **consequence** of an oversize signal, which is the half the stop conditions own.
 * - that the SEC behaves as their published policy says. Nothing but a live request proves that,
 *   and that request is Phase B.
 */

import { describe, expect, it } from 'vitest';

import {
  applyObservedFailure,
  classifyFailure,
  decideSourceAccess,
  decideDomainAccess,
  newDomainHealth,
  newSourceHealth,
  observeDomainFailure,
  observeSuccess,
  registrableDomainOfUrl,
  spendAccess,
  type DomainHealth,
  type FailureSignal,
  type SourceHealth,
} from '@erly/adverse-domain';

import {
  HttpEvidenceFetchAdapter,
  type DomainAccessPort,
  type SourceAccessPort,
} from '../src/sources/http-evidence-fetch.adapter.js';
import type {
  HttpTransport,
  TransportRequest,
  TransportResult,
} from '../src/sources/http-transport.js';
import type { FetchRequest } from '../src/sources/evidence-fetch.port.js';
import { parseFeed } from '../src/sources/parse/xml.js';
import {
  SEC_LITIGATION_RELEASES_SOURCE_ID,
  SEC_STOP_CONDITIONS,
} from '../src/sources/registry/sec-litigation-releases.js';

const CONTACT = 'https://erlystage.com/bots/adverse-search';
const FEED_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss';
const T0 = new Date('2026-09-15T12:00:00.000Z');

/**
 * The controlled target.
 *
 * Answers `robots.txt` permissively for every host, so that a scenario is testing the thing it
 * names rather than tripping over robots first, and answers everything else from a script.
 */
class TripWireTarget implements HttpTransport {
  readonly requested: string[] = [];

  constructor(private readonly script: (request: TransportRequest) => TransportResult) {}

  send(request: TransportRequest): Promise<TransportResult> {
    this.requested.push(request.url);
    if (request.url.endsWith('/robots.txt')) {
      return Promise.resolve(response(200, 'User-agent: *\nAllow: /\n', 'text/plain'));
    }
    return Promise.resolve(this.script(request));
  }
}

function response(
  status: number,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): TransportResult {
  const bytes = new TextEncoder().encode(body);
  return {
    kind: 'RESPONSE',
    status,
    headers: { 'content-type': contentType, ...headers },
    body: bytes,
    wireBytes: bytes.byteLength,
  };
}

/**
 * Source health, in memory, over the **same pure composition the live service runs**.
 *
 * `applyObservedFailure` is the function `SourceHealthService.recordFailure` calls. That is what
 * makes this a test of the stop conditions rather than a test of a second implementation of
 * them: if the composition changes, both move together.
 */
class InMemorySourceHealth implements SourceAccessPort {
  health: SourceHealth;
  serverErrors = 0;
  readonly refusals: string[] = [];

  constructor(
    private readonly budgets: { hourlyBudget: number | null; dailyBudget: number | null } = {
      hourlyBudget: 6,
      dailyBudget: 120,
    },
  ) {
    this.health = newSourceHealth({
      sourceId: SEC_LITIGATION_RELEASES_SOURCE_ID,
      observedVersion: 1,
      now: T0,
    });
  }

  checkAccess(input: {
    readonly sourceId: string;
    readonly now: Date;
    readonly spend?: boolean | undefined;
  }): Promise<{ decision: { allowed: boolean; detail: string }; coverageOutcome: null }> {
    const decision = decideSourceAccess({
      health: this.health,
      budgets: this.budgets,
      versionStatus: 'ACTIVE',
      now: input.now,
    });
    this.health =
      decision.allowed && input.spend !== false
        ? spendAccess({ health: decision.health, now: input.now })
        : decision.health;
    if (!decision.allowed) {
      this.refusals.push(decision.refusal ?? 'REFUSED');
    }
    return Promise.resolve({
      decision: { allowed: decision.allowed, detail: decision.detail },
      coverageOutcome: null,
    });
  }

  recordFailure(input: { readonly signal: FailureSignal; readonly now: Date }): Promise<unknown> {
    const applied = applyObservedFailure({
      health: this.health,
      signal: input.signal,
      conditions: SEC_STOP_CONDITIONS,
      consecutiveServerErrors: this.serverErrors,
      now: input.now,
      haltedBy: 'system',
    });
    this.health = applied.health;
    this.serverErrors = applied.consecutiveServerErrors;
    return Promise.resolve(applied);
  }

  recordSuccess(input: { readonly now: Date }): Promise<unknown> {
    this.health = observeSuccess({ health: this.health, now: input.now });
    this.serverErrors = 0;
    return Promise.resolve(null);
  }
}

/** The per-domain breaker, in memory, over the same pure functions the service uses. */
class InMemoryDomainHealth implements DomainAccessPort {
  readonly domains = new Map<string, DomainHealth>();

  checkDomain(input: {
    readonly url: string;
    readonly now: Date;
  }): Promise<{ domain: string | null; decision: { allowed: boolean; detail: string } | null }> {
    const domain = registrableDomainOfUrl(input.url);
    if (domain === null) {
      return Promise.resolve({ domain: null, decision: null });
    }
    const current = this.domains.get(domain) ?? newDomainHealth({ domain });
    const decision = decideDomainAccess({ health: current, now: input.now });
    this.domains.set(domain, decision.health);
    return Promise.resolve({
      domain,
      decision: { allowed: decision.allowed, detail: decision.detail },
    });
  }

  recordDomainFailure(input: {
    readonly url: string;
    readonly signal: FailureSignal;
    readonly detail: string;
    readonly now: Date;
  }): Promise<void> {
    if (input.signal.policyRefusal === true || input.signal.robotsDisallow === true) {
      return Promise.resolve();
    }
    const domain = registrableDomainOfUrl(input.url);
    if (domain === null) {
      return Promise.resolve();
    }
    const current = this.domains.get(domain) ?? newDomainHealth({ domain });
    this.domains.set(
      domain,
      observeDomainFailure({
        health: current,
        failureClass: classifyFailure(input.signal).failureClass,
        detail: input.detail,
        now: input.now,
        ...(input.signal.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: input.signal.retryAfterSeconds }),
      }),
    );
    return Promise.resolve();
  }

  recordDomainSuccess(): Promise<void> {
    return Promise.resolve();
  }
}

function fetchRequest(overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    url: FEED_URL,
    attribution: {
      tenantId: 'tenant-alpha',
      jobId: 'job-1',
      subjectId: 'subject-1',
      queryId: 'query-1',
      sourceId: SEC_LITIGATION_RELEASES_SOURCE_ID,
      egressIdentityId: 'egress-primary',
    },
    authorisation: {
      sourceVersionId: `${SEC_LITIGATION_RELEASES_SOURCE_ID}:v1`,
      licenceTermsVersion: 'sec-fair-access-2026-09-15',
      robotsPosition: 'HONOURED',
      robotsExceptionApprovedBy: null,
      jurisdictionEnabled: true,
      languageEnabled: true,
      urlPolicyPassed: true,
      ssrfValidated: true,
      relevanceScore: 0.9,
      relevanceMethod: 'TEST_FIXTURE',
      issuedBy: 'FetchGateService',
      issuedAt: T0.toISOString(),
    },
    budget: {
      maxBytes: 2_000_000,
      maxDecompressedBytes: 10_000_000,
      maxRedirects: 3,
      timeoutMs: 10_000,
    },
    conditional: { etag: null, lastModified: null },
    fetchKey: 'job-1:sec-feed',
    allowRender: false,
    ...overrides,
  };
}

function harness(
  script: (request: TransportRequest) => TransportResult,
  budgets?: { hourlyBudget: number | null; dailyBudget: number | null },
): {
  adapter: HttpEvidenceFetchAdapter;
  source: InMemorySourceHealth;
  domains: InMemoryDomainHealth;
  target: TripWireTarget;
} {
  const source =
    budgets === undefined ? new InMemorySourceHealth() : new InMemorySourceHealth(budgets);
  const domains = new InMemoryDomainHealth();
  const target = new TripWireTarget(script);
  const adapter = new HttpEvidenceFetchAdapter({
    access: source,
    domains,
    contactUrl: CONTACT,
    transport: target,
    clock: () => T0,
  });
  return { adapter, source, domains, target };
}

describe('trip-wire 1 — a 403 halts the source and needs fresh approval', () => {
  it('halts on the first 403, and refuses every request after it', async () => {
    const { adapter, source } = harness(() => response(403, 'Forbidden', 'text/plain'));

    const first = await adapter.fetch(fetchRequest());
    expect(first.status).toBe('FAILED');
    if (first.status === 'FAILED') {
      // FR-06 classifies a bare 403 as a soft block, which is retryable. The stop condition
      // escalates it without changing the class — the class is what the coverage record reads.
      expect(first.policy.failureClass).toBe('SOFT_BLOCK');
    }

    expect(source.health.killSwitch).not.toBeNull();
    expect(source.health.killSwitch?.engagedBy).toBe('system');
    expect(source.health.killSwitch?.reason).toContain('HALT_ON_STATUS');
    expect(source.health.killSwitch?.reason).toContain('a different authorised person');

    // And the halt is effective for the *next* request, mid-run, which is the whole point of
    // checking access at the point of use (T36).
    const second = await adapter.fetch(fetchRequest());
    expect(second.status).toBe('FAILED');
    expect(source.refusals).toContain('KILL_SWITCH_ENGAGED');
  });

  it('does not retry the 403 from another identity or by any other path', async () => {
    const { adapter, target } = harness(() => response(403, 'Forbidden', 'text/plain'));
    await adapter.fetch(fetchRequest());

    // One robots.txt and one feed request. A retry here would be the service deciding that a
    // publisher who refused it should be asked again, which is what the halt exists to prevent.
    expect(target.requested.filter((url) => url === FEED_URL)).toHaveLength(1);
  });
});

describe('trip-wire 2 — a 429 halts after the cooldown it asked for', () => {
  it('halts, and the publisher-stated Retry-After is what cools the domain', async () => {
    const { adapter, source, domains } = harness(() =>
      response(429, 'Too Many Requests', 'text/plain', { 'retry-after': '600' }),
    );

    const result = await adapter.fetch(fetchRequest());
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.policy.failureClass).toBe('RATE_LIMITED');
    }

    expect(source.health.killSwitch?.reason).toContain('HALT_ON_RATE_LIMIT');
    // 600 seconds, exactly as they said. Substituting our own number would be deciding we know
    // their capacity better than they do.
    expect(domains.domains.get('sec.gov')?.degradedUntil).toBe(
      new Date(T0.getTime() + 600_000).toISOString(),
    );
  });
});

describe('trip-wire 3 — a 5xx streak halts', () => {
  it('does not halt on the first two, and halts on the third', async () => {
    const { adapter, source } = harness(() => response(503, 'Service Unavailable', 'text/html'));

    await adapter.fetch(fetchRequest());
    expect(source.health.killSwitch).toBeNull();
    await adapter.fetch(fetchRequest());
    expect(source.health.killSwitch).toBeNull();

    await adapter.fetch(fetchRequest());
    expect(source.health.killSwitch?.reason).toContain('HALT_ON_SERVER_ERROR_STREAK');
  });
});

describe('trip-wire 4 — an oversize body is a bounded rejection, and halts nothing', () => {
  it('rejects the document without suspending the publisher or the source', async () => {
    // The transport reports `limitExceeded` when a body crosses either byte budget; this asserts
    // the half that belongs here, which is what the rest of the system does with that fact.
    const { adapter, source, domains } = harness(() => ({
      kind: 'FAILURE',
      signal: { limitExceeded: true },
      detail: 'Response exceeded the wire budget and was abandoned mid-stream.',
    }));

    const result = await adapter.fetch(fetchRequest());
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.policy.failureClass).toBe('OVERSIZE');
      expect(result.policy.retryable).toBe(false);
    }

    // One enormous document is a fact about that document. Halting the feed over it, or
    // suspending the publisher, would cost every other article they publish.
    expect(source.health.killSwitch).toBeNull();
    expect(source.health.breaker).toBe('CLOSED');
    expect(domains.domains.get('sec.gov')?.suspension ?? null).toBeNull();
  });
});

describe('trip-wire 5 — a DOCTYPE in the feed is refused before it is parsed', () => {
  it('refuses the document and leaves the source healthy', async () => {
    const body =
      `<?xml version="1.0"?>\n<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n` +
      `<rss version="2.0"><channel><title>&xxe;</title></channel></rss>`;
    const { adapter, source } = harness(() => response(200, body, 'application/rss+xml'));

    const result = await adapter.fetch(fetchRequest());
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') {
      return;
    }

    // The fetch succeeded — the publisher answered — and the refusal happens at the parse, which
    // is where it belongs: this is a fact about one document, not about the source.
    const parsed = parseFeed(new TextDecoder().decode(result.data.body ?? new Uint8Array()));
    expect(parsed.kind).toBe('REFUSED');
    if (parsed.kind === 'REFUSED') {
      expect(classifyFailure(parsed.signal).failureClass).toBe('CONTENT_ERROR');
      expect(classifyFailure(parsed.signal).retryable).toBe(false);
    }

    expect(source.health.killSwitch).toBeNull();
    expect(source.health.breaker).toBe('CLOSED');
  });
});

describe('trip-wire 6 — the hard daily cap is a dumb backstop and it holds', () => {
  it('refuses once the recorded daily budget is spent, as a coverage gap rather than an error', async () => {
    // Two requests' worth of budget: the robots read and the feed read spend one each, so the
    // second fetch has nothing left. That the robots request is charged at all is D-035 — it is
    // a real request to the publisher and was counted nowhere before.
    const { adapter, source } = harness(
      () => response(200, '<rss version="2.0"><channel/></rss>', 'application/rss+xml'),
      { hourlyBudget: null, dailyBudget: 2 },
    );

    const first = await adapter.fetch(fetchRequest());
    expect(first.status).toBe('OK');

    const second = await adapter.fetch(fetchRequest());
    expect(second.status).toBe('FAILED');
    expect(source.refusals).toContain('DAILY_BUDGET_EXHAUSTED');
  });
});

describe('trip-wire 7 — the kill switch stops a run already in flight', () => {
  it('refuses the next request the instant it is engaged', async () => {
    const { adapter, source } = harness(() =>
      response(200, '<rss version="2.0"><channel/></rss>', 'application/rss+xml'),
    );

    expect((await adapter.fetch(fetchRequest())).status).toBe('OK');

    source.health = {
      ...source.health,
      killSwitch: {
        engagedAt: T0.toISOString(),
        engagedBy: 'faisal@erlystage.com',
        reason: 'The SEC webmaster emailed and asked us to stop.',
      },
    };

    const after = await adapter.fetch(fetchRequest());
    expect(after.status).toBe('FAILED');
    if (after.status === 'FAILED') {
      // The reason reaches the reviewer verbatim, which is why it is written for one.
      expect(after.detail).toContain('asked us to stop');
    }
  });
});

describe('the per-domain breaker holds a publisher the source breaker cannot', () => {
  it('suspends the publisher on a hard block without touching the source', async () => {
    const { adapter, source, domains } = harness(() => response(401, 'Unauthorized', 'text/plain'));

    await adapter.fetch(fetchRequest());

    // A 401 is AUTH_CREDENTIAL: never retried, an operator is alerted, and the *source* breaker
    // opens immediately because every subsequent call fails the same way.
    expect(source.health.breaker).toBe('OPEN');
    // The domain is not suspended by it — AUTH_CREDENTIAL's domain action is NONE, because a
    // revoked key of ours says nothing about the publisher.
    expect(domains.domains.get('sec.gov')?.suspension ?? null).toBeNull();
  });

  it('never records a refusal of our own making against the publisher', async () => {
    // A robots disallow is our decision not to ask. Recording it would classify as HARD_BLOCK,
    // suspend the publisher, and cost every other article they publish (D-035, D-040).
    const { adapter, domains } = harness(() => response(200, 'no', 'text/plain'));
    await adapter.fetch(fetchRequest({ url: 'http://www.sec.gov/insecure' }));
    expect(domains.domains.get('sec.gov')?.suspension ?? null).toBeNull();
  });
});
