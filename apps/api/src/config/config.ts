/**
 * Environment configuration, validated at startup.
 *
 * B8 lives here: **production startup fails, safely and loudly, on a development issuer, mock
 * sources, test credentials or insecure cookies** (test T09). A service that boots with a
 * development identity provider in production is a service that trusts tokens anyone can mint.
 */

import { z } from 'zod';

/**
 * An optional variable, where **an empty value means "not set"**.
 *
 * `.optional()` alone is not enough. `VAR=` in a `.env` file, a Kubernetes env entry with no
 * value, and a shell `export VAR=` all produce the empty string, not `undefined` — so a bare
 * `z.string().min(1).optional()` rejects the ordinary way people write "I am not using this
 * one" and the process refuses to start with a validation error naming a variable the operator
 * deliberately left blank.
 *
 * This was not theoretical: `COMPANIES_HOUSE_API_KEY=` is exactly how the committed
 * `.env.example` expresses "no key configured", and it stopped both the API and the worker from
 * booting. Blank is absent.
 */
function optional<T extends z.ZodTypeAny>(schema: T): z.ZodOptional<T> {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  ) as unknown as z.ZodOptional<T>;
}

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
   * **TEMPORARY, TESTING ONLY.** Allow one principal to both propose and approve a SOURCE
   * version.
   *
   * Four eyes (SEC-06) is enforced on `principal.subject`, not on role, so a deployment with
   * only one `source_admin` credential cannot take a source through `APPROVE` at all. That is
   * the correct behaviour and it is why this default is `false`: the rule exists so the record
   * the fetch gate reads names somebody who actually looked, and a bypass is a promise not kept.
   *
   * It exists because the three-source live test needs `sec-press-releases` and `gdelt-doc-v2`
   * ACTIVE, and this deployment has no second named person behind its approver credential.
   *
   * What it does **not** do: it does not remove the lifecycle, skip a permission check, skip the
   * SEC-05 rights clearance, or suppress an audit entry. Every version approved under it carries
   * an explicit bypass marker in its own history and an extra audit event, permanently, so a
   * reader can never mistake it for a real second opinion.
   *
   * Refused outright in production — see the `isProduction` block below, where setting it is a
   * startup failure rather than a warning.
   */
  DISABLE_SOURCE_FOUR_EYES_FOR_TESTING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * The jobs queue. Optional, because the API can serve reads without it — but a process that
   * accepts searches with no queue configured is publishing into a variable, so the absence is
   * warned about loudly at startup rather than defaulted away quietly.
   */
  JOBS_QUEUE_URL: optional(z.string().url()),
  AWS_REGION: z.string().min(1).default('eu-west-2'),
  /** Set only when pointing at LocalStack. Absent in production. */
  AWS_ENDPOINT_URL: optional(z.string().url()),
  AWS_ACCESS_KEY_ID: optional(z.string().min(1)),
  AWS_SECRET_ACCESS_KEY: optional(z.string().min(1)),
  /** How often the outbox publisher polls. */
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),

  /**
   * The dead-letter queue the consumer sends to when it has *decided* a message must not be
   * processed — a forged tenant, an unreadable body, an event nothing here handles. The SQS
   * redrive policy remains the backstop for everything it could not classify; this is for the
   * cases it can, where waiting five deliveries to discover what we already know is four
   * deliveries of wasted capacity and a DLQ entry with no reason attached.
   */
  JOBS_DEAD_LETTER_QUEUE_URL: optional(z.string().url()),

  /**
   * How long a worker's claim on a stage lasts before another worker may take it (REL-01).
   *
   * Short enough that a crashed worker's stage is picked up promptly; long enough that a slow
   * fetch does not lose its lease mid-request. Long jobs renew rather than taking a long lease,
   * because a long lease is also how long a crash goes unnoticed.
   */
  JOB_LEASE_MS: z.coerce.number().int().min(5_000).max(900_000).default(60_000),

  /**
   * The bound on one stage's total execution, renewals included. A renewal loop with no
   * deadline is an unbounded job wearing a lease.
   */
  JOB_MAX_EXECUTION_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(900_000),

  /**
   * Deliveries after which the consumer dead-letters a message outright. Must match the
   * redrive policy's `maxReceiveCount` in `scripts/bootstrap/aws.mjs`.
   */
  JOB_MAX_DELIVERIES: z.coerce.number().int().min(2).max(20).default(5),

  /**
   * The evidence bucket. Optional here and required in production by the guard below, so a
   * developer with no LocalStack gets the in-process store rather than a startup crash.
   */
  S3_EVIDENCE_BUCKET: optional(z.string().min(1)),
  OBJECT_STORE_KIND: z.enum(['s3', 'in-memory']).default('s3'),

  /**
   * The search index behind the D12 seam. `meilisearch` is a working assumption carried since
   * Phase A, not a decision — C4's measurement closes D12.
   */
  SEARCH_INDEX_KIND: z.enum(['meilisearch', 'opensearch', 'in-memory']).default('meilisearch'),
  MEILI_HOST: optional(z.string().url()),
  MEILI_MASTER_KEY: optional(z.string().min(1)),

  /**
   * The free Companies House API key (Phase D step D2).
   *
   * Optional, and absent is a supported state rather than a misconfiguration: without it the
   * GB company-registry adapter is not constructed at all, which is deliberately different
   * from constructing one that 401s on every call. The first makes the capability visibly
   * unavailable; the second produces a coverage gap that looks like an outage at Companies
   * House — a gap somebody would then go and investigate at the wrong end.
   *
   * The value lives here, never in the source registry: SEC-04 has the registry store a
   * `credentialsRef` and nothing more.
   */
  COMPANIES_HOUSE_API_KEY: optional(z.string().min(1)),

  /** World Bank sanctioned-firm gateway key. Registry versions store only this secret's ref. */
  WORLD_BANK_SANCTIONS_API_KEY: optional(z.string().min(1)),

  /**
   * The contact URL the outbound user agent carries (FR-06).
   *
   * "The user agent identifies the service honestly with a contact URL." There is deliberately
   * no default: a default would be a URL nobody reads, on a host nobody owns, and a publisher
   * who wanted us to stop would have nowhere to write. Without it the live fetch adapter is not
   * constructed at all, which is the honest failure — the alternative is a polite-looking lie
   * attached to every request this service makes.
   */
  FETCH_CONTACT_URL: optional(z.string().url()),

  /**
   * Where a customer's browser reaches the control panel, used to build the links in
   * verification and password-reset emails (I2).
   *
   * Optional, and absent it is not defaulted to a guess. An email carrying a link to the wrong
   * host is worse than one carrying the token and the endpoint to send it to, which is what the
   * message says instead. Deliberately **not** derived from `CORS_ORIGINS`: that list says who
   * may call this API, which is a different question from where the customer's interface lives.
   */
  PUBLIC_APP_URL: optional(z.string().url()),

  /**
   * The self-hosted SearXNG instance the rung-5 discovery connector queries.
   *
   * Optional, and absent is a supported state rather than a misconfiguration: without it the
   * connector is not constructed and the rung reports as unsearched, which is true. There is
   * deliberately **no default**. A default would point the connector at a loopback port nobody
   * deployed, and the resulting `ECONNREFUSED` would read as "the discovery layer is down"
   * rather than as "no discovery layer is configured" — the same distinction
   * `FETCH_CONTACT_URL` is defaulted away from, for the same reason.
   *
   * It is validated further by `validateSearxngBaseUrl`, which refuses a URL carrying a path,
   * a query or credentials. This schema only establishes that it is a URL at all; the narrower
   * rule lives beside the client that enforces it.
   *
   * Note what is NOT checked here: that the host is public. It is expected to be loopback or a
   * private service address, which is the one shape the SEC-02 policy refuses for discovered
   * URLs — see the client's header for why that is the right asymmetry rather than a hole.
   */
  SEARXNG_URL: optional(z.string().url()),

  /**
   * **LOCAL DIAGNOSTIC ONLY.** Lets one named tenant run `GOOGLE_NEWS` on a single LIVE search
   * that carries `X-Local-Discovery-Diagnostic: GOOGLE_NEWS`, against a loopback process.
   *
   * It changes no engine setting and no governance reading — see
   * `sources/searxng/local-diagnostic.ts` for every condition. Refused outright in production:
   * setting it there is a startup failure, like the four-eyes bypass.
   */
  ALLOW_LOCAL_GOOGLE_DIAGNOSTIC: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** The one tenant the local Google diagnostic may run for. Unset permits nobody. */
  GOOGLE_DIAGNOSTIC_TENANT_ID: optional(z.string().min(1)),
});

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  mode: 'mock' | 'live';
  port: number;
  /**
   * **TEMPORARY, TESTING ONLY.** True when one principal may both propose and approve a SOURCE
   * version. Always false in production, where setting the flag fails startup.
   */
  disableSourceFourEyesForTesting: boolean;
  /**
   * **LOCAL DIAGNOSTIC ONLY.** The process half of the local Google diagnostic's conditions.
   * `allowLocalGoogleDiagnostic` is always false in production, where setting it fails startup.
   */
  localGoogleDiagnostic: {
    isProduction: boolean;
    allowLocalGoogleDiagnostic: boolean;
    googleDiagnosticTenantId: string | null;
  };
  mongodbUri: string;
  oidc: { issuer: string; clientId: string; clientSecret: string; audience: string };
  session: { secret: string; secure: boolean };
  /** Base URL for links sent to customers by email. Null when none is configured. */
  publicAppUrl: string | null;
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
    deadLetterQueueUrl: string | null;
    leaseMs: number;
    maxExecutionMs: number;
    maxDeliveries: number;
  };
  storage: {
    kind: 's3' | 'in-memory';
    bucket: string | null;
    region: string;
    endpoint: string | null;
    /** As `jobs.staticCredentials`, and null in production for the same reason. */
    staticCredentials: { accessKeyId: string; secretAccessKey: string } | null;
  };
  searchIndex: {
    kind: 'meilisearch' | 'opensearch' | 'in-memory';
    host: string | null;
    apiKey: string | null;
  };
  sources: {
    /** Null when no key is configured. See `COMPANIES_HOUSE_API_KEY` for why that is fine. */
    companiesHouseApiKey: string | null;
    /** Null keeps the World Bank source configured but mechanically unable to contact its API. */
    worldBankSanctionsApiKey: string | null;
    /** Null when unset, which leaves the live fetch adapter unconstructed. See FR-06. */
    fetchContactUrl: string | null;
    /**
     * The SearXNG base URL, or null when none is configured.
     *
     * Null leaves the rung-5 connector unconstructed and the rung reporting as unsearched. It is
     * not a fallback to anything.
     */
    searxngUrl: string | null;
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
    // A four-eyes bypass in production is not a misconfiguration to warn about — it is the
    // control that makes every source approval meaningful, switched off. The process refuses to
    // start rather than run with it, because "production must not silently enable it" is only
    // true if production cannot enable it at all.
    if (raw.DISABLE_SOURCE_FOUR_EYES_FOR_TESTING) {
      problems.push(
        'DISABLE_SOURCE_FOUR_EYES_FOR_TESTING is set in production. It is a testing-only flag ' +
          'that lets one principal both propose and approve a source version, and it must never ' +
          'be set outside a local or test deployment. Unset it.',
      );
    }
    // The local Google diagnostic runs an engine D20 refused. It exists for a developer's
    // loopback process and nowhere else, so production cannot enable it at all.
    if (raw.ALLOW_LOCAL_GOOGLE_DIAGNOSTIC) {
      problems.push(
        'ALLOW_LOCAL_GOOGLE_DIAGNOSTIC is set in production. It is a local-development ' +
          'diagnostic that runs GOOGLE_NEWS, which D20 refused, and it must never be set ' +
          'outside a local deployment. Unset it.',
      );
    }

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

    // An in-process object store in production would accept evidence, verify it against
    // itself, and lose every byte at restart — while the committed references survive. That is
    // a bucket full of dangling successes, which is the one thing FI-03 exists to prevent.
    if (raw.OBJECT_STORE_KIND === 'in-memory') {
      problems.push(
        'OBJECT_STORE_KIND=in-memory is a development stand-in. In production it would hold ' +
          'evidence in process memory and lose it at restart, leaving committed references ' +
          'pointing at nothing (FI-03).',
      );
    }

    if (raw.OBJECT_STORE_KIND === 's3' && raw.S3_EVIDENCE_BUCKET === undefined) {
      problems.push('OBJECT_STORE_KIND=s3 but S3_EVIDENCE_BUCKET is not set.');
    }

    if (raw.JOBS_QUEUE_URL === undefined) {
      problems.push(
        'JOBS_QUEUE_URL is not set. Without it the service would accept searches and publish ' +
          'their jobs into an in-process queue that vanishes at restart.',
      );
    }

    if (raw.JOBS_DEAD_LETTER_QUEUE_URL === undefined) {
      problems.push(
        'JOBS_DEAD_LETTER_QUEUE_URL is not set. Without it, a message this service decides ' +
          'must never be processed — a forged tenant, an unreadable body — would be held in ' +
          'process memory and lost at restart, destroying the evidence of a producer bug or ' +
          'an attempted cross-tenant crossing.',
      );
    }

    if (raw.JOB_MAX_EXECUTION_MS <= raw.JOB_LEASE_MS) {
      problems.push(
        'JOB_MAX_EXECUTION_MS must exceed JOB_LEASE_MS. A stage whose execution bound is ' +
          'shorter than one lease can never renew, so every long job is abandoned at its ' +
          'first heartbeat rather than completing.',
      );
    }

    // A placeholder here is not a cosmetic problem: FR-06 classifies a 401 from a free source
    // as AUTH_CREDENTIAL, which is never retried and alerts an operator. A development
    // placeholder in production would therefore present as "Companies House revoked our key".
    if (raw.COMPANIES_HOUSE_API_KEY !== undefined) {
      const marker = looksLikeDevelopmentValue(raw.COMPANIES_HOUSE_API_KEY);
      if (marker !== null) {
        problems.push(
          `COMPANIES_HOUSE_API_KEY is a development placeholder (contains "${marker}").`,
        );
      }
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
    // Belt and braces: production already failed above, so this can only be true off production.
    disableSourceFourEyesForTesting: !isProduction && raw.DISABLE_SOURCE_FOUR_EYES_FOR_TESTING,
    localGoogleDiagnostic: {
      isProduction,
      // Belt and braces, as above.
      allowLocalGoogleDiagnostic: !isProduction && raw.ALLOW_LOCAL_GOOGLE_DIAGNOSTIC,
      googleDiagnosticTenantId: raw.GOOGLE_DIAGNOSTIC_TENANT_ID ?? null,
    },
    mongodbUri: raw.MONGODB_URI,
    oidc: {
      issuer: raw.OIDC_ISSUER,
      clientId: raw.OIDC_CLIENT_ID,
      clientSecret: raw.OIDC_CLIENT_SECRET,
      audience: raw.OIDC_AUDIENCE,
    },
    session: { secret: raw.SESSION_SECRET, secure: raw.SESSION_COOKIE_SECURE },
    publicAppUrl: raw.PUBLIC_APP_URL ?? null,
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
      deadLetterQueueUrl: raw.JOBS_DEAD_LETTER_QUEUE_URL ?? null,
      leaseMs: raw.JOB_LEASE_MS,
      maxExecutionMs: raw.JOB_MAX_EXECUTION_MS,
      maxDeliveries: raw.JOB_MAX_DELIVERIES,
    },
    storage: {
      kind: raw.OBJECT_STORE_KIND,
      bucket: raw.S3_EVIDENCE_BUCKET ?? null,
      region: raw.AWS_REGION,
      endpoint: raw.AWS_ENDPOINT_URL ?? null,
      staticCredentials:
        raw.AWS_ACCESS_KEY_ID !== undefined && raw.AWS_SECRET_ACCESS_KEY !== undefined
          ? {
              accessKeyId: raw.AWS_ACCESS_KEY_ID,
              secretAccessKey: raw.AWS_SECRET_ACCESS_KEY,
            }
          : null,
    },
    searchIndex: {
      kind: raw.SEARCH_INDEX_KIND,
      host: raw.MEILI_HOST ?? null,
      apiKey: raw.MEILI_MASTER_KEY ?? null,
    },
    sources: {
      companiesHouseApiKey: raw.COMPANIES_HOUSE_API_KEY ?? null,
      worldBankSanctionsApiKey: raw.WORLD_BANK_SANCTIONS_API_KEY ?? null,
      fetchContactUrl: raw.FETCH_CONTACT_URL ?? null,
      searxngUrl: raw.SEARXNG_URL ?? null,
    },
  };
}
