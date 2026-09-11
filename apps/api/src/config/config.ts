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

  /**
   * The jobs queue. Optional, because the API can serve reads without it — but a process that
   * accepts searches with no queue configured is publishing into a variable, so the absence is
   * warned about loudly at startup rather than defaulted away quietly.
   */
  JOBS_QUEUE_URL: z.string().url().optional(),
  AWS_REGION: z.string().min(1).default('eu-west-2'),
  /** Set only when pointing at LocalStack. Absent in production. */
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** How often the outbox publisher polls. */
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),

  /**
   * The search index behind the D12 seam. `meilisearch` is a working assumption carried since
   * Phase A, not a decision — C4's measurement closes D12.
   */
  SEARCH_INDEX_KIND: z.enum(['meilisearch', 'opensearch', 'in-memory']).default('meilisearch'),
  MEILI_HOST: z.string().url().optional(),
  MEILI_MASTER_KEY: z.string().min(1).optional(),
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
  jobs: {
    queueUrl: string | null;
    region: string;
    endpoint: string | null;
    /**
     * Static credentials, for LocalStack only. Null in production, where the SDK resolves a
     * rotating role credential — an environment variable holding a long-lived key is the thing
     * that arrangement exists to avoid.
     */
    staticCredentials: { accessKeyId: string; secretAccessKey: string } | null;
    pollMs: number;
  };
  searchIndex: {
    kind: 'meilisearch' | 'opensearch' | 'in-memory';
    host: string | null;
    apiKey: string | null;
  };
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

    // The AWS endpoint override exists so the service can talk to LocalStack. In production
    // it can only mean traffic is being redirected somewhere that is not AWS.
    if (raw.AWS_ENDPOINT_URL !== undefined) {
      problems.push(
        'AWS_ENDPOINT_URL is set. That override exists for LocalStack; in production the ' +
          'endpoint must be the real AWS one, resolved by the SDK.',
      );
    }

    // A long-lived access key in an environment variable is the thing an instance or task role
    // exists to remove. If one is present, the role is not being used.
    if (raw.AWS_ACCESS_KEY_ID !== undefined || raw.AWS_SECRET_ACCESS_KEY !== undefined) {
      problems.push(
        'Static AWS credentials are set. Production must use a rotating role credential ' +
          '(instance role, task role or IRSA) resolved by the SDK credential chain.',
      );
    }

    // An in-process index in production would answer every screening query from a Map that
    // is empty at startup — which reads as "no matches found" rather than as an outage.
    if (raw.SEARCH_INDEX_KIND === 'in-memory') {
      problems.push(
        'SEARCH_INDEX_KIND=in-memory is a development stand-in. In production it would answer ' +
          'screening queries from an empty process-local map, which reads as a clean result.',
      );
    }

    if (raw.SEARCH_INDEX_KIND === 'meilisearch' && raw.MEILI_HOST === undefined) {
      problems.push('SEARCH_INDEX_KIND=meilisearch but MEILI_HOST is not set.');
    }

    if (raw.JOBS_QUEUE_URL === undefined) {
      problems.push(
        'JOBS_QUEUE_URL is not set. Without it the service would accept searches and publish ' +
          'their jobs into an in-process queue that vanishes at restart.',
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
    jobs: {
      queueUrl: raw.JOBS_QUEUE_URL ?? null,
      region: raw.AWS_REGION,
      endpoint: raw.AWS_ENDPOINT_URL ?? null,
      // Both or neither: half a credential is a confusing failure inside the SDK rather than
      // a clear one here.
      staticCredentials:
        raw.AWS_ACCESS_KEY_ID !== undefined && raw.AWS_SECRET_ACCESS_KEY !== undefined
          ? {
              accessKeyId: raw.AWS_ACCESS_KEY_ID,
              secretAccessKey: raw.AWS_SECRET_ACCESS_KEY,
            }
          : null,
      pollMs: raw.OUTBOX_POLL_MS,
    },
    searchIndex: {
      kind: raw.SEARCH_INDEX_KIND,
      host: raw.MEILI_HOST ?? null,
      apiKey: raw.MEILI_MASTER_KEY ?? null,
    },
  };
}
