/**
 * The local Google diagnostic — one search, on one developer machine, for one named tenant.
 *
 * # What this is, and what it is not
 *
 * `GOOGLE_NEWS` is `REFUSED` under D20 and defaults OFF. Neither changes here, and nothing in this
 * file writes either. What this allows is a **request-scoped** exception: a single LIVE search,
 * made against a local process, by the one tenant named in the environment, carrying an explicit
 * header, may run Google as one of its engines so a developer can watch the real tenant path
 * (discovery → publisher authorisation → fetch → extraction → classification) handle Google's
 * candidates. It is a diagnostic of our pipeline, not an activation of Google.
 *
 * # Every condition is required, and none has a default that satisfies it
 *
 * 1. the runtime is not production (and production refuses to start with the flag set at all);
 * 2. the request was made to and from loopback — a local development process;
 * 3. `ALLOW_LOCAL_GOOGLE_DIAGNOSTIC=true`;
 * 4. the authenticated tenant is exactly `GOOGLE_DIAGNOSTIC_TENANT_ID`;
 * 5. the request carries `X-Local-Discovery-Diagnostic: GOOGLE_NEWS`.
 *
 * A request carrying the header that fails any other condition is **refused**, not quietly run
 * without Google: a developer who asked for Google and got a normal search back would read the
 * absence of Google as a Google result.
 *
 * # Nothing is persisted as configuration
 *
 * No engine setting is written. `searxngEngineSettings`, `governanceStatus`,
 * `defaultEnabledForDiscovery` and `tenantEnabled` are untouched, so the control API reads exactly
 * what it read before the request. The search run records that *it* was a diagnostic run — the
 * worker has to be told, and an audit of the run must be able to say why Google appears in it —
 * and the worker re-checks conditions 1, 3 and 4 against its own environment before honouring it.
 * A run record replayed into a process without the flag runs without Google.
 */

import type { ResolvedEngine } from './engine-enablement.service.js';
import type { DiscoveryEngine } from './engine-governance.js';

/** The request header, lower-cased as Node presents it. */
export const LOCAL_DIAGNOSTIC_HEADER = 'x-local-discovery-diagnostic';

/** The only engine this diagnostic can switch on. A closed list of one. */
export const LOCAL_DIAGNOSTIC_ENGINES: readonly DiscoveryEngine[] = ['GOOGLE_NEWS'];

/** The process-level half of the conditions: what the environment allows. */
export interface LocalDiagnosticPolicy {
  readonly isProduction: boolean;
  readonly allowLocalGoogleDiagnostic: boolean;
  /** Null when unset, which permits nobody. */
  readonly googleDiagnosticTenantId: string | null;
}

/** What one request presented. */
export interface LocalDiagnosticRequest {
  readonly tenantId: string;
  /** The raw header value, or undefined when absent. */
  readonly header: string | readonly string[] | undefined;
  /** The `Host` header's hostname the request was addressed to. */
  readonly hostname: string | undefined;
  /** The socket's remote address. */
  readonly remoteAddress: string | undefined;
}

export type LocalDiagnosticDecision =
  | { readonly kind: 'NOT_REQUESTED' }
  | { readonly kind: 'GRANTED'; readonly engines: readonly DiscoveryEngine[] }
  | { readonly kind: 'REFUSED'; readonly reason: string };

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True for an IPv4, IPv6 or IPv4-mapped loopback address. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const bare = address.replace(/^::ffff:/i, '');
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (hostname === undefined) {
    return false;
  }
  const lowered = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTNAMES.has(lowered) || isLoopbackAddress(lowered);
}

/**
 * The process-level check the worker repeats before honouring a stored diagnostic marker.
 *
 * Conditions 1, 3 and 4. The request-level ones (loopback, header) were decided by the API when
 * the run was accepted and cannot be re-observed by a worker.
 */
export function processPermitsLocalDiagnostic(
  policy: LocalDiagnosticPolicy,
  tenantId: string,
): boolean {
  return (
    !policy.isProduction &&
    policy.allowLocalGoogleDiagnostic &&
    policy.googleDiagnosticTenantId !== null &&
    policy.googleDiagnosticTenantId === tenantId
  );
}

/** Decide one request. Pure: every input is passed in. */
export function decideLocalDiagnostic(
  policy: LocalDiagnosticPolicy,
  request: LocalDiagnosticRequest,
): LocalDiagnosticDecision {
  if (request.header === undefined) {
    return { kind: 'NOT_REQUESTED' };
  }

  const refuse = (reason: string): LocalDiagnosticDecision => ({ kind: 'REFUSED', reason });

  // An array means the header was sent more than once, which is ambiguous — refused, not merged.
  if (typeof request.header !== 'string' || request.header.trim() !== 'GOOGLE_NEWS') {
    return refuse('the header value is not exactly GOOGLE_NEWS');
  }
  if (policy.isProduction) {
    return refuse('the runtime is production');
  }
  if (!isLoopbackHostname(request.hostname) || !isLoopbackAddress(request.remoteAddress)) {
    return refuse('the request was not made to and from a local development process');
  }
  if (!policy.allowLocalGoogleDiagnostic) {
    return refuse('ALLOW_LOCAL_GOOGLE_DIAGNOSTIC is not true in this process');
  }
  if (!processPermitsLocalDiagnostic(policy, request.tenantId)) {
    return refuse('the authenticated tenant is not GOOGLE_DIAGNOSTIC_TENANT_ID');
  }
  return { kind: 'GRANTED', engines: LOCAL_DIAGNOSTIC_ENGINES };
}

/** A resolved engine as one diagnostic run sees it. */
export interface DiagnosticResolvedEngine extends ResolvedEngine {
  /** True only for an engine this run executes because of the local diagnostic. */
  readonly diagnosticOverride: boolean;
}

/**
 * Apply a granted diagnostic to one run's resolved engines, **in memory only**.
 *
 * Returns new objects; the input is not modified and nothing is written anywhere. Only engines in
 * `LOCAL_DIAGNOSTIC_ENGINES` can be affected, whatever the caller passes. `governanceStatus`,
 * `defaultEnabledForDiscovery` and `tenantEnabled` are carried through unchanged — the report
 * must still say REFUSED beside the diagnostic result.
 */
export function applyLocalDiagnostic(
  engines: readonly ResolvedEngine[],
  requested: readonly string[],
): readonly DiagnosticResolvedEngine[] {
  const overridden = new Set(
    requested.filter((engine): engine is DiscoveryEngine =>
      LOCAL_DIAGNOSTIC_ENGINES.includes(engine as DiscoveryEngine),
    ),
  );
  return engines.map((engine) =>
    overridden.has(engine.engine) && engine.integrated && !engine.effectiveEnabled
      ? { ...engine, effectiveEnabled: true, diagnosticOverride: true }
      : { ...engine, diagnosticOverride: false },
  );
}
