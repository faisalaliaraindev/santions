/**
 * Section 4.2 — token validation.
 *
 * Validates signature, issuer, audience, expiry and allowed algorithms, with JWKS caching and
 * key rotation handled by `jose`'s remote key set.
 *
 * Two things this deliberately does **not** do:
 *
 *  - It does not accept a tenant from anywhere but a validated claim. A client-supplied
 *    `X-Tenant-Id` header is not an input here and never becomes one (SEC-01, test T05).
 *  - It does not accept `alg: none`, or any algorithm outside the allowlist. An attacker who
 *    can choose the algorithm can often choose the key.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

import { isRole, type Principal, type Role } from '@adverse-search/domain';

/**
 * Asymmetric algorithms only. HMAC is excluded on purpose: with a symmetric algorithm the
 * verification key is also a signing key, so anything able to verify a token can mint one.
 */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'];

export type TokenRejection =
  | 'MISSING'
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'WRONG_ISSUER'
  | 'WRONG_AUDIENCE'
  | 'EXPIRED'
  | 'DISALLOWED_ALGORITHM'
  | 'NO_TENANT_CLAIM'
  | 'NO_ROLES';

export class TokenVerificationError extends Error {
  readonly rejection: TokenRejection;

  constructor(rejection: TokenRejection, message: string) {
    super(message);
    this.name = 'TokenVerificationError';
    this.rejection = rejection;
  }
}

export interface TokenVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Injected in tests. Production builds one from the issuer's JWKS endpoint. */
  readonly keyResolver?: JWTVerifyGetKey;
}

interface AdverseSearchClaims extends JWTPayload {
  readonly tenant_id?: string | string[];
  readonly realm_access?: { readonly roles?: readonly string[] };
  readonly scope?: string;
  readonly environment?: string;
  readonly azp?: string;
}

export class TokenVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly getKey: JWTVerifyGetKey;

  constructor(options: TokenVerifierOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.getKey =
      options.keyResolver ??
      // jose caches the key set and refetches on an unknown `kid`, which is how rotation is
      // handled without a restart or an unbounded refetch loop.
      createRemoteJWKSet(new URL(`${options.issuer}/protocol/openid-connect/certs`), {
        cacheMaxAge: 600_000,
        cooldownDuration: 30_000,
      });
  }

  /**
   * Verify a bearer token and derive the principal.
   *
   * Every rejection is typed, so the API can distinguish an expired session (recoverable by
   * re-authenticating) from a forged token (a security event) without leaking which is which
   * to the caller.
   */
  async verify(token: string | undefined, kind: 'HUMAN' | 'MACHINE'): Promise<Principal> {
    if (token === undefined || token.trim() === '') {
      throw new TokenVerificationError('MISSING', 'No bearer token was presented.');
    }

    let payload: AdverseSearchClaims;
    try {
      const result = await jwtVerify(token, this.getKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: 5,
      });
      payload = result.payload;
    } catch (error) {
      throw new TokenVerificationError(classifyJoseError(error), describeJoseError(error));
    }

    // Roles come from the provider, not from the request.
    const rawRoles = payload.realm_access?.roles ?? [];
    const roles: Role[] = rawRoles.filter((r): r is Role => isRole(r));

    // A token with no recognised role authorises nothing. Failing here rather than producing
    // an empty-role principal keeps "authenticated" and "authorised" clearly separate.
    if (roles.length === 0) {
      throw new TokenVerificationError(
        'NO_ROLES',
        'Token carries no role this service recognises.',
      );
    }

    const tenantId = normaliseTenantClaim(payload.tenant_id);

    // Every role except the platform ones is tenant-scoped. A tenant-scoped principal without
    // a tenant claim fails closed rather than defaulting to anything.
    const isPlatformOnly = roles.every((r) => r === 'platform_operator' || r === 'platform_admin');
    if (tenantId === null && !isPlatformOnly) {
      throw new TokenVerificationError(
        'NO_TENANT_CLAIM',
        'Token carries no tenant_id claim, and the roles it carries are tenant-scoped.',
      );
    }

    const environment = payload.environment === 'live' ? 'live' : 'sandbox';

    return {
      subject: payload.sub ?? '',
      kind,
      tenantId,
      roles,
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      environment,
      // Break-glass is never carried in a token. It is a persisted, audited grant looked up
      // per request, so it can be revoked without waiting for a token to expire.
      breakGlass: null,
    };
  }
}

/**
 * Keycloak emits a single-valued user attribute as an array, so both forms are accepted.
 *
 * `Array.isArray` widens a readonly array to `any[]`, which would quietly let a non-string
 * element through, so the element type is checked explicitly rather than assumed.
 */
function normaliseTenantClaim(claim: string | readonly string[] | undefined): string | null {
  if (typeof claim === 'string') {
    return claim.trim() === '' ? null : claim;
  }
  if (claim === undefined) {
    return null;
  }
  for (const candidate of claim) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return null;
}

function readStringProperty(error: unknown, key: string): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function classifyJoseError(error: unknown): TokenRejection {
  const code = readStringProperty(error, 'code');
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return 'EXPIRED';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = readStringProperty(error, 'claim');
      if (claim === 'iss') {
        return 'WRONG_ISSUER';
      }
      if (claim === 'aud') {
        return 'WRONG_AUDIENCE';
      }
      return 'MALFORMED';
    }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'BAD_SIGNATURE';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'DISALLOWED_ALGORITHM';
    default:
      return 'MALFORMED';
  }
}

/**
 * Internal diagnostic text. It is logged, never returned to the caller: telling an
 * unauthenticated client exactly why its token failed helps it forge a better one.
 */
function describeJoseError(error: unknown): string {
  return error instanceof Error ? error.message : 'Token verification failed.';
}
