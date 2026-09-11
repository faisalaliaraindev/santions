/**
 * Authentication and authorisation guards.
 *
 * Applied globally, so a new route is protected by default and must **opt out** explicitly
 * with `@Public()`. The reverse — opt in to protection — is how unguarded routes ship: the
 * one someone forgets to decorate is the one that leaks.
 */

import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { decideAccess, type Permission } from '@erly/adverse-domain';

import { ApiException } from '../common/api-exception.js';
import { ApiKeyError, ApiKeyService } from '../tenancy/api-key.service.js';
import { SessionService } from './session.service.js';
import { TokenVerificationError, TokenVerifier } from './token-verifier.js';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_PERMISSION = 'auth:permission';
export const REQUIRED_SCOPE = 'auth:scope';

/** Marks a route as reachable without authentication. Used only by health and the auth flow. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Declares the permission a route needs. Enforced by `PermissionGuard`.
 *
 * More than one may be given, and the route then admits a caller holding **any** of them. That
 * is for routes serving several record kinds behind one path — `/v1/admin/:collection` needs
 * `source:propose` for a source and `taxonomy:propose` for a taxonomy, and declaring only one
 * of them would lock the other kind's administrator out of their own records.
 *
 * The alternatives are a coarse gate, never the whole check: a route declaring several must
 * enforce the exact one in its service, against the record it has actually loaded. With a
 * single permission — which is every other route — this behaves exactly as it always did.
 */
export const RequirePermission = (...permissions: readonly Permission[]): CustomDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permissions);

/** Declares the scope a machine client needs, in addition to its roles. */
export const RequireScope = (scope: string): CustomDecorator => SetMetadata(REQUIRED_SCOPE, scope);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenVerifier) private readonly tokenVerifier: TokenVerifier,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic ?? false) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // Three credential shapes, in a deliberate order.
    //
    // The BFF session cookie is checked first, because that is how humans arrive. Machine
    // credentials — an API key, then a bearer token — are checked after. A request carrying
    // more than one is not special-cased: the first match wins and the rest are ignored rather
    // than merged, so a stolen credential cannot escalate an existing session.
    const sessionId = readSessionCookie(request);
    if (sessionId !== null) {
      const principal = await this.sessions.resolve(sessionId);
      if (principal === null) {
        throw new ApiException('SESSION_EXPIRED', 'The session has expired. Sign in again.');
      }
      request.principal = principal;
      return true;
    }

    const apiKey = readApiKey(request);
    if (apiKey !== undefined) {
      try {
        request.principal = await this.apiKeys.verify(apiKey);
        return true;
      } catch (error) {
        if (error instanceof ApiKeyError) {
          // One opaque answer for every rejection. Telling a caller that the key exists but
          // the secret is wrong halves the work of guessing (test T68).
          throw new ApiException('UNAUTHENTICATED', 'Authentication is required.', {
            internalDetail: `API key ${error.rejection}: ${error.message}`,
          });
        }
        throw error;
      }
    }

    const bearer = readBearerToken(request);
    try {
      request.principal = await this.tokenVerifier.verify(bearer, 'MACHINE');
      return true;
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        // The caller is told only that authentication failed. Which check failed is logged,
        // not returned: a precise rejection reason helps an attacker iterate (test T03).
        throw new ApiException(
          error.rejection === 'EXPIRED' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED',
          'Authentication is required.',
          { internalDetail: `${error.rejection}: ${error.message}` },
        );
      }
      throw error;
    }
  }
}

/**
 * Enforces the declared permission and the resource's tenant, using the single domain
 * decision in `decideAccess`.
 *
 * The tenant a resource belongs to is resolved from the **persisted record** by the route,
 * never from a request header or body (SEC-01, test T05). Routes that operate on a specific
 * resource set `request.resourceTenantId` before this guard's check is meaningful — for
 * collection routes, the caller's own tenant is the scope.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic ?? false) {
      return true;
    }

    const declared = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );

    // A protected route that declares no permission is a bug, not a permissive default.
    if (declared === undefined || declared.length === 0) {
      throw new ApiException('FORBIDDEN', 'Access denied.', {
        internalDetail:
          'Route is authenticated but declares no @RequirePermission. Refusing rather than defaulting to allow.',
      });
    }

    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new ApiException('UNAUTHENTICATED', 'Authentication is required.');
    }

    const requiredScope = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Any one of the declared permissions admits the caller. The last denial is the one
    // reported, so a single-permission route — every route but the admin ones — reports exactly
    // what it always did.
    let decision = decideAccess({
      principal,
      permission: declared[0] as Permission,
      // Collection-scoped routes act within the caller's own tenant. Resource-scoped routes
      // re-check against the stored owner after loading the record.
      resourceTenantId: principal.tenantId,
      ...(requiredScope === undefined ? {} : { requiredScope }),
    });

    for (const permission of declared.slice(1)) {
      if (decision.allowed) {
        break;
      }
      decision = decideAccess({
        principal,
        permission,
        resourceTenantId: principal.tenantId,
        ...(requiredScope === undefined ? {} : { requiredScope }),
      });
    }

    if (!decision.allowed) {
      throw toApiException(decision.reason, decision.detail);
    }
    return true;
  }
}

/** Maps a domain denial to the wire contract, keeping the distinctions REL-02 requires. */
export function toApiException(
  reason:
    | 'NO_TENANT_CONTEXT'
    | 'CROSS_TENANT'
    | 'MISSING_PERMISSION'
    | 'MISSING_SCOPE'
    | 'SANDBOX_CANNOT_ACCESS_LIVE',
  internalDetail: string,
): ApiException {
  switch (reason) {
    case 'SANDBOX_CANNOT_ACCESS_LIVE':
      return new ApiException(
        'SANDBOX_CANNOT_ACCESS_LIVE',
        'A sandbox credential cannot access live searches or evidence.',
        { internalDetail },
      );
    case 'CROSS_TENANT':
      // Reported to the caller as a plain 404-equivalent denial rather than "wrong tenant",
      // which would confirm the resource exists.
      return new ApiException('CROSS_TENANT_DENIED', 'Access denied.', { internalDetail });
    default:
      return new ApiException('FORBIDDEN', 'Access denied.', { internalDetail });
  }
}

function readBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? value : undefined;
}

/**
 * `Authorization: ApiKey erly_live_…`.
 *
 * A distinct scheme rather than reusing `Bearer`, so a key is never fed to the JWT verifier and
 * a token is never fed to the key store. Sharing one scheme means every failed verification has
 * to be attempted twice, and the logs stop saying which credential the caller actually meant.
 */
function readApiKey(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'apikey' ? value : undefined;
}

export const SESSION_COOKIE = 'adverse_session';

function readSessionCookie(request: Request): string | null {
  const cookies: unknown = (request as { cookies?: unknown }).cookies;
  if (typeof cookies !== 'object' || cookies === null) {
    return null;
  }
  const value = (cookies as Record<string, unknown>)[SESSION_COOKIE];
  return typeof value === 'string' && value !== '' ? value : null;
}
