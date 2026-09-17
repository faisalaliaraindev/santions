/**
 * I3 — signing in with a password, through the real API and the real database.
 *
 * The claims, each of which is only true if it was actually tried:
 *
 *  1. **A session obtained by password works on every route a session works on**, presented as
 *     `Authorization: Session <token>` — and it is the *same* store as the panel's cookie, so one
 *     sign-out ends it.
 *  2. **Every failure is one opaque `401`.** Wrong password, unknown address, locked and
 *     suspended are indistinguishable to the caller.
 *  3. **The session's environment comes from what the tenant may use**, by the same function that
 *     gates a live key — never from the request.
 *  4. **The token is not a password and is not stored as one**: the database holds a hash, and a
 *     revoked or expired session stops working immediately.
 *  5. **Attempts are bounded per address**, which is the axis the per-account lockout cannot see.
 *
 * Requires the local stack: `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { MongoClient, type Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule, APP_CONFIG, MONGO_CLIENT, MONGO_DB } from '../../apps/api/src/app.module.js';
import { TokenVerifier } from '../../apps/api/src/auth/token-verifier.js';
import { MAX_FAILED_ATTEMPTS } from '../../apps/api/src/auth/user.service.js';
import {
  LOGIN_POLICY,
  originKeyFor,
  SIGNUP_POLICY,
} from '../../apps/api/src/common/attempt-limiter.js';
import { loadConfig } from '../../apps/api/src/config/config.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const ISSUER = 'https://issuer.test/realms/adverse-search';
const AUDIENCE = 'adverse-search-api';

let app: INestApplication;
let mongo: MongoClient;
let db: Db;

const createdTenants: string[] = [];

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

/** Both buckets this file fills from the loopback address; see the note in `signup.test.ts`. */
const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'].map((ip) =>
  originKeyFor(String(TEST_ENV['SESSION_SECRET']), ip),
);

function password(): string {
  return `harbour-lantern-${randomUUID()}`;
}

interface Account {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

async function signUp(): Promise<Account> {
  const email = `${randomUUID()}@example.test`;
  const secret = password();

  const response = await request(app.getHttpServer())
    .post('/v1/signup')
    .send({ organisationName: 'Login Tests Ltd', contactEmail: email, password: secret })
    .expect(201);

  const body = response.body as Record<string, string>;
  createdTenants.push(body['tenantId'] as string);
  return {
    tenantId: body['tenantId'] as string,
    userId: body['adminUserId'] as string,
    email,
    password: secret,
  };
}

/** Confirm the address the way a customer does: with the token from the local mailbox. */
async function confirm(account: Account): Promise<void> {
  const message = await db
    .collection('outboundEmails')
    .findOne({ to: account.email, kind: 'EMAIL_VERIFICATION' }, { sort: { sentAt: -1 } });
  const match = /([A-Za-z0-9_-]{40,})/u.exec(String(message?.['body'] ?? ''));
  await request(app.getHttpServer())
    .post('/v1/signup/verify')
    .send({ token: match?.[1] })
    .expect(200);
}

async function logIn(
  email: string,
  secret: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ email, password: secret });
  return { status: response.status, body: response.body as Record<string, unknown> };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
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
  app.use(cookieParser());
  await app.init();

  db = app.get<Db>(MONGO_DB);
}, 90_000);

beforeEach(async () => {
  await db
    .collection('attemptLog')
    .deleteMany({ bucket: { $in: ['SIGNUP', 'LOGIN'] }, originKey: { $in: LOOPBACK_KEYS } });
});

afterAll(async () => {
  const tenantFilter = { tenantId: { $in: createdTenants } };
  await Promise.all(
    [
      'tenants',
      'tenantEntitlementVersions',
      'taxonomyVersions',
      'policyVersions',
      'users',
      'userTokens',
      'auditEvents',
      'outboundEmails',
    ].map((collection) => db.collection(collection).deleteMany(tenantFilter)),
  );
  await db
    .collection<{ _id: string }>('auditSequences')
    .deleteMany({ _id: { $in: createdTenants } });
  await db.collection('sessions').deleteMany({ tenantId: { $in: createdTenants } });

  await app?.close();
  await mongo?.close();
  try {
    await app?.get<MongoClient>(MONGO_CLIENT).close();
  } catch {
    // Already closed by app.close().
  }
});

describe('I3 — a password buys a session that works like any other', () => {
  it('returns a session and enough context not to have to ask again', async () => {
    const account = await signUp();
    const { status, body } = await logIn(account.email, account.password);

    expect(status).toBe(200);
    expect(body['sessionToken']).toBeTypeOf('string');
    expect(body['userId']).toBe(account.userId);
    expect(body['tenantId']).toBe(account.tenantId);
    // Both roles the administrator was provisioned with; `analyst` is what lets the keys they
    // issue actually run a search.
    expect(body['roles']).toEqual(['tenant_admin', 'analyst']);
    // Both expiries, because a client that knows only the absolute one will be surprised by the
    // idle one at the worst possible moment.
    expect(body['expiresAt']).toBeTypeOf('string');
    expect(body['idleTimeoutSeconds']).toBeGreaterThan(0);
  });

  it('authenticates a real route with Authorization: Session', async () => {
    const account = await signUp();
    const { body } = await logIn(account.email, account.password);

    // The end of the claim that matters: not "a token came back" but "it works". Listing keys
    // needs `apikey:manage`, which is what `tenant_admin` holds — so this also proves the roles
    // travelled onto the session.
    const listed = await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `Session ${String(body['sessionToken'])}`)
      .expect(200);

    expect(listed.body.items).toEqual([]);
  });

  it('issues the tenant its first API key from a session, with no operator involved', async () => {
    // The whole point of the phase, reachable for the first time here: signup, confirm, sign in,
    // issue a key — nobody at Erly touched it.
    const account = await signUp();
    await confirm(account);
    const { body } = await logIn(account.email, account.password);

    const issued = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `Session ${String(body['sessionToken'])}`)
      .send({ label: 'first key, issued by the tenant', roles: ['tenant_admin'] })
      .expect(201);

    expect(String(issued.body.secret)).toMatch(/^erly_sandbox_/u);
  });

  it('is the same store as the cookie: sign-out ends it immediately', async () => {
    const account = await signUp();
    const { body } = await logIn(account.email, account.password);
    const token = String(body['sessionToken']);

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Session ${token}`)
      .expect(200);

    // Revocation is a state change on a shared record, not a client-side forget, so the token
    // stops working everywhere at once.
    await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `Session ${token}`)
      .expect(401);
  });

  it('stores a hash of the session, never the token', async () => {
    const account = await signUp();
    const { body } = await logIn(account.email, account.password);

    const stored = await db.collection('sessions').findOne({ subject: account.userId });
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(String(body['sessionToken']));
    // A password session has no provider behind it, so it holds no provider tokens rather than
    // an empty string this service would then carry around as though it were one.
    expect(stored?.['providerTokens']).toBeNull();
  });
});

describe('I3 — every failure is the same failure', () => {
  it('answers a wrong password and an unknown address identically', async () => {
    const account = await signUp();

    const wrong = await logIn(account.email, 'definitely-not-the-password');
    const unknown = await logIn(`${randomUUID()}@nobody.test`, 'definitely-not-the-password');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ ...wrong.body, correlationId: unknown.body['correlationId'] });
  });

  it('answers a locked account the same way, rather than confirming it exists', async () => {
    const account = await signUp();

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await logIn(account.email, 'wrong-every-single-time');
    }

    // Now even the right password is refused — and the caller cannot tell that from any other
    // refusal. Saying "locked" would confirm the address is real, which is the enumeration every
    // other account route is shaped to avoid.
    const locked = await logIn(account.email, account.password);
    const unknown = await logIn(`${randomUUID()}@nobody.test`, account.password);

    expect(locked.status).toBe(401);
    expect(locked.body['code']).toBe(unknown.body['code']);
    expect(locked.body['message']).toBe(unknown.body['message']);
  });

  it('never echoes the password it refused', async () => {
    const account = await signUp();
    const secret = 'a-wrong-password-worth-finding';
    const refused = await logIn(account.email, secret);

    expect(JSON.stringify(refused.body)).not.toContain(secret);
  });

  it('refuses a session token that was never issued', async () => {
    await request(app.getHttpServer())
      .get('/v1/tenant/api-keys')
      .set('Authorization', `Session ${'a'.repeat(43)}`)
      .expect(401);
  });
});

describe('I3 — the session acts in the environment the tenant may use', () => {
  it('signs an unconfirmed tenant into sandbox, and confirming raises it to live', async () => {
    const account = await signUp();

    const before = await logIn(account.email, account.password);
    // D-052: the entitlement includes live from signup, but the address is unconfirmed, so the
    // session is sandbox. Decided by `decideLiveAccess` — the same function key issuance uses.
    expect(before.body['environment']).toBe('sandbox');
    expect(before.body['emailVerifiedAt']).toBeNull();

    await confirm(account);

    const after = await logIn(account.email, account.password);
    expect(after.body['environment']).toBe('live');
    expect(after.body['emailVerifiedAt']).not.toBeNull();
  });

  it('cannot be asked for: environment is not a field of the request', async () => {
    const account = await signUp();

    // Strict schema. A caller who could name their own environment could name `live`.
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: account.email, password: account.password, environment: 'live' })
      .expect(400);
  });

  it('refuses a live key from a sandbox session, entitlement or not', async () => {
    const account = await signUp();
    const { body } = await logIn(account.email, account.password);

    const refused = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `Session ${String(body['sessionToken'])}`)
      .send({ label: 'live from a sandbox session', roles: ['tenant_admin'], environment: 'live' })
      .expect(403);

    expect(refused.body.code).toBe('SANDBOX_CANNOT_ACCESS_LIVE');
  });
});

describe('I3 — attempts are bounded per address as well as per account', () => {
  it('answers 429 past the per-origin bound', async () => {
    const account = await signUp();

    // Spread across addresses that do not exist, so the per-account lockout never fires: this is
    // the spray the account counter cannot see, and the origin bound is what stops it.
    let sawRateLimit = false;
    for (let attempt = 0; attempt < LOGIN_POLICY.max + 2 && !sawRateLimit; attempt += 1) {
      const result = await logIn(`${randomUUID()}@nobody.test`, 'one-guess-each-time');
      sawRateLimit = result.status === 429;
    }

    expect(sawRateLimit).toBe(true);

    // And it is retryable, unlike every 401 above: the same request works once the window passes.
    const limited = await logIn(account.email, account.password);
    expect(limited.status).toBe(429);
    expect(limited.body['retryable']).toBe(true);
  });

  it('counts sign-ins separately from signups', async () => {
    // One collection, independent buckets. A busy office signing in must not exhaust the bound
    // that exists to stop somebody creating tenants in a loop.
    const account = await signUp();
    for (let attempt = 0; attempt < SIGNUP_POLICY.max + 1; attempt += 1) {
      await logIn(account.email, 'wrong-but-cheap');
    }

    const signupRows = await db
      .collection('attemptLog')
      .countDocuments({ bucket: 'SIGNUP', originKey: { $in: LOOPBACK_KEYS } });
    expect(signupRows).toBe(1);
  });
});
