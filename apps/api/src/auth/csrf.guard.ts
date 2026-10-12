/**
 * CSRF protection for state-changing, cookie-authenticated requests (section 4.2, test T08).
 *
 * Only cookie-authenticated requests need it. A machine client presenting a bearer token is
 * not vulnerable to CSRF — a browser will not attach an Authorization header on its own — and
 * demanding a CSRF token from an integrator would be security theatre that breaks them.
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ApiException } from '../common/api-exception.js';
import { IS_PUBLIC, SESSION_COOKIE } from './auth.guard.js';
import { SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
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

    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    const rawCookies: unknown = (request as { cookies?: unknown }).cookies;
    const cookies =
      typeof rawCookies === 'object' && rawCookies !== null
        ? (rawCookies as Record<string, unknown>)
        : {};
    const sessionId = cookies[SESSION_COOKIE];

    // Bearer-authenticated request: not a CSRF vector.
    if (typeof sessionId !== 'string' || sessionId === '') {
      return true;
    }

    const presented = request.headers[CSRF_HEADER];
    const token = Array.isArray(presented) ? presented[0] : presented;

    if (!(await this.sessions.verifyCsrf(sessionId, token))) {
      throw new ApiException('FORBIDDEN', 'Access denied.', {
        internalDetail:
          'CSRF token missing or invalid on a state-changing cookie-authenticated request.',
      });
    }
    return true;
  }
}
