/**
 * The human sign-in flow (section 4.2).
 *
 * OIDC authorisation-code with PKCE, terminated by a backend-for-frontend session. The code
 * exchange happens here, server-side; the browser receives an opaque, HTTP-only session cookie
 * and never sees a provider token.
 *
 * The PKCE verifier and the CSRF `state` are held in short-lived, HTTP-only cookies rather
 * than in server memory, so the flow survives a restart and works across multiple API
 * instances without sticky sessions.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Controller, Get, Inject, Post, Query, Req, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { Request, Response } from 'express';

import { isRole, type Role } from '@erly/adverse-domain';

import { ApiException } from '../common/api-exception.js';
import { APP_CONFIG } from '../tokens.js';
import type { AppConfig } from '../config/config.js';
import { Public, RequirePermission, SESSION_COOKIE } from './auth.guard.js';
import { SessionService } from './session.service.js';

const STATE_COOKIE = 'adverse_oidc_state';
const VERIFIER_COOKIE = 'adverse_oidc_verifier';
const CSRF_COOKIE = 'csrf_token';

/** The login handshake is short-lived; a stale one should fail, not linger. */
const HANDSHAKE_MAX_AGE_MS = 10 * 60 * 1000;

interface DiscoveryDocument {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly end_session_endpoint?: string;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
}

/**
 * Version-neutral, like health: the sign-in flow is a browser redirect journey with URLs
 * registered at the identity provider. Versioning it would mean re-registering redirect URIs
 * on every API version bump, for no benefit.
 */
@Controller({ path: 'auth', version: VERSION_NEUTRAL })
export class AuthController {
  private discovery: DiscoveryDocument | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /** GET /auth/login — begin the authorisation-code flow. */
  @Get('login')
  @Public()
  async login(@Res() res: Response): Promise<void> {
    const discovery = await this.discover();

    // PKCE: the verifier never leaves this service; only its S256 hash goes to the provider.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');

    this.setHandshakeCookie(res, STATE_COOKIE, state);
    this.setHandshakeCookie(res, VERIFIER_COOKIE, verifier);

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('client_id', this.config.oidc.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    res.redirect(url.toString());
  }

  /** GET /auth/callback — exchange the code and establish the BFF session. */
  @Get('callback')
  @Public()
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
  ): Promise<void> {
    if (error !== undefined) {
      // The provider refused. Reported without echoing its text, which is attacker-influenced.
      throw new ApiException('UNAUTHENTICATED', 'Sign-in was not completed.', {
        internalDetail: `provider error: ${error}`,
      });
    }

    const cookies = readCookies(req);
    const expectedState = cookies[STATE_COOKIE];
    const verifier = cookies[VERIFIER_COOKIE];

    if (
      code === undefined ||
      state === undefined ||
      expectedState === undefined ||
      verifier === undefined
    ) {
      throw new ApiException('UNAUTHENTICATED', 'Sign-in was not completed.', {
        internalDetail: 'Missing code, state or PKCE verifier on callback.',
      });
    }

    // Constant-time state comparison: this is the CSRF defence for the login flow itself.
    if (!constantTimeEquals(state, expectedState)) {
      throw new ApiException('UNAUTHENTICATED', 'Sign-in was not completed.', {
        internalDetail: 'OIDC state mismatch — possible login CSRF.',
      });
    }

    const discovery = await this.discover();
    const tokens = await this.exchangeCode(discovery.token_endpoint, code, verifier);
    const claims = decodeClaims(tokens.access_token);

    const roles = (claims.realm_access?.roles ?? []).filter((r): r is Role => isRole(r));
    if (roles.length === 0) {
      throw new ApiException('FORBIDDEN', 'This account has no role in the service.', {
        internalDetail: `subject=${claims.sub ?? 'unknown'} carries no recognised role`,
      });
    }

    const { sessionId, csrfToken } = await this.sessions.create({
      subject: claims.sub ?? '',
      tenantId: normaliseTenant(claims.tenant_id),
      roles,
      // A browser session is sandbox unless the provider says otherwise, so an ambiguous
      // token cannot reach live evidence.
      environment: claims.environment === 'live' ? 'live' : 'sandbox',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      // Verified from the provider's own claim rather than trusted from the client (4.2).
      authenticationAssurance: typeof claims.acr === 'string' ? claims.acr : null,
      now: new Date(),
    });

    this.clearHandshakeCookies(res);

    // HTTP-only: script in the page cannot read it, so an XSS cannot exfiltrate the session.
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: this.config.session.secure,
      sameSite: 'lax',
      path: '/',
    });

    // Readable by design: the panel echoes it in X-CSRF-Token. Being readable is not a
    // weakness here — an attacker on another origin cannot read it.
    res.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: this.config.session.secure,
      sameSite: 'lax',
      path: '/',
    });

    res.redirect('/');
  }

  /**
   * POST /auth/logout — revoke the session.
   *
   * POST, not GET: a GET logout can be triggered by any page embedding an image, which is a
   * denial-of-service on the user rather than a security hole, but is avoidable.
   */
  @Post('logout')
  @RequirePermission('search:read')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = readCookies(req)[SESSION_COOKIE];
    if (sessionId !== undefined) {
      await this.sessions.revoke(sessionId);
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
    res.status(204).send();
  }

  /** GET /auth/session — who am I. Used by the panel to render its shell. */
  @Get('session')
  @RequirePermission('search:read')
  session(@Req() req: Request): {
    subject: string;
    tenantId: string | null;
    roles: readonly string[];
    environment: string;
  } {
    const principal = req.principal;
    if (principal === undefined) {
      throw new ApiException('UNAUTHENTICATED', 'Authentication is required.');
    }
    return {
      subject: principal.subject,
      tenantId: principal.tenantId,
      roles: principal.roles,
      environment: principal.environment,
    };
  }

  private redirectUri(): string {
    return `http://127.0.0.1:${String(this.config.port)}/auth/callback`;
  }

  private setHandshakeCookie(res: Response, name: string, value: string): void {
    res.cookie(name, value, {
      httpOnly: true,
      secure: this.config.session.secure,
      sameSite: 'lax',
      path: '/auth',
      maxAge: HANDSHAKE_MAX_AGE_MS,
    });
  }

  private clearHandshakeCookies(res: Response): void {
    res.clearCookie(STATE_COOKIE, { path: '/auth' });
    res.clearCookie(VERIFIER_COOKIE, { path: '/auth' });
  }

  /** Discovery is cached: it is stable, and refetching per login adds latency and a failure mode. */
  private async discover(): Promise<DiscoveryDocument> {
    if (this.discovery !== null) {
      return this.discovery;
    }
    const response = await fetch(`${this.config.oidc.issuer}/.well-known/openid-configuration`);
    if (!response.ok) {
      throw new ApiException('INTERNAL', 'The identity provider is unavailable.', {
        internalDetail: `discovery returned ${String(response.status)}`,
      });
    }
    this.discovery = (await response.json()) as DiscoveryDocument;
    return this.discovery;
  }

  private async exchangeCode(
    tokenEndpoint: string,
    code: string,
    verifier: string,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      client_id: this.config.oidc.clientId,
      client_secret: this.config.oidc.clientSecret,
      code_verifier: verifier,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      throw new ApiException('UNAUTHENTICATED', 'Sign-in was not completed.', {
        internalDetail: `token exchange returned ${String(response.status)}`,
      });
    }
    return (await response.json()) as TokenResponse;
  }
}

interface AccessTokenClaims {
  readonly sub?: string;
  readonly acr?: string;
  readonly tenant_id?: string | string[];
  readonly environment?: string;
  readonly realm_access?: { readonly roles?: readonly string[] };
}

/**
 * Read claims from the token the provider just issued over an authenticated back-channel.
 *
 * This does not verify the signature, and does not need to: the token came directly from the
 * provider's token endpoint over TLS in response to our own client-authenticated request.
 * Every token arriving on a normal API request goes through `TokenVerifier` instead.
 */
function decodeClaims(accessToken: string): AccessTokenClaims {
  const parts = accessToken.split('.');
  if (parts.length < 2 || parts[1] === undefined) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AccessTokenClaims;
  } catch {
    return {};
  }
}

function normaliseTenant(claim: string | readonly string[] | undefined): string | null {
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

function readCookies(req: Request): Record<string, string> {
  const raw: unknown = (req as { cookies?: unknown }).cookies;
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
