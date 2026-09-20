import type { EvidenceFetchPort } from '../evidence-fetch.port.js';
import type { FetchGateService } from '../fetch-gate.service.js';
import { hasData } from '../source-adapter.js';
import type {
  ScheduledArtifactResponse,
  ScheduledArtifactTransport,
} from './indexed-source.types.js';

const ARTIFACT_FETCH_BUDGET = {
  maxBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 60_000,
} as const;

/** Uses the existing hardened HTTP fetch path after the scheduler-specific gate has authorised it. */
export class ScheduledArtifactTransportAdapter implements ScheduledArtifactTransport {
  constructor(
    private readonly gate: FetchGateService,
    private readonly fetcher: EvidenceFetchPort,
    private readonly clock: () => Date = (): Date => new Date(),
    private readonly credentialHeaders: (
      sourceId: string,
    ) => Readonly<Record<string, string>> = () => ({}),
  ) {}

  async fetch(input: {
    readonly sourceId: string;
    readonly url: string;
    readonly etag: string | null;
    readonly lastModified: string | null;
  }): Promise<ScheduledArtifactResponse> {
    const now = this.clock();
    const decision = await this.gate.authoriseScheduledArtifact({
      sourceId: input.sourceId,
      url: input.url,
      now,
    });
    if (!decision.authorised) {
      throw new Error(`${decision.refusal}: ${decision.detail}`);
    }
    const outcome = await this.fetcher.fetch({
      url: input.url,
      attribution: {
        tenantId: 'platform:source-refresh',
        jobId: `refresh:${input.sourceId}:${now.toISOString()}`,
        subjectId: 'platform:source-refresh',
        queryId: 'scheduled-artifact',
        sourceId: input.sourceId,
        egressIdentityId: decision.egressIdentity.identityId,
      },
      authorisation: decision.authorisation,
      budget: ARTIFACT_FETCH_BUDGET,
      conditional: { etag: input.etag, lastModified: input.lastModified },
      requestHeaders: this.credentialHeaders(input.sourceId),
      fetchKey: `source-refresh:${input.sourceId}:${input.etag ?? input.lastModified ?? 'initial'}`,
      allowRender: false,
    });
    if (!hasData(outcome)) {
      throw new Error(
        outcome.status === 'FAILED'
          ? `${outcome.policy.failureClass}: ${outcome.detail}`
          : `Scheduled artifact fetch returned ${outcome.status}.`,
      );
    }
    return {
      status: outcome.data.httpStatus,
      contentType: outcome.data.contentType,
      etag: header(outcome.data.headers, 'etag'),
      lastModified: header(outcome.data.headers, 'last-modified'),
      body: outcome.data.body,
    };
  }
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}
