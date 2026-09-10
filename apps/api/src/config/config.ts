/**
 * Environment configuration, validated at startup.
 *
 * B8 lives here: **production startup fails, safely and loudly, on a development issuer, mock
 * sources, test credentials or insecure cookies** (test T09). A service that boots with a
 * development identity provider in production is a service that trusts tokens anyone can mint.
 */

import { z } from 'zod';

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ADVERSE_SEARCH_MODE: z.enum(['mock', 'live']).default('mock'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  MONGODB_URI: z.string().min(1),

  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  /** The audience this API requires in an access token. */
  OIDC_AUDIENCE: z.string().min(1).default('adverse-search-api'),

  SESSION_SECRET: z.string().min(16),
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** Comma-separated allowlist. Never `*` in production. */
  CORS_ORIGINS: z.string().default(''),
});

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  mode: 'mock' | 'live';
  port: number;
  mongodbUri: string;
  oidc: { issuer: string; clientId: string; clientSecret: string; audience: string };
  session: { secret: string; secure: boolean };
  corsOrigins: readonly string[];
}>;

/**
 * Signals that a configuration value is a development fixture. Deliberately broad: a false
 * positive costs a rename, a false negative ships a test credential to production.
 */
const DEVELOPMENT_MARKERS = [
  'local-development',
  'localhost',
  '127.0.0.1',
  'change-me',
  'changeme',
  'test-secret',
  'example.test',
];

function looksLikeDevelopmentValue(value: string): string | null {
  const lowered = value.toLowerCase();
  return DEVELOPMENT_MARKERS.find((marker) => lowered.includes(marker)) ?? null;
}

export class ConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(
      [
        'Startup configuration is not safe for this environment:',
        ...problems.map((p) => `  - ${p}`),
        '',
        'Fix the configuration. Do not relax these checks — they exist so a development',
        'identity provider or a seeded credential cannot reach production (test T09).',
      ].join('\n'),
    );
    this.name = 'ConfigurationError';
  }
}

/**
 * Parse and validate. Pure apart from reading the passed object, so it is directly testable
 * without spawning a process.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }

  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === 'production';
  const problems: string[] = [];

  if (isProduction) {
    // T09 — each of these is a separate way a development fixture reaches production.
    const issuerMarker = looksLikeDevelopmentValue(raw.OIDC_ISSUER);
    if (issuerMarker !== null) {
      problems.push(
        `OIDC_ISSUER looks like a development provider (contains "${issuerMarker}"). Production must federate with a real identity provider.`,
      );
    }

    const secretMarker = looksLikeDevelopmentValue(raw.OIDC_CLIENT_SECRET);
    if (secretMarker !== null) {
      problems.push(
        `OIDC_CLIENT_SECRET is a development placeholder (contains "${secretMarker}").`,
      );
    }

    const sessionMarker = looksLikeDevelopmentValue(raw.SESSION_SECRET);
    if (sessionMarker !== null) {
      problems.push(`SESSION_SECRET is a development placeholder (contains "${sessionMarker}").`);
    }

    if (!raw.SESSION_COOKIE_SECURE) {
      problems.push(
        'SESSION_COOKIE_SECURE=false. The session cookie must be Secure in production; the loopback-only HTTP setting is development-only.',
      );
    }

    if (!raw.OIDC_ISSUER.startsWith('https://')) {
      problems.push('OIDC_ISSUER must be https in production.');
    }

    if (raw.ADVERSE_SEARCH_MODE === 'mock') {
      problems.push(
        'ADVERSE_SEARCH_MODE=mock in production. Fixture data must never be servable as a live result (test T55).',
      );
    }

    if (raw.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')) {
      problems.push(
        'CORS_ORIGINS contains "*". A wildcard origin is never permitted in production.',
      );
    }
  }

  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    isProduction,
    mode: raw.ADVERSE_SEARCH_MODE,
    port: raw.PORT,
    mongodbUri: raw.MONGODB_URI,
    oidc: {
      issuer: raw.OIDC_ISSUER,
      clientId: raw.OIDC_CLIENT_ID,
      clientSecret: raw.OIDC_CLIENT_SECRET,
      audience: raw.OIDC_AUDIENCE,
    },
    session: { secret: raw.SESSION_SECRET, secure: raw.SESSION_COOKIE_SECURE },
    corsOrigins: raw.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o !== ''),
  };
}
