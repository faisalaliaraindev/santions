import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../lib/api/client.ts';

/**
 * Retry policy.
 *
 * Deliberately conservative: a screening panel that silently retries a 403 or a 409 hides
 * the two errors an operator most needs to see — an entitlement denial and a revision
 * conflict. Only genuinely retryable server-side failures are retried, and the service tells
 * us which those are through the `retryable` flag on its error body (section 6.1).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            return error.retryable && failureCount < 3;
          }
          // A network-level failure, not an application error.
          return failureCount < 2;
        },
        staleTime: 30_000,
        // A frozen report does not change under the reader. Refetching it on focus produces
        // flicker and no new information.
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Review actions carry an idempotency key and an expected revision (FR-12).
        // Retrying them automatically is the caller's decision, never the default.
        retry: false,
      },
    },
  });
}
