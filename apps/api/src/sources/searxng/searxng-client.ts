/**
 * Talking to our own SearXNG instance — the transport, and nothing that makes a judgement.
 *
 * # Why this is not `EvidenceFetchPort`, and why that is not a loophole
 *
 * Every other outbound path in this service goes through `HttpEvidenceFetchAdapter`, and the
 * obvious question is why this one does not. The answer is that `EvidenceFetchPort` enforces
 * SEC-02, and SEC-02 would refuse this address — correctly.
 *
 * `screenUrl` refuses anything that is not `https:` on port 443, and refuses any host that is a
 * loopback or private address. `http://127.0.0.1:28888` fails both. That is not SEC-02 being
 * over-broad: SEC-02 exists because **discovery returns URLs we did not choose**, and a fetcher
 * that dials an address a news feed named is a server-side request forgery primitive. The
 * defence is to refuse private addresses outright, because a discovered URL has no business
 * pointing at one.
 *
 * The SearXNG base URL is the opposite kind of address. It comes from this deployment's own
 * configuration, it is fixed for the life of the process, and no input to any search can change
 * it. Routing it through the gate built for third-party URLs would mean either weakening that
 * gate — punching a loopback exception into the one function that stops a feed reaching our
 * database — or moving the metasearch instance onto the public internet so it could satisfy a
 * rule written for the public internet. Both are worse than a separate transport that can only
 * ever reach one configured host.
 *
 * So the rule here is narrower than SEC-02 rather than looser: this client will not issue a
 * request to any URL that is not the configured base URL plus a known path. There is no method
 * that takes a caller-supplied host, and `assertUnderBase` re-checks the assembled URL against
 * the base immediately before the socket opens. A query cannot introduce a host, a scheme, a
 * port or a path segment, because `URL` does the assembling and the result is compared back.
 *
 * **The leads it returns are screened normally.** Everything SearXNG hands back is a third-party
 * URL and goes through `screenUrl` in `leadsFrom`, then through `FetchGateService` before any
 * byte of an article is read. Nothing about this transport reaches the document path.
 *
 * # What it does not do
 *
 * It does not retry, classify, filter, deduplicate or decide. It opens one connection, bounds
 * it, and returns either the parsed JSON or a fact about why there is none. Judgement belongs to
 * the adapter and retry policy belongs to `classifyFailure`, exactly as `http-transport.ts` says
 * for the external path.
 */

import http from 'node:http';
import https from 'node:https';

/** The documented JSON search interface. The HTML UI is never read — see the adapter header. */
const SEARCH_PATH = '/search';

/** SearXNG's own configuration endpoint, which reports the engines the instance actually has. */
const CONFIG_PATH = '/config';

/**
 * The wire budget for one metasearch response.
 *
 * A page of news results is a list of headlines. Generous enough that a full page of a dozen
 * engines fits, small enough that a response which has become something else is refused before
 * it is allocated rather than after.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface SearxngBaseUrl {
  /** Normalised: scheme, host, port, no path, no trailing slash. */
  readonly value: string;
  readonly host: string;
}

export type BaseUrlValidation =
  | { readonly kind: 'OK'; readonly base: SearxngBaseUrl }
  | { readonly kind: 'REFUSED'; readonly detail: string };

/**
 * Validate the configured base URL.
 *
 * Deliberately permissive about loopback and about `http:`, and deliberately strict about
 * everything else. A loopback address is the expected shape here and `http` on a loopback
 * interface carries no transport risk that TLS would remove. What is refused is anything that
 * would make this client into a general-purpose fetcher: a scheme that is not http or https,
 * embedded credentials, a path, a query or a fragment. A base URL carrying a path would let a
 * configuration value decide which endpoint is called, and configuration is not the place to
 * choose an endpoint.
 */
export function validateSearxngBaseUrl(raw: string): BaseUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'REFUSED', detail: `SEARXNG_URL is not a URL: "${raw}".` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      kind: 'REFUSED',
      detail: `SEARXNG_URL must be http or https; "${url.protocol}" is neither.`,
    };
  }
  if (url.username !== '' || url.password !== '') {
    return { kind: 'REFUSED', detail: 'SEARXNG_URL carries embedded credentials.' };
  }
  if (url.hostname === '') {
    return { kind: 'REFUSED', detail: 'SEARXNG_URL has no host.' };
  }
  if (url.search !== '' || url.hash !== '') {
    return {
      kind: 'REFUSED',
      detail:
        'SEARXNG_URL carries a query or a fragment. The base URL names an instance; the ' +
        'connector names the endpoint and the parameters.',
    };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return {
      kind: 'REFUSED',
      detail:
        `SEARXNG_URL carries the path "${url.pathname}". The base URL names an instance, and a ` +
        `path in configuration would let a configuration value choose which endpoint is called.`,
    };
  }

  return {
    kind: 'OK',
    base: { value: `${url.protocol}//${url.host}`, host: url.host },
  };
}

/** One bounded request's outcome, as facts rather than judgements. */
export type SearxngTransportResult =
  | { readonly kind: 'RESPONSE'; readonly status: number; readonly body: string }
  | {
      readonly kind: 'FAILURE';
      /** A syscall code, `ETIMEDOUT`, `ELIMIT` or `EPOLICY`. The adapter maps it to a signal. */
      readonly code: string;
      readonly detail: string;
    };

/** The seam, so the adapter is testable without a socket. */
export interface SearxngTransport {
  send(input: { readonly url: string; readonly timeoutMs: number }): Promise<SearxngTransportResult>;
}

/**
 * One request to one configured host, over http or https.
 *
 * No redirect is followed. SearXNG does not redirect its JSON endpoints, and a transport that
 * followed one could be walked off the configured host by a misconfigured instance — which is
 * the only way the narrow rule at the top of this file could be defeated.
 */
export class NodeSearxngTransport implements SearxngTransport {
  async send(input: {
    readonly url: string;
    readonly timeoutMs: number;
  }): Promise<SearxngTransportResult> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { kind: 'FAILURE', code: 'EPOLICY', detail: 'Malformed URL.' };
    }

    const agent = url.protocol === 'https:' ? https : http;

    return new Promise<SearxngTransportResult>((resolve) => {
      let settled = false;
      const finish = (result: SearxngTransportResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        request.destroy();
        resolve(result);
      };

      const request = agent.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            host: url.host,
            accept: 'application/json',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              finish({
                kind: 'FAILURE',
                code: 'ELIMIT',
                detail:
                  `The response exceeded the ${String(MAX_RESPONSE_BYTES)}-byte budget and was ` +
                  `abandoned mid-stream.`,
              });
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            finish({
              kind: 'RESPONSE',
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          response.on('error', (error: NodeJS.ErrnoException) => {
            finish({ kind: 'FAILURE', code: error.code ?? 'ECONNRESET', detail: error.message });
          });
        },
      );

      const timer = setTimeout(() => {
        finish({
          kind: 'FAILURE',
          code: 'ETIMEDOUT',
          detail: `No complete response within ${String(input.timeoutMs)}ms.`,
        });
      }, input.timeoutMs);

      request.on('error', (error: NodeJS.ErrnoException) => {
        finish({ kind: 'FAILURE', code: error.code ?? 'ECONNRESET', detail: error.message });
      });

      request.end();
    });
  }
}

/** One result entry as SearXNG serialises it. Every field optional — see `parseSearxngResponse`. */
export interface SearxngResult {
  readonly url: string | null;
  readonly title: string | null;
  readonly content: string | null;
  /** The engine SearXNG attributes the merged result to. */
  readonly engine: string | null;
  /** Every engine that returned this URL. SearXNG merges duplicates and keeps the list. */
  readonly engines: readonly string[];
  readonly publishedDate: string | null;
  readonly score: number | null;
  readonly category: string | null;
}

export interface SearxngResponse {
  readonly query: string;
  readonly results: readonly SearxngResult[];
  /** `[engineName, reason]` pairs. SearXNG's own account of which engines did not answer. */
  readonly unresponsiveEngines: readonly { readonly engine: string; readonly reason: string }[];
}

export type SearxngParse =
  | { readonly kind: 'OK'; readonly response: SearxngResponse }
  | { readonly kind: 'UNPARSABLE'; readonly detail: string }
  | { readonly kind: 'UNRECOGNISED'; readonly detail: string };

/**
 * Parse a SearXNG JSON search response.
 *
 * Three outcomes, kept apart for the reason `parseGdelt` gives and which applies with more force
 * here: a metasearch instance that stops returning a `results` array would otherwise read as
 * "this person is not in the news" for every subject searched afterwards, silently, while the
 * service kept reporting clean results. A missing `results` array is `UNRECOGNISED`; an empty
 * one is a genuine empty answer and the only one of the three that is not a gap.
 *
 * Every field on a result is read defensively and independently. SearXNG merges results from
 * engines whose responses have different shapes, so `publishedDate` is present for one engine
 * and null for the next in the same array, and a parser that required a field would drop the
 * engines that do not send it. A field that is absent stays null; none is ever synthesised.
 */
export function parseSearxngResponse(text: string): SearxngParse {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      kind: 'UNPARSABLE',
      detail:
        `The response is not JSON: ${error instanceof Error ? error.message : 'unknown error'}. ` +
        `A SearXNG instance serving its HTML UI instead of JSON parses as neither, which is ` +
        `what a search.formats misconfiguration looks like from here.`,
    };
  }

  const root = asRecord(document);
  if (root === null) {
    return { kind: 'UNRECOGNISED', detail: 'The response is JSON but not an object.' };
  }

  const results = root['results'];
  if (!Array.isArray(results)) {
    return {
      kind: 'UNRECOGNISED',
      detail:
        `The response is JSON and has no "results" array — its keys are ` +
        `[${Object.keys(root).join(', ')}]. Reported as unrecognised rather than as zero ` +
        `results: a shape change that reads as "no news" is invisible, and it would read that ` +
        `way for every subject searched afterwards.`,
    };
  }

  return {
    kind: 'OK',
    response: {
      query: stringOrNull(root['query']) ?? '',
      results: (results as readonly unknown[]).map((entry): SearxngResult => {
        const result = asRecord(entry) ?? {};
        return {
          url: stringOrNull(result['url']),
          title: stringOrNull(result['title']),
          // SearXNG calls the snippet `content`. Taken exactly as given, or null. Never
          // synthesised from the title: a snippet is what the relevance filter scores, and an
          // invented one would be scored as though the publisher had written it.
          content: stringOrNull(result['content']),
          engine: stringOrNull(result['engine']),
          engines: stringArray(result['engines']),
          publishedDate: stringOrNull(result['publishedDate']),
          score: typeof result['score'] === 'number' ? result['score'] : null,
          category: stringOrNull(result['category']),
        };
      }),
      unresponsiveEngines: unresponsiveFrom(root['unresponsive_engines']),
    },
  };
}

/**
 * SearXNG's own account of which engines failed, and why.
 *
 * Serialised as an array of `[engineName, reason]` pairs. Read rather than ignored because it is
 * the only place the instance says "google news: Suspended: CAPTCHA" — which is the difference
 * between an engine that found nothing and an engine that was never asked. A malformed entry is
 * skipped rather than guessed at.
 */
function unresponsiveFrom(
  value: unknown,
): readonly { readonly engine: string; readonly reason: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: { engine: string; reason: string }[] = [];
  for (const raw of value as readonly unknown[]) {
    if (!Array.isArray(raw)) {
      continue;
    }
    const pair = raw as readonly unknown[];
    const engine = stringOrNull(pair[0]);
    if (engine === null) {
      continue;
    }
    entries.push({ engine, reason: stringOrNull(pair[1]) ?? 'no reason given' });
  }
  return entries;
}

export interface SearxngSearchParams {
  readonly q: string;
  /**
   * The engines to ask, by the instance's own names. Required and non-empty.
   *
   * # Why this and NOT `categories=news`
   *
   * The milestone brief specifies `categories=news`. The audit found that SearXNG treats
   * `engines` and `categories` as a **union** rather than as a filter: a request naming one
   * engine and the news category runs every engine in the news category, including the ones our
   * governance table refuses. Sending `categories=news` would therefore have made the engine
   * allowlist decorative — the parameter that was supposed to bound the request would have
   * widened it.
   *
   * So the connector names engines and never names a category. Everything in the allowlist is a
   * news-category engine, so the results come back `category: "news"` regardless, and the
   * adapter checks that rather than asking for it. The evidence is in
   * `docs/sources/evidence/searxng-adverse-media.json`, third and fourth requests.
   */
  readonly engines: readonly string[];
  readonly language: string | null;
  readonly pageno: number;
  /** SearXNG's `time_range`: `day`, `week`, `month` or `year`. Omitted when null. */
  readonly timeRange: 'day' | 'week' | 'month' | 'year' | null;
}

/**
 * The client. Holds one validated base URL and will not address anything else.
 */
export class SearxngClient {
  constructor(
    private readonly base: SearxngBaseUrl,
    private readonly transport: SearxngTransport = new NodeSearxngTransport(),
  ) {}

  get baseUrl(): string {
    return this.base.value;
  }

  /** The URL a set of parameters produces. Exported behaviour, so a test can assert the shape. */
  searchUrl(params: SearxngSearchParams): string {
    const url = new URL(`${this.base.value}${SEARCH_PATH}`);
    url.searchParams.set('q', params.q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('engines', params.engines.join(','));
    url.searchParams.set('pageno', String(params.pageno));
    if (params.language !== null) {
      url.searchParams.set('language', params.language);
    }
    if (params.timeRange !== null) {
      url.searchParams.set('time_range', params.timeRange);
    }
    return url.toString();
  }

  /**
   * One bounded search.
   *
   * Returns the transport's facts unchanged on failure. A non-200 is reported as a status rather
   * than interpreted: whether a 429 from our own instance means anything is the adapter's
   * question, and it has the FR-06 table to answer it with.
   */
  async search(
    params: SearxngSearchParams,
    timeoutMs: number,
  ): Promise<SearxngTransportResult> {
    const url = this.searchUrl(params);
    const refusal = this.assertUnderBase(url);
    if (refusal !== null) {
      return { kind: 'FAILURE', code: 'EPOLICY', detail: refusal };
    }
    return this.transport.send({ url, timeoutMs });
  }

  /** `GET /config` — what the instance actually has enabled. Read, never assumed. */
  async config(timeoutMs: number): Promise<SearxngTransportResult> {
    const url = `${this.base.value}${CONFIG_PATH}`;
    const refusal = this.assertUnderBase(url);
    if (refusal !== null) {
      return { kind: 'FAILURE', code: 'EPOLICY', detail: refusal };
    }
    return this.transport.send({ url, timeoutMs });
  }

  /**
   * The last check before a socket opens: is this still the configured instance?
   *
   * Redundant by construction — every URL above is assembled from `this.base` — and kept
   * precisely because it is redundant. The guarantee this file claims is "no request leaves for
   * any host but the configured one", and a guarantee that rests on every future edit to
   * `searchUrl` being careful is not one. This is the assertion that makes it structural.
   */
  private assertUnderBase(candidate: string): string | null {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return 'The assembled URL does not parse.';
    }
    if (`${url.protocol}//${url.host}` !== this.base.value) {
      return (
        `Refusing to request ${url.protocol}//${url.host}: this client addresses only the ` +
        `configured SearXNG instance at ${this.base.value}.`
      );
    }
    if (url.pathname !== SEARCH_PATH && url.pathname !== CONFIG_PATH) {
      return `Refusing to request the path "${url.pathname}": only ${SEARCH_PATH} and ${CONFIG_PATH} are addressed.`;
    }
    return null;
  }
}

/**
 * The engine names a `/config` body reports as enabled.
 *
 * Read so that a coverage statement can say an engine was asked for and the instance does not
 * have it, rather than reporting the engine as failed. An unparsable body returns null, which
 * the caller reports as "could not be read" rather than as an empty engine list — an empty list
 * would read as "the instance has no engines", which is a different and much stronger claim.
 */
export function parseEnabledEngineNames(text: string): readonly string[] | null {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = asRecord(document);
  const engines = root?.['engines'];
  if (!Array.isArray(engines)) {
    return null;
  }
  const names: string[] = [];
  for (const entry of engines as readonly unknown[]) {
    const record = asRecord(entry);
    const name = stringOrNull(record?.['name']);
    if (name !== null && record?.['enabled'] === true) {
      names.push(name);
    }
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
}
