/**
 * `POST /v1/auth/login` and `/v1/auth/logout` — signing in with a password (I3).
 *
 * # Versioned, unlike the OIDC routes next door
 *
 * `AuthController` is version-neutral on purpose: it serves a browser redirect journey whose URLs
 * are registered at the identity provider, and versioning those would mean re-registering
 * redirect URIs on every API version bump. This is the opposite case — an API an integrator codes
 * against — so it lives under `/v1` with everything else they call.
 *
 * # One session store, not two
 *
 * The session this returns is created by the same `SessionService` the panel's cookie uses, with
 * the same idle and absolute expiry and the same revocation. The only difference is how it is
 * presented: a cookie for the browser, `Authorization: Session <token>` for a caller that has no
 * cookie jar. A second session mechanism is how a service ends up with a sign-out that works on
 * one of them.
 *
 * # One answer for every failure
 *
 * `UserService.authenticate` distinguishes unknown address, wrong password, locked and suspended,
 * because the audit trail and the lockout counter need the distinction. **The caller never gets
 * it.** All four are one `401` with one sentence, exactly as `AuthGuard` flattens every API-key
 * rejection. Telling an anonymous caller that the address exists but the password is wrong halves
 * the work of guessing; telling them the account is locked confirms the address is real.
 */

import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import {
  loginSchema,
  type LoginInput,
  type LoginResult,
  type LogoutResult,
} from '@erly/adverse-contracts';

import { AttemptLimitExceeded, AttemptLimiter, LOGIN_POLICY } from '../common/attempt-limiter.js';
import { ApiException } from '../common/api-exception.js';
import { validate } from '../common/zod-validation.pipe.js';
import { EntitlementsService } from '../tenancy/entitlements.service.js';
import { decideLiveAccess } from '../tenancy/live-access.js';
import { Public, RequirePermission } from './auth.guard.js';
import { SESSION_IDLE_MS, SessionService } from './session.service.js';
import { UserService } from './user.service.js';

@Controller({ path: 'auth', version: '1' })
export class LoginController {
  constructor(
    @Inject(UserService) private readonly users: UserService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(AttemptLimiter) private readonly limiter: AttemptLimiter,
  ) {}

  /**
   * Exchange an email address and password for a session.
   *
   * `200`, not 201: a session is not a resource this API lets anybody address afterwards.
   */
  @Post('login')
  @HttpCode(200)
  @Public()
  async login(
    @Req() request: Request,
    @Body(validate(loginSchema)) body: LoginInput,
  ): Promise<LoginResult> {
    const now = new Date();

    // Bounded per origin, before the argon2id hash is computed. The hash costs 19 MiB and a few
    // milliseconds **by design**, so an unbounded login route is a way to spend the server's
    // memory with nothing but a socket. This is a different axis from the per-account lockout:
    // that one stops somebody grinding one customer's password, this one stops a spray across
    // many accounts, which the per-account counter cannot see.
    try {
      await this.limiter.record(LOGIN_POLICY, request.ip, now);
    } catch (error) {
      if (error instanceof AttemptLimitExceeded) {
        throw new ApiException(
          'RATE_LIMITED',
          'Too many sign-in attempts from this address. Try again shortly.',
          { internalDetail: error.message },
        );
      }
      throw error;
    }

    const result = await this.users.authenticate({
      email: body.email,
      password: body.password,
      now,
    });

    if (!result.ok) {
      // One answer, four reasons. The reason is in the internal detail, which is logged and never
      // returned — see the note at the top of this file.
      throw new ApiException('UNAUTHENTICATED', 'Those credentials were not accepted.', {
        internalDetail: `login refused: ${result.failure} for ${body.email}`,
      });
    }

    const user = result.user;

    // What environment this session acts in is decided from what the tenant may actually use, by
    // the same function that decides whether a live key may be issued (D-055) — never from
    // anything the caller sent. A tenant entitled to live with a confirmed address gets a live
    // session; everyone else gets sandbox, and a sandbox session cannot reach live evidence
    // whatever its roles say.
    const [tenant, entitlement] = await Promise.all([
      this.entitlements.findTenant(user.tenantId),
      this.entitlements.activeEntitlement(user.tenantId),
    ]);
    const environment = decideLiveAccess({ tenant, entitlement }).granted ? 'live' : 'sandbox';

    const { sessionId } = await this.sessions.create({
      subject: user.userId,
      tenantId: user.tenantId,
      roles: user.roles,
      environment,
      // No provider tokens: nobody stands behind this session but us.
      accessToken: null,
      refreshToken: null,
      // Not asserted. A password is one factor and this service knows nothing more about how the
      // person authenticated, so claiming an assurance level here would be inventing one.
      authenticationAssurance: null,
      now,
    });

    return {
      sessionToken: sessionId,
      expiresAt: new Date(now.getTime() + this.sessions.absoluteLifetimeMs()).toISOString(),
      idleTimeoutSeconds: Math.floor(SESSION_IDLE_MS / 1000),
      userId: user.userId,
      tenantId: user.tenantId,
      roles: [...user.roles],
      environment,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      warning:
        'Send this as "Authorization: Session <token>". It is a bearer credential: anyone ' +
        'holding it is this user until it expires or is signed out. It is not recoverable — ' +
        'sign in again rather than storing it anywhere a key would not go.',
    };
  }

  /**
   * End this session. Immediate, cluster-wide, and idempotent.
   *
   * Revokes whichever session authenticated the call — the header one for a machine caller, the
   * cookie for a browser — because the record is shared and revocation is a state change on it
   * rather than a client-side forget.
   */
  @Post('logout')
  @HttpCode(200)
  @RequirePermission('search:read')
  async logout(@Req() request: Request): Promise<LogoutResult> {
    const presented = readPresentedSession(request);
    if (presented !== null) {
      await this.sessions.revoke(presented);
    }
    return { signedOut: true };
  }
}

/**
 * The session token this request actually arrived with.
 *
 * Read again here rather than carried on the principal: the principal deliberately holds no
 * credential, and putting one on it would make every service that receives a principal a place a
 * session token can leak from.
 */
function readPresentedSession(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'session' && value !== undefined && value !== '') {
      return value;
    }
  }

  const cookies: unknown = (request as { cookies?: unknown }).cookies;
  if (typeof cookies === 'object' && cookies !== null) {
    const value = (cookies as Record<string, unknown>)['adverse_session'];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return null;
}
