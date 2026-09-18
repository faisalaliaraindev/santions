/**
 * The production guard on `DISABLE_SOURCE_FOUR_EYES_FOR_TESTING`.
 *
 * The flag narrows the one control that makes a source approval mean anything, so "production
 * must not silently enable it" is not strong enough as a warning: the process refuses to start.
 * That refusal is the subject of this file, and it needs no database, which is why it is here
 * rather than beside the behavioural tests in `tests/integration/four-eyes-testing-bypass.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';

/** The smallest environment `loadConfig` accepts, with nothing that looks like a dev fixture. */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ADVERSE_SEARCH_MODE: 'mock',
    MONGODB_URI: 'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true',
    OIDC_ISSUER: 'https://issuer.example.com/realms/adverse-search',
    OIDC_CLIENT_ID: 'adverse-search-panel',
    OIDC_CLIENT_SECRET: 'a-sufficiently-long-client-secret-value',
    OIDC_AUDIENCE: 'adverse-search-api',
    SESSION_SECRET: 'a-sufficiently-long-session-secret',
    SESSION_COOKIE_SECURE: 'false',
    CORS_ORIGINS: '',
    ...overrides,
  };
}

describe('DISABLE_SOURCE_FOUR_EYES_FOR_TESTING', () => {
  it('defaults to false when the variable is absent', () => {
    expect(loadConfig(env()).disableSourceFourEyesForTesting).toBe(false);
  });

  it('is false when explicitly set to false', () => {
    expect(
      loadConfig(env({ DISABLE_SOURCE_FOUR_EYES_FOR_TESTING: 'false' }))
        .disableSourceFourEyesForTesting,
    ).toBe(false);
  });

  it('is true off production when explicitly set to true', () => {
    expect(
      loadConfig(env({ DISABLE_SOURCE_FOUR_EYES_FOR_TESTING: 'true' }))
        .disableSourceFourEyesForTesting,
    ).toBe(true);
  });

  it('refuses a value that is neither true nor false rather than guessing', () => {
    // `1`, `yes` and `on` are the three ways a flag like this is usually mis-set, and each one
    // would read as "not true" under a looser parse — which is the safe direction here, but it
    // would also silently ignore an operator who believed they had set it.
    expect(() => loadConfig(env({ DISABLE_SOURCE_FOUR_EYES_FOR_TESTING: 'yes' }))).toThrow();
    expect(() => loadConfig(env({ DISABLE_SOURCE_FOUR_EYES_FOR_TESTING: '1' }))).toThrow();
  });

  it('fails startup outright when set in production', () => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', DISABLE_SOURCE_FOUR_EYES_FOR_TESTING: 'true' })),
    ).toThrow(/DISABLE_SOURCE_FOUR_EYES_FOR_TESTING is set in production/u);
  });

  it('contributes no production complaint of its own when it is absent or false', () => {
    // A minimal production environment fails for many unrelated T09 reasons, so this asserts the
    // narrower and more useful thing: the guard is about this flag only, and a production
    // configuration that never sets it acquires no new reason to fail because of it.
    const message = (): string => {
      try {
        loadConfig(env({ NODE_ENV: 'production', DISABLE_SOURCE_FOUR_EYES_FOR_TESTING: 'false' }));
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(message()).not.toContain('DISABLE_SOURCE_FOUR_EYES_FOR_TESTING');
  });
});
