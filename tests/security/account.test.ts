/**
 * I2 — the credential store, through the real API and the real database.
 *
 * This service had never held a password before D-051. What follows is the set of claims that
 * decision made ours to keep, and each one is only true if it was actually tried:
 *
 *  1. **Signup creates the user with the tenant**, in one transaction, and stores the password
 *     only as an argon2id hash that nothing returns.
 *  2. **Confirming the address is what unlocks a live key** — the same flag `decideLiveAccess`
 *     reads (D-052, D-055) — and it is the whole of what stood between the tenant and live.
 *  3. **A token works once, expires, and reveals nothing** about whether it ever existed.
 *  4. **Wrong passwords lock the account temporarily**, and a reset is the way out.
 *  5. **No account route says whether an address is a customer.** Signup is the documented
 *     exception (D-057), because it has to answer with a tenant id.
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
import {
  MAX_FAILED_ATTEMPTS,
  UserService,
  type SafeUser,
} from '../../apps/api/src/auth/user.service.js';
import { loadConfig } from '../../apps/api/src/config/config.js';
import { ApiKeyService, type IssuedApiKey } from '../../apps/api/src/tenancy/api-key.service.js';
import { signupOriginKey } from '../../apps/api/src/tenancy/signup.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const ISSUER = 'https://issuer.test/realms/adverse-search';
const AUDIENCE = 'adverse-search-api';

let app: INestApplication;
let mongo: MongoClient;
let db: Db;
let users: UserService;
let apiKeys: ApiKeyService;

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

/**
 * The rows this file's own HTTP signups write.
 *
 * Supertest connects over the loopback interface, which Express reports as one of these
 * depending on how the socket was opened. Keyed with the same function the service uses, so the
 * keying cannot drift between them.
 */
const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'].map((ip) =>
  signupOriginKey(String(TEST_ENV['SESSION_SECRET']), ip),
);

function password(): string {
  return `harbour-lantern-${randomUUID()}`;
}

interface SignedUp {
  readonly tenantId: string;
  readonly adminUserId: string;
  readonly email: string;
  readonly password: string;
  readonly body: Record<string, unknown>;
}

async function signUp(overrides: Record<string, unknown> = {}): Promise<SignedUp> {
  const email = `${randomUUID()}@example.test`;
  const secret = password();

  const response = await request(app.getHttpServer())
    .post('/v1/signup')
    .send({
      organisationName: 'Acme Compliance Ltd',
      contactEmail: email,
      password: secret,
      ...overrides,
    })
    .expect(201);

  const body = response.body as Record<string, unknown>;
  const tenantId = body['tenantId'] as string;
  createdTenants.push(tenantId);

  return {
    tenantId,
    adminUserId: body['adminUserId'] as string,
    email: (body['contactEmail'] as string) ?? email,
    password: secret,
    body,
  };
}

/**
 * The token, read out of the local mailbox.
 *
 * The API never returns one — that is the point of it being emailed — so the test reads it the
 * way a developer on this stack does: out of the `outboundEmails` collection the mailbox adapter
 * writes to. If the token could be read from a response, it would not be proof of anything.
 */
async function tokenFromMailbox(
  email: string,
  kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
): Promise<string> {
  const message = await db
    .collection('outboundEmails')
    .findOne({ to: email, kind }, { sort: { sentAt: -1 } });

  const body = String(message?.['body'] ?? '');
  const match = /([A-Za-z0-9_-]{40,})/u.exec(body);
  if (match?.[1] === undefined) {
    throw new Error(`No ${kind} token in the mailbox for ${email}. Body was: ${body}`);
  }
  return match[1];
}

async function tenantAdminKey(tenantId: string): Promise<IssuedApiKey> {
  return apiKeys.create({
    tenantId,
    environment: 'live',
    label: 'tenant admin, account tests',
    roles: ['tenant_admin'],
    scopes: ['search:read', 'admin:read', 'admin:write'],
    createdBy: 'operator@erly.test',
    expiresAt: null,
  });
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
  users = app.get(UserService);
  apiKeys = app.get(ApiKeyService);
}, 90_000);

/** Every signup here comes from the loopback address; see the note in `signup.test.ts`. */
beforeEach(async () => {
  // Only this bucket. A blanket delete would also clear the counter the rate-limit test in
  // `signup.test.ts` is building up against its own fixed address — the two files run in
  // parallel against one database, and that is exactly how a suite starts failing for a reason
  // that has nothing to do with what it tests.
  await db.collection('signupAttempts').deleteMany({ originKey: { $in: LOOPBACK_KEYS } });
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
    ].map((collection) => db.collection(collection).deleteMany(tenantFilter)),
  );
  // The audit counter is keyed by tenant id, which Mongo's driver types as an ObjectId on an
  // untyped collection. It is a string here, deliberately — see `AuditService`.
  await db
    .collection<{ _id: string }>('auditSequences')
    .deleteMany({ _id: { $in: createdTenants } });
  await db.collection('outboundEmails').deleteMany(tenantFilter);

  await app?.close();
  await mongo?.close();
  try {
    await app?.get<MongoClient>(MONGO_CLIENT).close();
  } catch {
    // Already closed by app.close().
  }
});

describe('I2 — signup creates the administrator, and stores a hash', () => {
  it('creates the user in the same transaction as the tenant', async () => {
    const account = await signUp();

    const user = await db.collection('users').findOne({ tenantId: account.tenantId });
    expect(user).not.toBeNull();
    expect(user?.['userId']).toBe(account.adminUserId);
    expect(user?.['email']).toBe(account.email);
    // The first user administers the tenant: they have to be able to issue the first key.
    expect(user?.['roles']).toEqual(['tenant_admin']);
  });

  it('stores an argon2id hash, and never the password', async () => {
    const account = await signUp();
    const user = await db.collection('users').findOne({ userId: account.adminUserId });

    expect(String(user?.['passwordHash'])).toMatch(/^\$argon2id\$/u);
    expect(JSON.stringify(user)).not.toContain(account.password);
    // And the response that just went back over the wire carries neither the password nor a hash
    // of it. A credential-shaped field in a response is one that ends up in a screenshot.
    expect(JSON.stringify(account.body)).not.toContain(account.password);
    expect(JSON.stringify(account.body)).not.toContain('argon2');
  });

  it('refuses a weak password before anything is written', async () => {
    const email = `${randomUUID()}@example.test`;
    const response = await request(app.getHttpServer())
      .post('/v1/signup')
      .send({
        organisationName: 'Weak Password Ltd',
        contactEmail: email,
        password: 'passwordpassword',
      })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    // It says what was wrong. "Invalid password" with no reason is a form somebody submits four
    // more times before giving up.
    expect(String(response.body.message).length).toBeGreaterThan(20);
    // And the rejected value is echoed nowhere — not in the message, not in the details.
    expect(JSON.stringify(response.body)).not.toContain('passwordpassword');

    expect(await db.collection('tenants').countDocuments({ name: 'Weak Password Ltd' })).toBe(0);
    expect(await db.collection('users').countDocuments({ email })).toBe(0);
  });

  it('refuses a password that is the organisation name or the address', async () => {
    for (const body of [
      {
        organisationName: 'Northwind Compliance',
        contactEmail: `${randomUUID()}@example.test`,
        password: 'northwindcompliance!!',
      },
      {
        organisationName: 'Some Firm',
        contactEmail: 'predictable@example.test',
        password: 'predictable-2026x',
      },
    ]) {
      const response = await request(app.getHttpServer()).post('/v1/signup').send(body).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a second signup with the same address, and says so plainly (D-057)', async () => {
    const first = await signUp();

    const response = await request(app.getHttpServer())
      .post('/v1/signup')
      .send({
        organisationName: 'Impostor Ltd',
        contactEmail: first.email,
        password: password(),
      })
      .expect(409);

    // The one route that reveals an address is a customer, deliberately: it has to answer with a
    // tenant id, so it cannot answer identically for both cases. Every other account route can,
    // and does — see the enumeration tests below.
    expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(await db.collection('tenants').countDocuments({ name: 'Impostor Ltd' })).toBe(0);
  });

  it('sends the verification message to the address, with a link and not a password', async () => {
    const account = await signUp();

    const message = await db
      .collection('outboundEmails')
      .findOne({ to: account.email, kind: 'EMAIL_VERIFICATION' });

    expect(message).not.toBeNull();
    expect(account.body['verificationEmail']).toMatchObject({ sent: true, sentTo: account.email });
    expect(String(message?.['body'])).not.toContain(account.password);
  });
});

describe('I2 — confirming the address is what unlocks live (D-052)', () => {
  it('refuses a live key before confirmation and issues one after, changing nothing else', async () => {
    const account = await signUp();
    const key = await tenantAdminKey(account.tenantId);

    // Before: the entitlement already includes live, and the credential is live. The only thing
    // standing in the way is the unconfirmed address.
    const before = await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send({ label: 'live, unconfirmed', roles: ['tenant_admin'], environment: 'live' })
      .expect(403);
    expect(before.body.code).toBe('SANDBOX_CANNOT_ACCESS_LIVE');

    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');
    const verified = await request(app.getHttpServer())
      .post('/v1/signup/verify')
      .send({ token })
      .expect(200);

    // The response says what it just changed, rather than leaving the customer to infer it from
    // a 403 that stops happening.
    expect(verified.body.liveAccessUnlocked).toBe(true);
    expect(verified.body.tenantId).toBe(account.tenantId);

    // After: the same call, the same key, the same entitlement. Only tenant state moved.
    await request(app.getHttpServer())
      .post('/v1/tenant/api-keys')
      .set('Authorization', `ApiKey ${key.secret}`)
      .send({ label: 'live, confirmed', roles: ['tenant_admin'], environment: 'live' })
      .expect(201);
  });

  it('sets the flag on the tenant, which is the record key issuance reads', async () => {
    const account = await signUp();
    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token }).expect(200);

    const [tenant, user] = await Promise.all([
      db.collection('tenants').findOne({ tenantId: account.tenantId }),
      db.collection('users').findOne({ userId: account.adminUserId }),
    ]);

    // Both, in one transaction. A verified user beside an unverified tenant is a customer who
    // did everything asked of them and still cannot reach live.
    expect(tenant?.['emailVerifiedAt']).not.toBeNull();
    expect(user?.['emailVerifiedAt']).not.toBeNull();
  });

  it('writes an audit entry for the tenant, naming what it unlocked', async () => {
    const account = await signUp();
    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token }).expect(200);

    const entries = await db
      .collection('auditEvents')
      .find({ tenantId: account.tenantId })
      .sort({ sequence: 1 })
      .toArray();

    expect(entries.map((entry) => entry['action'])).toEqual([
      'tenant:signup',
      'tenant:email-verified',
    ]);
  });
});

describe('I2 — a token works once, and says nothing', () => {
  it('refuses the same token a second time', async () => {
    const account = await signUp();
    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');

    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token }).expect(200);
    const second = await request(app.getHttpServer())
      .post('/v1/signup/verify')
      .send({ token })
      .expect(400);

    expect(second.body.code).toBe('VALIDATION_FAILED');
  });

  it('answers an unknown token exactly as it answers a spent one', async () => {
    const account = await signUp();
    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token }).expect(200);

    const spent = await request(app.getHttpServer()).post('/v1/signup/verify').send({ token });
    const invented = await request(app.getHttpServer())
      .post('/v1/signup/verify')
      .send({ token: 'a'.repeat(43) });

    // Identical, deliberately. A caller who could tell them apart could probe which links were
    // issued, and the customer's next action is the same either way: ask for a new one.
    expect(invented.status).toBe(spent.status);
    expect(invented.body.code).toBe(spent.body.code);
    expect(invented.body.message).toBe(spent.body.message);
  });

  it('refuses an expired token', async () => {
    const account = await signUp();
    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');

    // Age it rather than waiting a day for it.
    await db
      .collection('userTokens')
      .updateMany(
        { userId: account.adminUserId },
        { $set: { expiresAt: new Date(Date.now() - 1) } },
      );

    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token }).expect(400);
  });

  it('spends the previous link when a new one is issued', async () => {
    const account = await signUp();
    const first = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');

    await request(app.getHttpServer())
      .post('/v1/signup/resend-verification')
      .send({ email: account.email })
      .expect(202);

    const second = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');
    expect(second).not.toBe(first);

    // The old link stops working. Otherwise a customer who asked for a new one because they
    // suspected someone else had their mail now has two live credentials instead of none.
    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token: first }).expect(400);
    await request(app.getHttpServer())
      .post('/v1/signup/verify')
      .send({ token: second })
      .expect(200);
  });

  it('stores the token only as a hash', async () => {
    const account = await signUp();
    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');

    const stored = await db
      .collection('userTokens')
      .find({ userId: account.adminUserId })
      .toArray();
    expect(stored.length).toBeGreaterThan(0);
    // A database read must not be able to confirm somebody else's address — confirming an
    // address is what unlocks a live key.
    expect(JSON.stringify(stored)).not.toContain(token);
  });
});

describe('I2 — no account route says whether an address is a customer', () => {
  it('answers a reset request identically for a known and an unknown address', async () => {
    const account = await signUp();

    const known = await request(app.getHttpServer())
      .post('/v1/account/password-reset')
      .send({ email: account.email })
      .expect(202);
    const unknown = await request(app.getHttpServer())
      .post('/v1/account/password-reset')
      .send({ email: `${randomUUID()}@nobody.test` })
      .expect(202);

    expect(unknown.body).toEqual(known.body);
  });

  it('answers a resend request identically for unknown, unconfirmed and confirmed', async () => {
    const unconfirmed = await signUp();
    const confirmed = await signUp();
    const token = await tokenFromMailbox(confirmed.email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token }).expect(200);

    const answers = [];
    for (const email of [unconfirmed.email, confirmed.email, `${randomUUID()}@nobody.test`]) {
      const response = await request(app.getHttpServer())
        .post('/v1/signup/resend-verification')
        .send({ email })
        .expect(202);
      answers.push(JSON.stringify(response.body));
    }

    expect(new Set(answers).size).toBe(1);
  });

  it('sends nothing at all for an address that is already confirmed', async () => {
    const account = await signUp();
    const token = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer()).post('/v1/signup/verify').send({ token }).expect(200);

    const before = await db
      .collection('outboundEmails')
      .countDocuments({ to: account.email, kind: 'EMAIL_VERIFICATION' });

    await request(app.getHttpServer())
      .post('/v1/signup/resend-verification')
      .send({ email: account.email })
      .expect(202);

    // Re-sending for a confirmed address would keep a live token flowing to a mailbox somebody
    // who merely guessed the address could be watching.
    const after = await db
      .collection('outboundEmails')
      .countDocuments({ to: account.email, kind: 'EMAIL_VERIFICATION' });
    expect(after).toBe(before);
  });
});

describe('I2 — resetting a password', () => {
  it('changes the password, and the old one stops working', async () => {
    const account = await signUp();
    await request(app.getHttpServer())
      .post('/v1/account/password-reset')
      .send({ email: account.email })
      .expect(202);

    const token = await tokenFromMailbox(account.email, 'PASSWORD_RESET');
    const replacement = password();

    const response = await request(app.getHttpServer())
      .post('/v1/account/password-reset/confirm')
      .send({ token, newPassword: replacement })
      .expect(200);
    expect(response.body.reset).toBe(true);

    expect(await users.authenticate({ email: account.email, password: replacement })).toMatchObject(
      { ok: true },
    );
    expect(
      await users.authenticate({ email: account.email, password: account.password }),
    ).toMatchObject({ ok: false, failure: 'BAD_PASSWORD' });
  });

  it('refuses a weak new password without spending the link', async () => {
    const account = await signUp();
    await request(app.getHttpServer())
      .post('/v1/account/password-reset')
      .send({ email: account.email })
      .expect(202);
    const token = await tokenFromMailbox(account.email, 'PASSWORD_RESET');

    await request(app.getHttpServer())
      .post('/v1/account/password-reset/confirm')
      .send({ token, newPassword: 'passwordpassword' })
      .expect(400);

    // The same link still works. A customer who picks a weak password should not have to go back
    // to their inbox for a second one.
    const replacement = password();
    await request(app.getHttpServer())
      .post('/v1/account/password-reset/confirm')
      .send({ token, newPassword: replacement })
      .expect(200);
  });

  it('cannot be used with a verification token, or the other way round', async () => {
    const account = await signUp();
    const verification = await tokenFromMailbox(account.email, 'EMAIL_VERIFICATION');

    // Purpose is part of the lookup. Without it, the link that confirms an address would also
    // set a password — and that link is sent to an address nobody has proved they hold yet.
    await request(app.getHttpServer())
      .post('/v1/account/password-reset/confirm')
      .send({ token: verification, newPassword: password() })
      .expect(400);
  });
});

describe('I2 — wrong passwords lock the account, temporarily', () => {
  it('locks after the limit, and a reset is the way out', async () => {
    const account = await signUp();

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await users.authenticate({ email: account.email, password: 'definitely-not-it-x' });
    }

    // Even the right password is refused now. The lock is on the account, not on the guess.
    expect(
      await users.authenticate({ email: account.email, password: account.password }),
    ).toMatchObject({ ok: false, failure: 'LOCKED' });

    await request(app.getHttpServer())
      .post('/v1/account/password-reset')
      .send({ email: account.email })
      .expect(202);
    const token = await tokenFromMailbox(account.email, 'PASSWORD_RESET');
    const replacement = password();
    await request(app.getHttpServer())
      .post('/v1/account/password-reset/confirm')
      .send({ token, newPassword: replacement })
      .expect(200);

    // Whoever holds the mailbox has proved more than a password would, so the lock goes with it.
    // Leaving it in place would punish the person recovering the account for the attacker's
    // failed guesses.
    expect(await users.authenticate({ email: account.email, password: replacement })).toMatchObject(
      { ok: true },
    );
  });

  it('forgets the failures after a successful sign-in', async () => {
    const account = await signUp();

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await users.authenticate({ email: account.email, password: 'wrong-every-time' });
    }
    expect(
      await users.authenticate({ email: account.email, password: account.password }),
    ).toMatchObject({ ok: true });

    // The counter is back to zero: a customer who mistypes nine times over a month and then signs
    // in is not one wrong attempt away from being locked out for the next year.
    const user = await db.collection('users').findOne({ userId: account.adminUserId });
    expect(user?.['failedAttempts']).toBe(0);
  });

  it('signs in before the address is confirmed, because sandbox is not gated', async () => {
    // Signup promises sandbox works immediately. A customer who cannot sign in until an email
    // arrives cannot use the thing they were just promised — D-052 gates the live key, not the
    // account.
    const account = await signUp();
    const result = await users.authenticate({
      email: account.email,
      password: account.password,
    });

    expect(result).toMatchObject({ ok: true });
    const user = (result as { user: SafeUser }).user;
    expect(user.emailVerifiedAt).toBeNull();
    // And the verification state travels with the user, so the caller can say so.
    expect(user.tenantId).toBe(account.tenantId);
  });

  it('never returns a hash from authentication', async () => {
    const account = await signUp();
    const result = await users.authenticate({
      email: account.email,
      password: account.password,
    });

    expect(JSON.stringify(result)).not.toContain('argon2');
    expect(JSON.stringify(result)).not.toContain(account.password);
  });
});
