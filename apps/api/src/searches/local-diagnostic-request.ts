/**
 * The local Google diagnostic, decided for one HTTP request.
 *
 * Shared by `POST /v1/searches` and `POST /v1/screen` so the two entry points cannot drift: the
 * five conditions live in `local-diagnostic.ts`, and this is the one place that reads them off a
 * request and turns a refusal into an error. Decided before anything is written, and refused
 * loudly rather than ignored — a developer who asked for Google and silently got a normal search
 * would read Google's absence as its answer.
 */

import type { Request } from 'express';

import { ApiException } from '../common/api-exception.js';
import type { AppConfig } from '../config/config.js';
import {
  decideLocalDiagnostic,
  LOCAL_DIAGNOSTIC_HEADER,
} from '../sources/searxng/local-diagnostic.js';

/** Granted engines for this request, or `null` for every normal request. Throws on refusal. */
export function diagnosticEnginesFor(
  config: AppConfig,
  input: {
    readonly tenantId: string;
    readonly req: Request;
    readonly environment: 'sandbox' | 'live';
  },
): readonly string[] | null {
  const { tenantId, req } = input;
  const diagnostic = decideLocalDiagnostic(config.localGoogleDiagnostic, {
    tenantId,
    header: req.headers[LOCAL_DIAGNOSTIC_HEADER],
    // The raw Host header rather than `req.hostname`, which a trusted proxy setting would let
    // X-Forwarded-Host replace. The socket address is likewise the socket's, never `req.ip`.
    hostname: hostnameOf(req.headers.host),
    remoteAddress: req.socket.remoteAddress,
  });
  if (diagnostic.kind === 'REFUSED') {
    throw new ApiException(
      'FORBIDDEN',
      'The local discovery diagnostic is not available for this request.',
      {
        internalDetail: `tenant=${tenantId} localDiagnosticRefused: ${diagnostic.reason}`,
      },
    );
  }
  if (diagnostic.kind === 'GRANTED' && input.environment !== 'live') {
    throw new ApiException(
      'VALIDATION_FAILED',
      'The local discovery diagnostic applies only to a live search.',
      { details: [{ path: 'environment', message: 'must be live' }] },
    );
  }
  return diagnostic.kind === 'GRANTED' ? diagnostic.engines : null;
}

function hostnameOf(host: string | undefined): string | undefined {
  if (host === undefined) {
    return undefined;
  }
  const trimmed = host.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? undefined : trimmed.slice(1, end);
  }
  return trimmed.split(':')[0];
}
