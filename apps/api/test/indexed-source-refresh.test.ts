import { describe, expect, it, vi } from 'vitest';

import { IndexedSourceRefreshService } from '../src/sources/indexed/indexed-source-refresh.service.js';
import type { IndexedSourceRefreshState } from '../src/sources/indexed/indexed-source.types.js';

interface ArtifactResponse {
  status: number;
  body: Uint8Array | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}

const NOW = new Date('2026-09-18T12:00:00.000Z');
const state = (overrides: Partial<IndexedSourceRefreshState> = {}): IndexedSourceRefreshState => ({
  sourceId: 'ofac-sdn',
  activeSourceVersion: 1,
  lastAttemptAt: NOW,
  lastSuccessfulRefreshAt: NOW,
  refreshStatus: 'SUCCEEDED',
  httpStatus: 200,
  artifactHash: 'old',
  etag: 'old-etag',
  lastModified: null,
  parserVersion: 'parser-1',
  rowCount: 10,
  insertedCount: 10,
  updatedCount: 0,
  removedCount: 0,
  activeSnapshotVersion: 'old-snapshot',
  failureReason: null,
  freshness: 'CURRENT',
  nextRefreshDueAt: NOW,
  refreshLease: null,
  ...overrides,
});

function harness(response: { status: number; body: Uint8Array | null; contentType?: string | null }) {
  let current = state();
  const repository = {
    state: vi.fn((): Promise<IndexedSourceRefreshState> => Promise.resolve(current)),
    claimRefresh: vi.fn(() =>
      Promise.resolve({ claimed: true, refreshId: 'refresh-1', previous: current }),
    ),
    recordNotModified: vi.fn((): Promise<void> => {
      current = state({ refreshStatus: 'NOT_MODIFIED' });
      return Promise.resolve();
    }),
    recordFailure: vi.fn((input: { reason: string }): Promise<void> => {
      current = state({ refreshStatus: 'FAILED', failureReason: input.reason });
      return Promise.resolve();
    }),
    commitSnapshot: vi.fn((): Promise<void> => {
      current = state({ refreshStatus: 'SUCCEEDED', activeSnapshotVersion: 'new-snapshot' });
      return Promise.resolve();
    }),
  };
  const transport = {
    fetch: vi.fn((): Promise<ArtifactResponse> =>
      Promise.resolve({
        status: response.status,
        body: response.body,
        contentType: response.contentType ?? 'application/xml',
        etag: 'new-etag',
        lastModified: null,
      }),
    ),
  };
  const parser = {
    parserId: 'parser',
    parserVersion: 'parser-1',
    parse: vi.fn(() => ({ records: [], publisherVersion: null })),
  };
  const versions = {
    loadActive: vi.fn(() =>
      Promise.resolve({
        version: 1,
        endpointUrl: 'https://example.test/ofac.xml',
      }),
    ),
  };
  const service = new IndexedSourceRefreshService(
    repository as never,
    versions as never,
    transport,
    new Map([
      [
        'ofac-sdn',
        {
          sourceId: 'ofac-sdn',
          artifactUrl: 'https://example.test/ofac.xml',
          parser,
          refreshIntervalMs: 86_400_000,
          staleAfterMs: 172_800_000,
          minimumExpectedRows: 1,
          acceptedContentTypes: ['application/xml'],
        },
      ],
    ]),
    () => NOW,
  );
  return { service, repository, transport, parser };
}

describe('indexed source refresh lifecycle', () => {
  it('uses conditional validators and keeps the active snapshot on 304', async () => {
    const h = harness({ status: 304, body: null });
    const result = await h.service.refresh('ofac-sdn', true);

    expect(result.kind).toBe('NOT_MODIFIED');
    expect(h.transport.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ etag: 'old-etag', lastModified: null }),
    );
    expect(h.repository.commitSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a zero-row parse and records failure without replacing last-good data', async () => {
    const h = harness({ status: 200, body: new TextEncoder().encode('<empty/>') });
    const result = await h.service.refresh('ofac-sdn', true);

    expect(result.kind).toBe('FAILED');
    expect(h.repository.recordFailure.mock.calls[0]?.[0].reason).toContain(
      'below the reviewed minimum',
    );
    expect(h.repository.commitSnapshot).not.toHaveBeenCalled();
    expect(result.state.activeSnapshotVersion).toBe('old-snapshot');
  });

  it('suppresses concurrent duplicate refreshes in-process', async () => {
    const h = harness({ status: 304, body: null });
    let release: (() => void) | undefined;
    h.transport.fetch.mockImplementation(
      () =>
        new Promise<ArtifactResponse>((resolve) => {
          release = (): void => {
            resolve({
              status: 304,
              body: null,
              contentType: 'application/xml',
              etag: 'old-etag',
              lastModified: null,
            });
          };
        }),
    );

    const first = h.service.refresh('ofac-sdn', true);
    const second = h.service.refresh('ofac-sdn', true);
    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function');
    });
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(h.transport.fetch).toHaveBeenCalledTimes(1);
  });
});
