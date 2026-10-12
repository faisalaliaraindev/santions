/**
 * `@adverse-search/client` — the typed client an integrating application uses.
 *
 * Written for Target Platform and for anything else that calls this service machine-to-machine. It
 * lives in this repository rather than theirs because Target Platform-side workspace access has not
 * been granted (gate G9 says so explicitly); when it is, this package moves or is published,
 * and nothing about the contract changes.
 *
 * # Why a hand-written client and not only the generated one
 *
 * The OpenAPI document generates a *transport*: paths, methods, shapes. What it cannot generate
 * is the part integrators get wrong, and every method here exists to make one of those hard to
 * do:
 *
 * - **`createSearch` returns 202, not a result.** The run is queued. A client that treats the
 *   response as an answer reports "no findings" for a search that has not started, which is the
 *   single most damaging mistake available here. `waitForSearch` is provided so the correct
 *   thing is also the easy thing.
 * - **`getFindings` returns coverage with the findings, always.** There is no method that
 *   returns findings alone, because a caller holding an empty array and no coverage cannot tell
 *   a genuinely clean run from one in which every source was blocked.
 * - **Errors carry the service's own error code**, so a caller can distinguish "this tenant is
 *   not entitled" from "this search does not exist" without parsing prose.
 *
 * # What the caller is responsible for
 *
 * Supplying an `Idempotency-Key` on `createSearch` when a duplicate submission would matter —
 * the client will generate one if none is given, which protects a retry loop but not a
 * re-submission after a process restart. The caller knows which it is; the client does not.
 */

import type {
  AssociationGraph,
  CreateSearchInput,
  CreateSubjectInput,
  FindingsPage,
  SearchSummary,
  SubjectVersion,
} from '@adverse-search/contracts';

/** The error codes a caller is most likely to branch on. Not exhaustive — see `code`. */
export type AdverseErrorCode = string;

/**
 * A failure the service described.
 *
 * Carries the service's `code` and `correlationId`. The correlation id is the thing to quote in
 * a support conversation: it ties a caller's failure to this service's own logs and audit trail.
 */
export class AdverseSearchError extends Error {
  constructor(
    readonly status: number,
    readonly code: AdverseErrorCode,
    message: string,
    readonly correlationId: string | null,
    readonly details: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'AdverseSearchError';
  }

  /** True when retrying the identical request could succeed. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export interface AdverseSearchClientOptions {
  /** Base URL of the service, e.g. `https://adverse.example.com`. No trailing slash needed. */
  readonly baseUrl: string;
  /** The machine API key. Scoped to one tenant and one environment. */
  readonly apiKey: string;
  /** Injected for tests and for callers with their own instrumented fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface WaitOptions {
  /** Give up after this long. The search keeps running; only the waiting stops. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Called on each poll, for a progress indicator. */
  readonly onPoll?: (summary: SearchSummary) => void;
}

/** Execution states that mean the run is over, one way or another. */
const TERMINAL: ReadonlySet<string> = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);

export class AdverseSearchClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AdverseSearchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Record a subject. A name is enough; anything more improves identity resolution. */
  async createSubject(input: CreateSubjectInput): Promise<SubjectVersion> {
    return this.send('POST', '/v1/subjects', { body: input });
  }

  /**
   * Submit a search. Returns **202 Accepted** — the run is queued, not finished.
   *
   * Pass `idempotencyKey` whenever a duplicate submission would matter. Without one, a retry
   * after a timeout creates a second run: the service cannot tell a retry from a fresh request
   * unless the caller says so.
   */
  async createSearch(
    input: CreateSearchInput,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<{ searchId: string; statusUrl: string; execution: string }> {
    return this.send('POST', '/v1/searches', {
      body: input,
      headers: {
        'idempotency-key': options.idempotencyKey ?? cryptoRandom(),
      },
    });
  }

  async getSearch(searchId: string): Promise<SearchSummary> {
    return this.send('GET', `/v1/searches/${encodeURIComponent(searchId)}`);
  }

  /**
   * The findings **and** the coverage they sit inside.
   *
   * There is deliberately no method that returns findings alone. An empty `findings` array is
   * not a result until you have read `coverage` and `noMatchStatement` beside it.
   */
  async getFindings(searchId: string): Promise<FindingsPage> {
    return this.send('GET', `/v1/searches/${encodeURIComponent(searchId)}/findings`);
  }

  /** The frozen FR-02 association graph for a run. */
  async getAssociations(searchId: string): Promise<AssociationGraph> {
    return this.send('GET', `/v1/searches/${encodeURIComponent(searchId)}/associations`);
  }

  /**
   * Poll until the run reaches a terminal state.
   *
   * Provided so that the correct way to consume an asynchronous search is also the easy one. It
   * **throws on timeout rather than returning the last summary**, because a caller that receives
   * a `QUEUED` summary from a function called `waitForSearch` will treat it as a result — and a
   * `QUEUED` run has `findings: NOT_EVALUATED`, which reads as "nothing found" to anybody not
   * looking carefully.
   */
  async waitForSearch(searchId: string, options: WaitOptions = {}): Promise<SearchSummary> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const summary = await this.getSearch(searchId);
      options.onPoll?.(summary);
      if (TERMINAL.has(summary.execution)) {
        return summary;
      }
      if (Date.now() >= deadline) {
        throw new AdverseSearchError(
          408,
          'CLIENT_WAIT_TIMEOUT',
          `Search ${searchId} was still ${summary.execution} after ${String(timeoutMs)}ms. ` +
            `The run has not stopped — only the waiting has. Poll again with getSearch.`,
          null,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  private async send<T>(
    method: string,
    path: string,
    options: {
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `ApiKey ${this.options.apiKey}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });

      const text = await response.text();
      const payload: unknown = text === '' ? null : JSON.parse(text);

      if (!response.ok) {
        throw toError(response.status, payload);
      }
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ApiErrorShape {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly correlationId?: unknown;
  readonly details?: unknown;
}

function toError(status: number, payload: unknown): AdverseSearchError {
  const body: ApiErrorShape = typeof payload === 'object' && payload !== null ? payload : {};
  const details = Array.isArray(body.details)
    ? body.details.filter(
        (d): d is { path: string; message: string } =>
          typeof d === 'object' && d !== null && 'path' in d && 'message' in d,
      )
    : [];

  return new AdverseSearchError(
    status,
    typeof body.code === 'string' ? body.code : 'UNKNOWN',
    typeof body.message === 'string' ? body.message : `Request failed with ${String(status)}.`,
    typeof body.correlationId === 'string' ? body.correlationId : null,
    details,
  );
}

/** An idempotency key when the caller did not supply one. Protects a retry loop, not a restart. */
function cryptoRandom(): string {
  return `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
