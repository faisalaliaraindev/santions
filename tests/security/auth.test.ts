/**
 * T03, T09 — token validation and production startup guards.
 *
 * Runs against real crypto (locally generated keys), not a stubbed verifier. A test that mocks
 * the thing it is verifying proves only that the mock behaves.
 */

import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { createLocalJWKSet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  TokenVerificationError,
  TokenVerifier,
  type TokenRejection,
} from '../../apps/api/src/auth/token-verifier.js';
import { corsOptions } from '../../apps/api/src/common/cors.js';
import { ConfigurationError, loadConfig } from '../../apps/api/src/config/config.js';

const ISSUER = 'https://issuer.test/realms/adverse-search';
const AUDIENCE = 'adverse-search-api';

let privateKey: KeyLike;
let publicJwk: JWK;
let verifier: TokenVerifier;
/** A key the verifier does NOT know about, for forging. */
let attackerKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };

  const attacker = await generateKeyPair('RS256');
  attackerKey = attacker.privateKey;

  verifier = new TokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keyResolver: createLocalJWKSet({ keys: [publicJwk] }),
  });
});

interface TokenOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiresIn?: string;
  readonly roles?: readonly string[];
  readonly tenantId?: string | string[] | undefined;
  readonly key?: KeyLike;
  readonly environment?: string;
  readonly scope?: string;
}

async function mintToken(options: TokenOptions = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    realm_access: { roles: options.roles ?? ['analyst'] },
  };
  if (options.tenantId !== undefined) {
    payload['tenant_id'] = options.tenantId;
  }
  if (options.environment !== undefined) {
    payload['environment'] = options.environment;
  }
  if (options.scope !== undefined) {
    payload['scope'] = options.scope;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('user-1')
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? privateKey);
}

async function rejection(token: string | undefined): Promise<string> {
  try {
    await verifier.verify(token, 'MACHINE');
    return 'ACCEPTED';
  } catch (error) {
    return error instanceof TokenVerificationError ? error.rejection : 'UNEXPECTED_ERROR';
  }
}

describe('T03 — token validation', () => {
  it('accepts a well-formed token and derives the principal', async () => {
    const token = await mintToken({
      tenantId: 'tenant-alpha',
      roles: ['analyst'],
      scope: 'search:read search:write',
    });
    const principal = await verifier.verify(token, 'MACHINE');

    expect(principal.subject).toBe('user-1');
    expect(principal.tenantId).toBe('tenant-alpha');
    expect(principal.roles).toEqual(['analyst']);
    expect(principal.scopes).toEqual(['search:read', 'search:write']);
    // Never trusted from the token — break-glass is a persisted, revocable grant.
    expect(principal.breakGlass).toBeNull();
  });

  it('rejects a missing token', async () => {
    expect(await rejection(undefined)).toBe('MISSING');
    expect(await rejection('')).toBe('MISSING');
  });

  it('rejects a malformed token', async () => {
    expect(await rejection('not-a-jwt')).toBe('MALFORMED');
  });

  it('rejects a token signed by an unknown key', async () => {
    const forged = await mintToken({ tenantId: 'tenant-alpha', key: attackerKey });
    expect(await rejection(forged)).toBe('BAD_SIGNATURE');
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await mintToken({
      tenantId: 'tenant-alpha',
      issuer: 'https://evil.test/realms/x',
    });
    expect(await rejection(token)).toBe('WRONG_ISSUER');
  });

  it('rejects a token for the wrong audience', async () => {
    // A token minted for another service must not be replayable against this one.
    const token = await mintToken({ tenantId: 'tenant-alpha', audience: 'some-other-service' });
    expect(await rejection(token)).toBe('WRONG_AUDIENCE');
  });

  it('rejects an expired token', async () => {
    const token = await mintToken({ tenantId: 'tenant-alpha', expiresIn: '-1h' });
    expect(await rejection(token)).toBe('EXPIRED');
  });

  it('rejects an unsigned (alg: none) token', async () => {
    // The classic downgrade. Encoded by hand, because jose refuses to sign one.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
        tenant_id: 'tenant-alpha',
        realm_access: { roles: ['platform_admin'] },
      }),
    ).toString('base64url');

    const result = await rejection(`${header}.${payload}.`);
    expect(result).not.toBe('ACCEPTED');
  });

  it('T05 — rejects a token carrying no tenant claim for tenant-scoped roles', async () => {
    const token = await mintToken({ roles: ['analyst'], tenantId: undefined });
    expect(await rejection(token)).toBe('NO_TENANT_CLAIM');
  });

  it('allows a platform-only principal with no tenant claim', async () => {
    const token = await mintToken({ roles: ['platform_operator'], tenantId: undefined });
    const principal = await verifier.verify(token, 'MACHINE');
    expect(principal.tenantId).toBeNull();
    expect(principal.roles).toEqual(['platform_operator']);
  });

  it('rejects a token whose roles this service does not recognise', async () => {
    const token = await mintToken({ tenantId: 'tenant-alpha', roles: ['superuser', 'root'] });
    expect(await rejection(token)).toBe('NO_ROLES');
  });

  it('ignores unrecognised roles rather than failing when a known one is present', async () => {
    const token = await mintToken({ tenantId: 'tenant-alpha', roles: ['superuser', 'analyst'] });
    const principal = await verifier.verify(token, 'MACHINE');
    expect(principal.roles).toEqual(['analyst']);
  });

  it('accepts an array-valued tenant claim, as Keycloak emits attributes', async () => {
    const token = await mintToken({ tenantId: ['tenant-beta'] });
    const principal = await verifier.verify(token, 'MACHINE');
    expect(principal.tenantId).toBe('tenant-beta');
  });

  it('defaults an unstated environment to sandbox, never live', async () => {
    const token = await mintToken({ tenantId: 'tenant-alpha' });
    const principal = await verifier.verify(token, 'MACHINE');
    // Failing closed: an ambiguous token must not reach live data.
    expect(principal.environment).toBe('sandbox');
  });
});

describe('T09 — production startup guards', () => {
  const productionBase = {
    NODE_ENV: 'production',
    ADVERSE_SEARCH_MODE: 'live',
    MONGODB_URI: 'mongodb://db.internal:27017/adverse',
    OIDC_ISSUER: 'https://idp.example.com/realms/prod',
    OIDC_CLIENT_ID: 'panel',
    OIDC_CLIENT_SECRET: 'a-real-rotated-secret-value',
    SESSION_SECRET: 'a-real-rotated-session-secret',
    SESSION_COOKIE_SECURE: 'true',
    CORS_ORIGINS: 'https://panel.example.com',
    JOBS_QUEUE_URL: 'https://sqs.eu-west-2.amazonaws.com/123456789012/adverse-search-jobs',
  };

  it('accepts a properly configured production environment', () => {
    const config = loadConfig(productionBase);
    expect(config.isProduction).toBe(true);
    expect(config.mode).toBe('live');
  });

  it('rejects a development identity provider in production', () => {
    expect(() =>
      loadConfig({
        ...productionBase,
        OIDC_ISSUER: 'http://127.0.0.1:28080/realms/adverse-search-local',
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects a placeholder client secret in production', () => {
    expect(() =>
      loadConfig({ ...productionBase, OIDC_CLIENT_SECRET: 'local-development-only' }),
    ).toThrow(/development placeholder/);
  });

  it('rejects a placeholder session secret in production', () => {
    expect(() =>
      loadConfig({ ...productionBase, SESSION_SECRET: 'local-development-session-secret' }),
    ).toThrow(/development placeholder/);
  });

  it('rejects an insecure session cookie in production', () => {
    expect(() => loadConfig({ ...productionBase, SESSION_COOKIE_SECURE: 'false' })).toThrow(
      /must be Secure in production/,
    );
  });

  it('T55 — rejects mock mode in production, so a fixture cannot be served as a live result', () => {
    expect(() => loadConfig({ ...productionBase, ADVERSE_SEARCH_MODE: 'mock' })).toThrow(
      /never be servable as a live result/,
    );
  });

  it('T08 — rejects a wildcard CORS origin in production', () => {
    expect(() => loadConfig({ ...productionBase, CORS_ORIGINS: '*' })).toThrow(
      /wildcard origin is never permitted/,
    );
  });

  it('rejects a queue-less production configuration', () => {
    // A production API that accepts searches with no queue publishes every job into an
    // in-process array that vanishes at restart. The search is accepted and never runs, which
    // is the worst of both: the customer is told "queued" and nothing is queued.
    const withoutQueue = { ...productionBase, JOBS_QUEUE_URL: undefined };
    expect(() => loadConfig(withoutQueue)).toThrow(/JOBS_QUEUE_URL is not set/u);
  });

  it('rejects an AWS endpoint override in production', () => {
    // That override exists so the service can talk to LocalStack. In production it can only
    // mean AWS traffic is being pointed somewhere that is not AWS.
    expect(() =>
      loadConfig({ ...productionBase, AWS_ENDPOINT_URL: 'http://127.0.0.1:28566' }),
    ).toThrow(/AWS_ENDPOINT_URL is set/u);
  });

  it('rejects static AWS credentials in production', () => {
    // A long-lived access key in an environment variable is exactly what an instance or task
    // role exists to remove. If one is present, the role is not being used.
    expect(() =>
      loadConfig({
        ...productionBase,
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'a-long-lived-secret-key-value',
      }),
    ).toThrow(/Static AWS credentials are set/u);
  });

  it('permits the same development values outside production', () => {
    const config = loadConfig({
      ...productionBase,
      NODE_ENV: 'development',
      ADVERSE_SEARCH_MODE: 'mock',
      OIDC_ISSUER: 'http://127.0.0.1:28080/realms/adverse-search-local',
      OIDC_CLIENT_SECRET: 'local-development-only',
      SESSION_SECRET: 'local-development-session-secret',
      SESSION_COOKIE_SECURE: 'false',
    });

    expect(config.isProduction).toBe(false);
    expect(config.session.secure).toBe(false);
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadConfig({
        ...productionBase,
        OIDC_ISSUER: 'http://localhost:8080/realms/dev',
        OIDC_CLIENT_SECRET: 'change-me',
        SESSION_COOKIE_SECURE: 'false',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      // Fixing one at a time across three deploy cycles is how people give up and disable
      // the check.
      expect(message).toMatch(/OIDC_ISSUER/);
      expect(message).toMatch(/OIDC_CLIENT_SECRET/);
      expect(message).toMatch(/SESSION_COOKIE_SECURE/);
    }
  });
});

/**
 * T07 — signing-key rotation.
 *
 * The property that matters is not that a new key works; it is that the **old one stops
 * working**. A verifier that keeps honouring a retired key turns rotation into theatre: the
 * compromised key it was rotated away from is still a valid signing key.
 */
describe('T07 — signing-key rotation', () => {
  it('accepts the new key and rejects the retired one once rotation completes', async () => {
    const retired = await generateKeyPair('RS256');
    const current = await generateKeyPair('RS256');

    const retiredJwk: JWK = { ...(await exportJWK(retired.publicKey)), kid: 'key-1', alg: 'RS256' };
    const currentJwk: JWK = { ...(await exportJWK(current.publicKey)), kid: 'key-2', alg: 'RS256' };

    async function mintWith(key: KeyLike, kid: string): Promise<string> {
      return new SignJWT({ realm_access: { roles: ['analyst'] }, tenant_id: 'tenant-a' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setSubject('user-1')
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key);
    }

    // During overlap the provider publishes both keys, and tokens from either verify. This is
    // what makes rotation deployable without signing everybody out mid-request.
    const overlapping = new TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keyResolver: createLocalJWKSet({ keys: [retiredJwk, currentJwk] }),
    });

    await expect(
      overlapping.verify(await mintWith(retired.privateKey, 'key-1'), 'MACHINE'),
    ).resolves.toMatchObject({ subject: 'user-1' });
    await expect(
      overlapping.verify(await mintWith(current.privateKey, 'key-2'), 'MACHINE'),
    ).resolves.toMatchObject({ subject: 'user-1' });

    // After the retired key is withdrawn, a token signed with it must fail — and fail on the
    // signature, not merely because its `kid` is unknown.
    const rotated = new TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keyResolver: createLocalJWKSet({ keys: [currentJwk] }),
    });

    await expect(
      rotated.verify(await mintWith(current.privateKey, 'key-2'), 'MACHINE'),
    ).resolves.toMatchObject({ subject: 'user-1' });

    let rejected: TokenRejection | 'ACCEPTED' = 'ACCEPTED';
    try {
      await rotated.verify(await mintWith(retired.privateKey, 'key-1'), 'MACHINE');
    } catch (error) {
      rejected = error instanceof TokenVerificationError ? error.rejection : 'ACCEPTED';
    }
    expect(rejected).toBe('BAD_SIGNATURE');
  });

  it('does not accept a token whose kid matches a live key but whose signature does not', async () => {
    // The kid is a hint for key lookup, never evidence. Trusting it is how a forged token
    // signed with an attacker's key gets verified against a legitimate public key's identity.
    const forged = await new SignJWT({ realm_access: { roles: ['analyst'] } })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('user-1')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(attackerKey);

    expect(await rejection(forged)).toBe('BAD_SIGNATURE');
  });
});

/**
 * T08 — the CORS policy, asserted on the object the application actually installs.
 *
 * `credentials: true` with a reflected origin would let any site drive an authenticated
 * session. That is the one CORS mistake that matters here, so it is checked directly rather
 * than trusted to a comment in the bootstrap.
 */
describe('T08 — CORS policy', () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    ADVERSE_SEARCH_MODE: 'mock',
    MONGODB_URI: 'mongodb://127.0.0.1:28017/adverse_search',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'adverse-search-panel',
    OIDC_CLIENT_SECRET: 'test-only-secret-value',
    OIDC_AUDIENCE: AUDIENCE,
    SESSION_SECRET: 'test-only-session-secret-value',
    SESSION_COOKIE_SECURE: 'false',
  };

  it('allows only the configured origins, as a list', () => {
    const options = corsOptions(
      loadConfig({ ...base, CORS_ORIGINS: 'http://localhost:5173,https://panel.example' }),
    );

    expect(options.origin).toEqual(['http://localhost:5173', 'https://panel.example']);
    expect(options.credentials).toBe(true);
  });

  it('never reflects the request origin', () => {
    const options = corsOptions(loadConfig({ ...base, CORS_ORIGINS: 'http://localhost:5173' }));

    // `true` means "reflect whatever the caller sent", and a function could compute the same.
    // Either would make `credentials: true` unsafe.
    expect(options.origin).not.toBe(true);
    expect(options.origin).not.toBe('*');
    expect(typeof options.origin).not.toBe('function');
  });

  it('allows no browser origin at all when none is configured', () => {
    // Not "any" — a missing configuration must fail closed, or a development convenience
    // reaches production as a wildcard.
    const options = corsOptions(loadConfig({ ...base, CORS_ORIGINS: '' }));
    expect(options.origin).toBe(false);
  });

  it('exposes no header the API does not read', () => {
    const options = corsOptions(loadConfig({ ...base, CORS_ORIGINS: 'http://localhost:5173' }));
    expect(options.allowedHeaders).toEqual([
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-CSRF-Token',
    ]);
  });
});
