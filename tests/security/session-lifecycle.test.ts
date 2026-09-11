/**
 * T07 and T08 — the session, through the real HTTP layer.
 *
 * The session logic has unit-level coverage through `SessionService`, but that is not what
 * these tests are for. The claim Phase B has to support is that **a revoked session cannot be
 * used against the API**, and that a state-changing request without a CSRF token is refused by
 * the running guards in their real order. Both are properties of the assembled application:
 * the guard chain, the cookie parser and the store together. Testing `SessionService` alone
 * would leave the interesting failure — a guard that reads the cookie but never checks the
 * store — undetected.
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG, MONGO_CLIENT } from '../../apps/api/src/app.module.js';
import { SESSION_COOKIE } from '../../apps/api/src/auth/auth.guard.js';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SessionService,
} from '../../apps/api/src/auth/session.service.js';
import { TokenVerifier } from '../../apps/api/src/auth/token-verifier.js';
import { loadConfig } from '../../apps/api/src/config/config.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const ISSUER = 'https://issuer.test/realms/adverse-search';
const AUDIENCE = 'adverse-search-api';

let app: INestApplication;
let sessions: SessionService;
let mongo: MongoClient;
let privateKey: KeyLike;

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ADVERSE_SEARCH_MODE: 'mock',
  MONGODB_URI,
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: 'adverse-search-panel',
  OIDC_CLIENT_SECRET: 'test-only-secret-value',
  OIDC_AUDIENCE: AUDIENCE,
  SESSION_SECRET: 'test-only-session-secret-value',
  SESSION_COOKIE_SECURE: 'false',
  CORS_ORIGINS: '',
};

/**
 * A signed-in human.
 *
 * Created through `SessionService` rather than by driving the OIDC round trip, which
 * `auth.test.ts` covers. The cookie it returns is the same cookie the callback would set, and
 * every request below goes through the real guard chain with it.
 */
async function signIn(
  overrides: {
    readonly subject?: string;
    readonly tenantId?: string | null;
    readonly roles?: readonly ('analyst' | 'reviewer' | 'tenant_admin')[];
    readonly accessToken?: string;
  } = {},
): Promise<{ sessionId: string; csrfToken: string; subject: string }> {
  const subject = overrides.subject ?? `user-${randomUUID()}`;
  const created = await sessions.create({
    subject,
    tenantId: overrides.tenantId ?? `tenant-${randomUUID()}`,
    roles: overrides.roles ?? ['analyst'],
    environment: 'sandbox',
    accessToken: overrides.accessToken ?? 'provider-access-token-value',
    refreshToken: 'provider-refresh-token-value',
    authenticationAssurance: null,
    now: new Date(),
  });

  return { ...created, subject };
}

function cookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}`;
}

function subjectPayload(name = 'Ana Lucía Vargas Mora') {
  return {
    fullName: name,
    aliases: [],
    countryContext: ['CR'],
    knownCompanies: [],
    purpose: 'CUSTOMER_ONBOARDING' as const,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };

  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(
      `The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap\n\n${String(error)}`,
    );
  }

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(TEST_ENV))
    .overrideProvider(TokenVerifier)
    .useValue(
      new TokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        keyResolver: createLocalJWKSet({ keys: [publicJwk] }),
      }),
    )
    .compile();

  app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });
  // The same middleware `main.ts` installs. Without it the guards see no cookies at all, and
  // every test here would pass for the wrong reason.
  app.use(cookieParser());
  await app.init();

  sessions = app.get(SessionService);
}, 90_000);

afterAll(async () => {
  await app?.close();
  await mongo?.close();
  try {
    await app?.get<MongoClient>(MONGO_CLIENT).close();
  } catch {
    // Already closed by app.close().
  }
});

describe('T08 — CSRF on state-changing cookie-authenticated requests', () => {
  it('refuses a write with a valid session but no CSRF token', async () => {
    const session = await signIn();

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Cookie', cookie(session.sessionId))
      .send(subjectPayload());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    // The refusal must not explain what was missing, or it becomes a checklist.
    expect(JSON.stringify(response.body)).not.toMatch(/csrf/i);
  });

  it('refuses a write whose CSRF token belongs to another session', async () => {
    // Session fixation via a token the attacker knows: they have their own valid token, but it
    // must not authorise a write on somebody else's session.
    const victim = await signIn();
    const attacker = await signIn();

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Cookie', cookie(victim.sessionId))
      .set('X-CSRF-Token', attacker.csrfToken)
      .send(subjectPayload());

    expect(response.status).toBe(403);
  });

  it('refuses a write whose CSRF token is a prefix of the real one', async () => {
    // Guards against a length-insensitive or short-circuiting comparison.
    const session = await signIn();

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Cookie', cookie(session.sessionId))
      .set('X-CSRF-Token', session.csrfToken.slice(0, -1))
      .send(subjectPayload());

    expect(response.status).toBe(403);
  });

  it('accepts the same write once the matching CSRF token is sent', async () => {
    // The control: without this, every test above could be passing because writes are broken.
    const session = await signIn();

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Cookie', cookie(session.sessionId))
      .set('X-CSRF-Token', session.csrfToken)
      .send(subjectPayload());

    expect(response.status).toBe(201);
    expect(response.body.fullName).toBe('Ana Lucía Vargas Mora');
  });

  it('does not demand a CSRF token from a bearer-authenticated machine client', async () => {
    // A browser will not attach an Authorization header by itself, so a machine client is not
    // a CSRF vector. Demanding a token there would be theatre that breaks integrators.
    const token = await new SignJWT({
      realm_access: { roles: ['analyst'] },
      tenant_id: `tenant-${randomUUID()}`,
      scope: 'search:read search:write',
      environment: 'sandbox',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('machine-1')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Authorization', `Bearer ${token}`)
      .send(subjectPayload('Empresa Demo S.A.'));

    expect(response.status).toBe(201);
  });

  it('does not require a CSRF token to read', async () => {
    const session = await signIn();

    const response = await request(app.getHttpServer())
      .get('/v1/searches')
      .set('Cookie', cookie(session.sessionId));

    expect(response.status).toBe(200);
  });

  it('never returns a provider token to the browser', async () => {
    // T08's "no token in browser storage or logs" half, at the only place a token could leak
    // into the browser: a response body. The session response says who you are, not what the
    // service holds on your behalf.
    const session = await signIn({ accessToken: 'super-secret-provider-access-token' });

    const response = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', cookie(session.sessionId));

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('super-secret-provider-access-token');
    expect(JSON.stringify(response.body)).not.toContain(session.sessionId);
    expect(JSON.stringify(response.body)).not.toContain(session.csrfToken);
  });
});

describe('T07 — logout, revocation and expiry', () => {
  it('stops accepting the cookie after logout', async () => {
    const session = await signIn();

    // Works before.
    await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', cookie(session.sessionId))
      .expect(200);

    const logout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', cookie(session.sessionId))
      .set('X-CSRF-Token', session.csrfToken);
    expect(logout.status).toBe(204);

    // And does not after. This is the whole of T07: old access must not persist.
    const after = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', cookie(session.sessionId));

    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_EXPIRED');
  });

  it('clears both cookies on logout so the browser stops presenting them', async () => {
    const session = await signIn();

    const logout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', cookie(session.sessionId))
      .set('X-CSRF-Token', session.csrfToken);

    const setCookie: unknown = logout.headers['set-cookie'];
    const cleared = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .filter((entry): entry is string => typeof entry === 'string')
      .join('\n');
    expect(cleared).toMatch(/adverse_session=/);
    expect(cleared).toMatch(/csrf_token=/);
  });

  it('refuses a write with a revoked session, not only a read', async () => {
    const session = await signIn();
    await sessions.revoke(session.sessionId);

    const response = await request(app.getHttpServer())
      .post('/v1/subjects')
      .set('Cookie', cookie(session.sessionId))
      .set('X-CSRF-Token', session.csrfToken)
      .send(subjectPayload());

    // 401, not 403: the credential is gone, so this is not a CSRF failure.
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SESSION_EXPIRED');
  });

  it('revokes every session a subject holds, not just the one signing out', async () => {
    // Withdrawing someone's access must not depend on which browser they used.
    const subject = `user-${randomUUID()}`;
    const laptop = await signIn({ subject });
    const phone = await signIn({ subject });

    const revoked = await sessions.revokeAllForSubject(subject);
    expect(revoked).toBe(2);

    for (const session of [laptop, phone]) {
      const response = await request(app.getHttpServer())
        .get('/auth/session')
        .set('Cookie', cookie(session.sessionId));
      expect(response.status).toBe(401);
    }
  });

  it('rejects a session that has passed its idle window', async () => {
    const session = await signIn();
    const store = mongo.db().collection('sessions');

    // Reach into the store rather than waiting thirty minutes. The expiry decision is what is
    // under test, not the clock.
    await store.updateMany(
      {},
      { $set: { lastSeenAt: new Date(Date.now() - SESSION_IDLE_MS - 60_000) } },
    );

    const response = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', cookie(session.sessionId));

    expect(response.status).toBe(401);
  });

  it('rejects a session past its absolute window even if recently active', async () => {
    // Sliding idle expiry alone would let a session live forever under constant use, which is
    // exactly the session an attacker with a stolen cookie keeps alive.
    const session = await signIn();
    const store = mongo.db().collection('sessions');

    await store.updateMany(
      {},
      {
        $set: {
          lastSeenAt: new Date(),
          absoluteExpiresAt: new Date(Date.now() - 1_000),
        },
      },
    );

    const response = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', cookie(session.sessionId));

    expect(response.status).toBe(401);
    expect(SESSION_ABSOLUTE_MS).toBeGreaterThan(SESSION_IDLE_MS);
  });

  it('treats an unknown session id exactly like a revoked one', async () => {
    // A different answer here would let someone probe which session IDs have ever existed.
    const unknown = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', cookie('this-session-never-existed'));

    const session = await signIn();
    await sessions.revoke(session.sessionId);
    const revoked = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', cookie(session.sessionId));

    expect(unknown.status).toBe(revoked.status);
    expect(unknown.body.code).toBe(revoked.body.code);
  });
});
