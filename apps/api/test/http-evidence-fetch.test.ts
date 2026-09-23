/**
 * `HttpEvidenceFetchAdapter` — Phase E step 1.
 *
 * **Every test here runs against an injected transport. No socket is opened, by design and not
 * by accident:** the real transport is constructed only by the live composition root, and a test
 * that reached a publisher would make this project's standing claim — that no live source has
 * ever been contacted — false, silently, in a way nobody would notice until it was quoted to a
 * customer.
 *
 * What is asserted here is the part that has to be right: the refusals. A fetch adapter that
 * returns bytes is easy; one that refuses correctly, records the refusal against the right thing,
 * and never turns a block into a clean result is the whole job.
 */

import { describe, expect, it } from 'vitest';

import { classifyFailure, type FailureSignal } from '@erly/adverse-domain';

import { RequestPacer } from '../src/sources/request-pacer.js';
import {
  HttpEvidenceFetchAdapter,
  detectChallenge,
  interpretRobotsResponse,
  type SourceAccessPort,
} from '../src/sources/http-evidence-fetch.adapter.js';
import {
  ForbiddenAddressError,
  networkSignal,
  screeningLookup,
  type HttpTransport,
  type TransportRequest,
  type TransportResult,
} from '../src/sources/http-transport.js';
import type { FetchRequest } from '../src/sources/evidence-fetch.port.js';
import { hasData } from '../src/sources/source-adapter.js';

const CONTACT = 'https://erly.example/adverse-search/contact';

/** A transport that answers from a script and records what it was asked for. */
class ScriptedTransport implements HttpTransport {
  readonly calls: TransportRequest[] = [];

  constructor(private readonly script: (request: TransportRequest) => TransportResult) {}

  send(request: TransportRequest): Promise<TransportResult> {
    this.calls.push(request);
    return Promise.resolve(this.script(request));
  }
}

/** Records every health call, so "which of these was charged to the source" is assertable. */
class RecordingAccess implements SourceAccessPort {
  readonly checks: { sourceId: string; spend: boolean }[] = [];
  readonly failures: FailureSignal[] = [];
  successes = 0;

  constructor(private readonly allowed = true) {}

  checkAccess(input: { readonly sourceId: string; readonly spend?: boolean | undefined }): Promise<{
    decision: { allowed: boolean; detail: string };
    coverageOutcome: null;
  }> {
    this.checks.push({ sourceId: input.sourceId, spend: input.spend !== false });
    return Promise.resolve({
      decision: {
        allowed: this.allowed,
        detail: this.allowed ? 'Permitted.' : 'The kill switch is engaged for this source.',
      },
      coverageOutcome: null,
    });
  }

  recordFailure(input: { readonly signal: FailureSignal }): Promise<unknown> {
    this.failures.push(input.signal);
    return Promise.resolve(null);
  }

  recordSuccess(): Promise<unknown> {
    this.successes += 1;
    return Promise.resolve(null);
  }
}

function request(overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    url: 'https://www.example-news.cr/sucesos/uno',
    attribution: {
      tenantId: 'tenant-alpha',
      jobId: 'job-1',
      subjectId: 'subject-1',
      queryId: 'query-1',
      sourceId: 'src-example-news',
      egressIdentityId: 'egress-1',
    },
    authorisation: {
      sourceVersionId: 'src-example-news:v3',
      licenceTermsVersion: 'terms-2026-01',
      robotsPosition: 'HONOURED',
      robotsExceptionApprovedBy: null,
      robotsExceptionDeliveryHosts: [],
      requestCeilingPerSecond: null,
      jurisdictionEnabled: true,
      languageEnabled: true,
      urlPolicyPassed: true,
      ssrfValidated: true,
      relevanceScore: 0.8,
      relevanceMethod: 'TEST_FIXTURE',
      issuedBy: 'FetchGateService',
      issuedAt: '2026-09-14T00:00:00.000Z',
    },
    budget: {
      maxBytes: 2_000_000,
      maxDecompressedBytes: 10_000_000,
      maxRedirects: 3,
      timeoutMs: 10_000,
    },
    conditional: { etag: null, lastModified: null },
    fetchKey: 'job-1:lead-1',
    allowRender: false,
    ...overrides,
  };
}

function response(
  status: number,
  headers: Record<string, string>,
  body = '',
): Extract<TransportResult, { kind: 'RESPONSE' }> {
  const encoded = new TextEncoder().encode(body);
  return { kind: 'RESPONSE', status, headers, body: encoded, wireBytes: encoded.byteLength };
}

const ROBOTS_ALLOW_ALL = 'User-agent: *\nDisallow:\n';

/** A transport that serves a permissive robots.txt and then whatever the caller scripted. */
function withRobots(
  // A function rather than a value where the answer changes between reads — a publisher with a
  // rate limiter refuses the first robots.txt and serves the second, and a fixed value cannot
  // express that.
  robots: TransportResult | (() => TransportResult),
  document: (request: TransportRequest) => TransportResult,
): ScriptedTransport {
  return new ScriptedTransport((r) =>
    r.url.endsWith('/robots.txt')
      ? typeof robots === 'function'
        ? robots()
        : robots
      : document(r),
  );
}

function adapter(transport: HttpTransport, access: SourceAccessPort): HttpEvidenceFetchAdapter {
  return new HttpEvidenceFetchAdapter({ access, contactUrl: CONTACT, transport });
}

describe('the gate, before any socket', () => {
  it('refuses to be constructed without a contact URL', () => {
    // FR-06: "The user agent identifies the service honestly with a contact URL." An empty one
    // is not a degraded mode, it is the anonymous crawler the requirement forbids.
    expect(
      () => new HttpEvidenceFetchAdapter({ access: new RecordingAccess(), contactUrl: '  ' }),
    ).toThrow(/contact URL/i);
  });

  it('throws on an authorisation whose gates did not all pass', async () => {
    const transport = withRobots(
      response(200, { 'content-type': 'text/plain' }, ROBOTS_ALLOW_ALL),
      () => response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    const subject = adapter(transport, new RecordingAccess());
    await expect(
      subject.fetch(
        request({
          authorisation: { ...request().authorisation, ssrfValidated: false },
        }),
      ),
    ).rejects.toThrow(/SSRF validation not performed/);
    // Nothing was asked of anybody. A gate refusal is not a coverage gap.
    expect(transport.calls).toHaveLength(0);
  });

  it('throws on an EXCEPTION_APPROVED authorisation with nobody named (FR-06, D6)', async () => {
    const subject = adapter(
      withRobots(response(404, {}), () => response(200, {}, 'x')),
      new RecordingAccess(),
    );
    await expect(
      subject.fetch(
        request({
          authorisation: {
            ...request().authorisation,
            robotsPosition: 'EXCEPTION_APPROVED',
            robotsExceptionApprovedBy: null,
            robotsExceptionDeliveryHosts: [],
            requestCeilingPerSecond: null,
          },
        }),
      ),
    ).rejects.toThrow(/approved by nobody/);
  });

  it('throws on an unattributable request', async () => {
    const subject = adapter(
      withRobots(response(404, {}), () => response(200, {}, 'x')),
      new RecordingAccess(),
    );
    await expect(
      subject.fetch(request({ attribution: { ...request().attribution, queryId: '' } })),
    ).rejects.toThrow(/Unattributable outbound request \(missing: queryId\)/);
  });
});

describe('SEC-02: the URL and the addresses behind it', () => {
  it.each([
    ['the cloud metadata service over https', 'https://169.254.169.254/latest/meta-data/'],
    ['our own database on loopback', 'https://127.0.0.1:28017/'],
    ['a private range', 'https://10.0.0.5/admin'],
    ['an IPv4-mapped IPv6 literal', 'https://[::ffff:127.0.0.1]/'],
    ['a non-https scheme', 'http://www.example-news.cr/sucesos/uno'],
    ['credentials embedded in the URL', 'https://user:pass@www.example-news.cr/x'],
  ])('refuses %s without opening a socket', async (_label, url) => {
    const transport = withRobots(response(404, {}), () => response(200, {}, 'x'));
    const access = new RecordingAccess();
    const outcome = await adapter(transport, access).fetch(request({ url }));

    expect(outcome.status).toBe('FAILED');
    expect(transport.calls).toHaveLength(0);
    // Our refusal, so the source's health hears nothing about it. A discovery feed is not
    // unwell because one of the links it listed pointed at the metadata service.
    expect(access.failures).toHaveLength(0);
  });

  it('refuses a redirect into a forbidden address, and never follows it', async () => {
    // https, so that the *address* is what refuses this rather than the scheme. A 302 into the
    // metadata service is the obvious way to carry a request past a gate that only screened the
    // URL discovery handed it.
    const transport = withRobots(
      response(200, { 'content-type': 'text/plain' }, ROBOTS_ALLOW_ALL),
      () => response(302, { location: 'https://169.254.169.254/latest/meta-data/' }),
    );
    const access = new RecordingAccess();
    const outcome = await adapter(transport, access).fetch(request());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.signal).toEqual({ policyRefusal: true });
    }
    const dialled = transport.calls.map((c) => c.url);
    expect(dialled).not.toContain('https://169.254.169.254/latest/meta-data/');
    // robots.txt and the first hop only.
    expect(dialled).toHaveLength(2);
    expect(access.failures).toHaveLength(0);
  });

  it('screens every resolved address, and one forbidden address refuses the whole host', () => {
    // The guarantee asserted directly, because it is the one that defeats DNS rebinding and it
    // lives inside the lookup the connection itself calls.
    const mixed = [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    const forbidden = mixed.filter((entry) => entry.address === '127.0.0.1');
    expect(forbidden).toHaveLength(1);
    expect(typeof screeningLookup).toBe('function');
    // And a refused address reports as our policy, never as a network fault — the distinction
    // that keeps it off the source's health record.
    expect(networkSignal(new ForbiddenAddressError('x'))).toEqual({ policyRefusal: true });
    expect(networkSignal({ name: 'Error', message: 'x', code: 'ECONNRESET' })).toEqual({
      syscallCode: 'ECONNRESET',
    });
  });
});

describe('robots.txt', () => {
  it('refuses a disallowed path and does not fetch it', async () => {
    const transport = withRobots(
      response(200, { 'content-type': 'text/plain' }, 'User-agent: *\nDisallow: /sucesos/\n'),
      () => response(200, { 'content-type': 'text/html' }, '<html>never served</html>'),
    );
    const access = new RecordingAccess();
    const outcome = await adapter(transport, access).fetch(request());

    expect(outcome.status).toBe('FAILED');
    expect(transport.calls.map((c) => c.url)).toEqual(['https://www.example-news.cr/robots.txt']);
    // T86: not fetched, recorded as a lead with a reason — and not counted against the source.
    expect(access.failures).toHaveLength(0);
  });

  it('refuses when robots.txt could not be read: an outage is not consent', async () => {
    const transport = withRobots(
      { kind: 'FAILURE', signal: { httpStatus: 503 }, detail: 'down' },
      () => response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    const outcome = await adapter(transport, new RecordingAccess()).fetch(request());

    expect(outcome.status).toBe('FAILED');
    expect(transport.calls.map((c) => c.url)).toEqual(['https://www.example-news.cr/robots.txt']);
  });

  it('treats a 404 robots.txt as permission, because the publisher chose not to write one', async () => {
    const transport = withRobots(response(404, {}), () =>
      response(200, { 'content-type': 'text/html' }, '<html>served</html>'),
    );
    const outcome = await adapter(transport, new RecordingAccess()).fetch(request());

    expect(outcome.status).toBe('OK');
  });

  it('treats an HTML page served as a 200 robots.txt as unreadable, not as no rules', () => {
    // The commonest way a robots.txt "succeeds" while telling us nothing. Parsing it would find
    // no rules, and no rules reads as permission.
    const html = interpretRobotsResponse(
      response(200, { 'content-type': 'text/html' }, '<html><body>Not found</body></html>'),
    );
    expect(html.known).toBe(false);
    expect(interpretRobotsResponse(response(404, {})).known).toBe(true);
  });

  it('does not cache an unreadable robots.txt, so one 429 does not refuse a host all day', async () => {
    // The regression this guards is not hypothetical: on 2026-09-18 a live folder-15 run was
    // refused for its whole duration because the FIRST robots.txt read of api.gdeltproject.org
    // came back 429. That answer — "we could not establish a position just now" — was cached for
    // the full 24-hour TTL, so every later query in the run was refused on the strength of one
    // transient rate-limit response from a publisher who had restricted nothing.
    let attempt = 0;
    const transport = withRobots(
      () => {
        attempt += 1;
        // Rate-limited once, then the real file: exactly what a publisher with a rate limiter does.
        return attempt === 1
          ? response(429, { 'content-type': 'text/plain' }, 'slow down')
          : response(200, { 'content-type': 'text/plain' }, ROBOTS_ALLOW_ALL);
      },
      () => response(200, { 'content-type': 'text/html' }, '<html>served</html>'),
    );
    const subject = adapter(transport, new RecordingAccess());

    const first = await subject.fetch(request());
    expect(first.status).toBe('FAILED');

    // The second attempt must re-read rather than serve the refusal from cache.
    const second = await subject.fetch(request({ url: 'https://www.example-news.cr/sucesos/dos' }));
    expect(second.status).toBe('OK');
    expect(transport.calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('paces the robots.txt read by the approved ceiling, because it is a request too', async () => {
    // robots.txt leaves this process, appears in the publisher's log and is refused by their rate
    // limiter like anything else. Pacing the document fetch while hammering robots.txt would
    // honour the ceiling everywhere except the request that decides whether we may make the rest.
    const waits: number[] = [];
    const pacer = new RequestPacer({
      now: () => 0,
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const transport = withRobots(
      response(200, { 'content-type': 'text/plain' }, ROBOTS_ALLOW_ALL),
      () => response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    const subject = new HttpEvidenceFetchAdapter({
      access: new RecordingAccess(),
      contactUrl: CONTACT,
      transport,
      pacer,
      // No cache, so each fetch re-reads robots and the pacer is asked twice.
      robotsTtlMs: 0,
    });

    await subject.fetch(
      request({ authorisation: { ...request().authorisation, requestCeilingPerSecond: 0.2 } }),
    );
    await subject.fetch(
      request({
        url: 'https://www.example-news.cr/sucesos/dos',
        authorisation: { ...request().authorisation, requestCeilingPerSecond: 0.2 },
      }),
    );

    // Four outbound requests reached this publisher — robots, document, robots, document — and
    // every one after the first waited out GDELT's published five seconds. The robots read and
    // the document fetch share ONE key, which is the whole point: keying them separately is how
    // the 2026-09-18 live run sent two requests with no gap and was rate-limited for it.
    expect(transport.calls).toHaveLength(4);
    expect(waits).toEqual([5000, 5000, 5000]);
  });

  it('fetches robots.txt once per host and serves the rest from cache', async () => {
    const transport = withRobots(
      response(200, { 'content-type': 'text/plain' }, ROBOTS_ALLOW_ALL),
      () => response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    const subject = adapter(transport, new RecordingAccess());
    await subject.fetch(request());
    await subject.fetch(request({ url: 'https://www.example-news.cr/sucesos/dos' }));

    const robotsCalls = transport.calls.filter((c) => c.url.endsWith('/robots.txt'));
    expect(robotsCalls).toHaveLength(1);
  });
});

describe('source health at the point of use (D5, T36)', () => {
  it('checks access immediately before the socket, and refuses when the switch is engaged', async () => {
    const transport = withRobots(response(404, {}), () => response(200, {}, 'x'));
    const access = new RecordingAccess(false);
    const outcome = await adapter(transport, access).fetch(request());

    expect(outcome.status).toBe('FAILED');
    // The check happened; the request did not. That is what makes the kill switch effective in
    // the middle of a run that started an hour ago.
    expect(access.checks.length).toBeGreaterThan(0);
    expect(transport.calls).toHaveLength(0);
    expect(access.failures).toHaveLength(0);
  });

  it('spends the budget once per request it actually issues, robots.txt included', async () => {
    const transport = withRobots(
      response(200, { 'content-type': 'text/plain' }, ROBOTS_ALLOW_ALL),
      () => response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    const access = new RecordingAccess();
    await adapter(transport, access).fetch(request());

    // Two requests went out — robots.txt and the document — and both were charged. The publisher
    // counts requests, not documents.
    expect(transport.calls).toHaveLength(2);
    expect(access.checks.filter((c) => c.spend)).toHaveLength(2);
    expect(access.checks.every((c) => c.sourceId === 'src-example-news')).toBe(true);
  });

  it('records a server failure against health, and a gate refusal never', async () => {
    const failing = withRobots(response(404, {}), () => response(503, {}));
    const access = new RecordingAccess();
    const outcome = await adapter(failing, access).fetch(request());

    expect(outcome.status).toBe('FAILED');
    expect(access.failures).toEqual([{ httpStatus: 503 }]);
    expect(classifyFailure(access.failures[0] ?? {}).failureClass).toBe('TRANSIENT_NETWORK');
  });

  it('never opens the source breaker on a robots disallow', () => {
    // The failure mode this guards is invisible until a working feed quietly disappears:
    // HARD_BLOCK carries domainAction SUSPEND, and D5's breaker opens immediately on that.
    const policy = classifyFailure({ robotsDisallow: true });
    expect(policy.failureClass).toBe('HARD_BLOCK');
    expect(policy.domainAction).toBe('SUSPEND');
    // Which is exactly why the adapter must not hand it to recordFailure — asserted above.
    expect(classifyFailure({ policyRefusal: true }).failureClass).toBe('HARD_BLOCK');
  });
});

describe('budgets and bounded failure (T38, T59)', () => {
  it('stops after the declared number of redirects', async () => {
    let hop = 0;
    const transport = withRobots(response(404, {}), () => {
      hop += 1;
      return response(302, { location: `https://www.example-news.cr/hop/${String(hop)}` });
    });
    const access = new RecordingAccess();
    const outcome = await adapter(transport, access).fetch(
      request({ budget: { ...request().budget, maxRedirects: 2 } }),
    );

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('OVERSIZE');
      expect(outcome.policy.retryable).toBe(false);
    }
    // Three document requests: the original plus the two permitted hops. Not an endless loop.
    expect(transport.calls.filter((c) => !c.url.endsWith('/robots.txt'))).toHaveLength(3);
  });

  it('passes both byte budgets through to the transport, separately', async () => {
    const transport = withRobots(response(404, {}), () =>
      response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    await adapter(transport, new RecordingAccess()).fetch(request());

    const document = transport.calls.find((c) => !c.url.endsWith('/robots.txt'));
    expect(document?.maxWireBytes).toBe(2_000_000);
    expect(document?.maxDecompressedBytes).toBe(10_000_000);
  });

  it('reports an oversize body as a non-retryable bounded rejection', async () => {
    const transport = withRobots(response(404, {}), () => ({
      kind: 'FAILURE',
      signal: { limitExceeded: true },
      detail: 'over budget',
    }));
    const outcome = await adapter(transport, new RecordingAccess()).fetch(request());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('OVERSIZE');
      expect(outcome.policy.maxAttempts).toBe(1);
    }
  });
});

describe('what comes back', () => {
  it('returns a 304 as a success with no body, never as an empty document', async () => {
    const transport = withRobots(response(404, {}), () => response(304, { etag: 'W/"v1"' }));
    const access = new RecordingAccess();
    const outcome = await adapter(transport, access).fetch(
      request({ conditional: { etag: 'W/"v1"', lastModified: null } }),
    );

    expect(outcome.status).toBe('OK');
    if (hasData(outcome)) {
      expect(outcome.data.notModified).toBe(true);
      // Null, not an empty array. An empty body would let a caller store an empty version over
      // a good one.
      expect(outcome.data.body).toBeNull();
      expect(outcome.data.bytes).toBe(0);
    }
    expect(access.successes).toBe(1);
  });

  it('sends the conditional headers on the first hop only', async () => {
    const transport = withRobots(response(404, {}), (r) =>
      r.url.endsWith('/uno')
        ? response(302, { location: 'https://www.example-news.cr/sucesos/dos' })
        : response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    await adapter(transport, new RecordingAccess()).fetch(
      request({ conditional: { etag: 'W/"v1"', lastModified: null } }),
    );

    const documents = transport.calls.filter((c) => !c.url.endsWith('/robots.txt'));
    expect(documents[0]?.headers['if-none-match']).toBe('W/"v1"');
    // Replaying it to whatever the redirect points at asks a different document about another
    // document's ETag, and a 304 to that would be an answer about nothing we hold.
    expect(documents[1]?.headers['if-none-match']).toBeUndefined();
  });

  it('carries an honest user agent naming the service and a contact URL', async () => {
    const transport = withRobots(response(404, {}), () =>
      response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    await adapter(transport, new RecordingAccess()).fetch(request());

    for (const call of transport.calls) {
      expect(call.headers['user-agent']).toContain(CONTACT);
      expect(call.headers['user-agent']).toMatch(/ErlyAdverseSearch/);
    }
  });

  it('stamps provenance with the source that approved the fetch, not with the transport', async () => {
    const transport = withRobots(response(404, {}), () =>
      response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    const outcome = await adapter(transport, new RecordingAccess()).fetch(request());

    // `AdapterDescriptor.sourceId` exists so a record can be traced to its approval. A document
    // stamped `src-http-fetch` would trace to a transport instead.
    expect(outcome.provenance.sourceId).toBe('src-example-news');
    expect(outcome.provenance.mode).toBe('LIVE');
  });

  it('never claims a render trigger, because nothing renders yet', async () => {
    const transport = withRobots(response(404, {}), () =>
      response(200, { 'content-type': 'text/html' }, '<html>x</html>'),
    );
    const outcome = await adapter(transport, new RecordingAccess()).fetch(
      request({ allowRender: true }),
    );

    if (hasData(outcome)) {
      // `allowRender` is permission, never a reason. Inventing a trigger would put a fabricated
      // justification into the record that exists to be audited.
      expect(outcome.data.renderTrigger).toBeNull();
    }
  });
});

describe('challenges are abandoned, never solved (T87)', () => {
  it('recognises an interstitial served as a 200 and reports it as a soft block', async () => {
    const transport = withRobots(response(404, {}), () =>
      response(
        200,
        { 'content-type': 'text/html' },
        '<html><body>Verifying you are human. DDoS protection by someone.</body></html>',
      ),
    );
    const access = new RecordingAccess();
    const outcome = await adapter(transport, access).fetch(request());

    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('SOFT_BLOCK');
      // The specification's own words, carried in the policy rather than in a comment.
      expect(outcome.policy.rationale).toMatch(/Never attempt to solve the challenge/);
    }
    // Only one attempt was made at this URL. No second identity, no retry, no bypass.
    expect(transport.calls.filter((c) => !c.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('does not mistake a MediaWiki config blob for a served challenge', () => {
    // THE REGRESSION, 2026-09-23. Every MediaWiki page embeds a config object in <head> naming
    // its edit-captcha extension. This is the real shape, from the Wikinews article the rung-5
    // acceptance chain runs on: a 200, 85KB, fully-served article. The detector matched the bare
    // substring inside that script and reported the publisher as serving a bot challenge, which
    // blocked en.wikinews.org entirely — and would block every other wiki the same way.
    const mediawiki =
      '<!DOCTYPE html><html><head><title>Madoff jailed after pleading guilty to $50 billion ' +
      'fraud scheme - Wikinews, the free news source</title>' +
      '<script>document.documentElement.className="client-js";' +
      'RLCONF={"wgRelevantArticleId":122401,"wgIsProbablyEditable":false,' +
      '"wgConfirmEditCaptchaNeededForGenericEdit":"hcaptcha",' +
      '"wgConfirmEditForceShowCaptcha":false,' +
      '"wgConfirmEditHCaptchaSiteKey":"5d0c670e-aaaa-bbbb-cccc-ddddddddddd"};</script>' +
      '</head><body><h1>Madoff jailed after pleading guilty to $50 billion fraud scheme</h1>' +
      '<p>Bernard Madoff was jailed today.</p></body></html>';
    expect(detectChallenge(new TextEncoder().encode(mediawiki), 'text/html')).toBeNull();
  });

  it('still catches a real interstitial, whose text is in the markup rather than a script', () => {
    // The other half, and the one that must not regress: excluding scripts is not a loosening.
    // A real challenge page exists to be read by a person, so its text is in the title and the
    // visible body, and all of that survives script-stripping.
    const challenge =
      '<!DOCTYPE html><html><head><title>Just a moment...</title>' +
      '<script>window.__cf={};</script></head>' +
      '<body><h1>Verifying you are human</h1><p>Enable JavaScript and cookies to continue</p>' +
      '</body></html>';
    const detected = detectChallenge(new TextEncoder().encode(challenge), 'text/html');
    expect(detected).not.toBeNull();
    expect(detected).toMatch(/verifying you are human|enable javascript and cookies/iu);

    // And one whose marker is in an attribute rather than text — also outside any script.
    const cf =
      '<!DOCTYPE html><html><body><div id="cf-challenge-running">Checking your browser</div>' +
      '</body></html>';
    expect(detectChallenge(new TextEncoder().encode(cf), 'text/html')).not.toBeNull();
  });

  it('does not let a marker hide in a script the read window cut in half', () => {
    // An unterminated <script> at the end of the window is dropped whole, so a page cannot
    // smuggle a challenge past the check by making its scripts long.
    const truncated = `<html><head><script>${'x'.repeat(200)}` + 'captcha';
    expect(detectChallenge(new TextEncoder().encode(truncated), 'text/html')).toBeNull();

    // But the same marker in the body, after a properly closed script, is still caught.
    const afterScript = `<html><head><script>${'x'.repeat(200)}</script></head>` +
      '<body>Are you a robot</body></html>';
    expect(detectChallenge(new TextEncoder().encode(afterScript), 'text/html')).not.toBeNull();
  });

  it('does not mistake an article that discusses captchas for a challenge page', () => {
    // A false positive costs one lead; a false negative stores a challenge page as evidence
    // about a person. The check is deliberately confined to the head of an HTML body.
    const long = `${'<p>ordinary reporting</p>'.repeat(400)}<p>the word captcha appears late</p>`;
    expect(detectChallenge(new TextEncoder().encode(long), 'text/html')).toBeNull();
    expect(
      detectChallenge(new TextEncoder().encode('%PDF-1.4 captcha'), 'application/pdf'),
    ).toBeNull();
  });
});
