/**
 * C4 — the matcher-latency workload test that closes D12.
 *
 * Run: `pnpm bench:search-index` (after `pnpm local:up && pnpm local:bootstrap`).
 *
 * **What this measures and why it is shaped this way.**
 *
 * D-002 requires three latencies, measured separately: matcher latency against the index, API
 * acceptance latency, and total search latency. It also names the condition that would select
 * OpenSearch — "if the matcher needs custom analysers or multi-field boolean scoring that
 * Meilisearch cannot express". So latency alone cannot close this decision. An index that is
 * fast and cannot retrieve the right candidate is not the cheaper option; it is the wrong one.
 * Every latency here therefore travels with a **recall@k figure broken down by FR-08 name
 * form**, and the decision is written against both.
 *
 * Two retrieval strategies are measured, because they are the two ways the matcher could be
 * built and they cost very differently:
 *
 * - **naive** — one query, the raw name as typed. What a caller does before anyone thinks about
 *   name forms.
 * - **expanded** — the FR-08 forms issued as separate queries (folded, sorted core key,
 *   phonetic keys) and unioned. This is what the matcher actually needs, and on an index that
 *   cannot express a multi-field boolean in one request it costs one round trip per form. That
 *   cost *is* the D12 question, stated as a number.
 *
 * A third probe, **multi-search**, issues the same expanded forms in a single HTTP request
 * using Meilisearch's own batch endpoint. It deliberately bypasses `SearchIndexPort`, which has
 * no batch method today. It is measured so the comparison is fair: penalising Meilisearch for a
 * limitation of our port, and then switching index because of it, would be closing D12 on our
 * own code rather than on the candidates.
 *
 * Percentiles, not means — see `packages/evaluation/src/workload/stats.ts` for why.
 *
 * The benchmark writes `docs/measurements/c4-search-index.json` and prints a table. It is an
 * operator tool, not a gate: it needs the local stack and it must not run in CI, where a shared
 * runner's timings would be recorded as evidence.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import process from 'node:process';

import {
  generateWorkloadPopulation,
  summarise,
  recallOf,
  QUERY_CLASSES,
} from '../../packages/evaluation/dist/index.js';
import {
  normaliseName,
  phoneticKeys,
  matchAcrossScripts,
  identityTransliteration,
} from '../../packages/domain/dist/index.js';

import { MeilisearchAdapter } from '../../apps/api/dist/search-index/meilisearch.adapter.js';

// ---- options --------------------------------------------------------------------------------

function options() {
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/u, '').split('=');
    args.set(key, value ?? 'true');
  }
  return {
    sizes: (args.get('sizes') ?? '1000,10000,100000').split(',').map((n) => Number(n.trim())),
    seed: Number(args.get('seed') ?? '20260911'),
    limit: Number(args.get('limit') ?? '25'),
    repeats: Number(args.get('repeats') ?? '10'),
    host: process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700',
    key: process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me',
    out: args.get('out') ?? 'docs/measurements/c4-search-index.json',
  };
}

const log = {
  step: (m) => console.log(`\n[1m${m}[0m`),
  info: (m) => console.log(`  ${m}`),
  warn: (m) => console.log(`  [33m! ${m}[0m`),
};

// ---- the FR-08 expansion the matcher would issue ---------------------------------------------

/**
 * The query forms a name expands into.
 *
 * This is the matcher's blocking strategy expressed as index queries: the folded form, the
 * word-order-independent core key, and the phonetic keys. Transliteration is included through
 * the port so the shape is right — see the caveat recorded for the TRANSLITERATION class, which
 * is currently measuring a missing provider rather than a missing index feature.
 */
function expansionOf(text) {
  const forms = new Set();
  for (const romanisation of identityTransliteration.romanisations(text)) {
    const normalised = normaliseName(romanisation);
    if (normalised.folded !== '') {
      forms.add(normalised.folded);
    }
    if (normalised.sortedCoreKey !== '' && normalised.sortedCoreKey !== normalised.folded) {
      forms.add(normalised.sortedCoreKey);
    }
    const phonetic = phoneticKeys(normalised).join(' ');
    if (phonetic !== '') {
      forms.add(phonetic);
    }
  }
  return [...forms];
}

// ---- retrieval strategies --------------------------------------------------------------------

async function retrieveNaive(index, tenantId, query, limit) {
  return index.searchSubjects({ tenantId, text: query.text, limit });
}

async function retrieveExpanded(index, tenantId, query, limit) {
  const seen = new Map();
  for (const form of expansionOf(query.text)) {
    for (const hit of await index.searchSubjects({ tenantId, text: form, limit })) {
      if (!seen.has(hit.document.subjectVersionId)) {
        seen.set(hit.document.subjectVersionId, hit);
      }
    }
  }
  return [...seen.values()];
}

/**
 * The same expansion in one round trip, through the port's batch method.
 *
 * This probe used to call Meilisearch's `/multi-search` endpoint directly, because
 * `SearchIndexPort` had no batch method — the measurement is what established that it needed
 * one (C4). Now that `searchSubjectsBatch` exists, the benchmark measures the shipped code
 * path: a decision record citing numbers from a probe that is not the production path would be
 * citing something nobody runs.
 */
async function retrieveBatched(index, tenantId, query, limit) {
  const forms = expansionOf(query.text);
  if (forms.length === 0) {
    return [];
  }
  const results = await index.searchSubjectsBatch(forms.map((text) => ({ tenantId, text, limit })));
  const seen = new Map();
  for (const result of results) {
    for (const hit of result) {
      if (!seen.has(hit.document.subjectVersionId)) {
        seen.set(hit.document.subjectVersionId, hit);
      }
    }
  }
  return [...seen.values()];
}

// ---- the in-process half of the matcher -------------------------------------------------------

/**
 * What the matcher does with the candidates the index returned.
 *
 * Measured separately from retrieval so the index's contribution is attributable. If comparison
 * dominates, the index choice is not the lever and D12 should say so rather than pretend the
 * measurement favoured one candidate.
 */
function compareCandidates(query, hits) {
  const subject = normaliseName(query.text);
  let best = 'NO_MATCH';
  for (const hit of hits) {
    const candidate = normaliseName(hit.document.nameOriginal);
    const match = matchAcrossScripts(subject, candidate, identityTransliteration);
    if (match.form !== 'NO_MATCH') {
      best = match.form;
    }
  }
  return best;
}

// ---- indexing ---------------------------------------------------------------------------------

async function loadPopulation(index, population) {
  const BATCH = 5000;
  const started = performance.now();
  for (let i = 0; i < population.subjects.length; i += BATCH) {
    const batch = population.subjects.slice(i, i + BATCH);
    const outcome = await index.upsertSubjects(batch);
    if (outcome.failed.length > 0) {
      throw new Error(`Indexing failed: ${outcome.failed[0].reason}`);
    }
  }
  return performance.now() - started;
}

// ---- measurement -------------------------------------------------------------------------------

async function measureStrategy(name, retrieve, queries, repeats) {
  const retrieval = [];
  const comparison = [];
  const combined = [];
  const outcomes = new Map(QUERY_CLASSES.map((c) => [c, []]));
  const hitCounts = [];

  // One untimed pass: the first query against a cold index measures page-cache behaviour, not
  // the index. Reporting it as the p99 would be reporting a warm-up.
  for (const query of queries) {
    await retrieve(query);
  }

  for (let round = 0; round < repeats; round += 1) {
    for (const query of queries) {
      const t0 = performance.now();
      const hits = await retrieve(query);
      const t1 = performance.now();
      compareCandidates(query, hits);
      const t2 = performance.now();

      retrieval.push(t1 - t0);
      comparison.push(t2 - t1);
      combined.push(t2 - t0);

      if (round === 0) {
        hitCounts.push(hits.length);
        const found = hits.some(
          (h) => h.document.subjectVersionId === query.expectedSubjectVersionId,
        );
        outcomes.get(query.class).push(found);
      }
    }
  }

  const recallByClass = {};
  for (const cls of QUERY_CLASSES) {
    recallByClass[cls] = recallOf(outcomes.get(cls));
  }
  const all = [...outcomes.values()].flat();

  return {
    strategy: name,
    retrieval: summarise(retrieval),
    comparison: summarise(comparison),
    matcherTotal: summarise(combined),
    candidatesPerQuery: summarise(hitCounts),
    recallByClass,
    recallOverall: recallOf(all),
  };
}

// ---- API acceptance ------------------------------------------------------------------------------

/**
 * `POST /v1/searches` end to end, over a real loopback HTTP request.
 *
 * Booted the way the security suite boots it — the real AppModule against the real Mongo, with
 * one override for JWKS so the measurement does not include a network fetch to Keycloak on
 * every request. Everything the request path does, including the transaction, the audit write,
 * the outbox write and the post-commit index write, is the real thing, because those are what
 * acceptance latency *is*.
 */
async function measureApiAcceptance({ repeats, indexKind }) {
  const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = await import('jose');
  const { Test } = await import('@nestjs/testing');
  const { VersioningType } = await import('@nestjs/common');
  const request = (await import('supertest')).default;

  const { AppModule, APP_CONFIG, MONGO_CLIENT } = await import('../../apps/api/dist/app.module.js');
  const { TokenVerifier } = await import('../../apps/api/dist/auth/token-verifier.js');
  const { loadConfig } = await import('../../apps/api/dist/config/config.js');

  const issuer = 'https://issuer.test/realms/adverse-search';
  const audience = 'adverse-search-api';
  const pair = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'bench-key', alg: 'RS256' };

  const env = {
    NODE_ENV: 'test',
    ADVERSE_SEARCH_MODE: 'mock',
    MONGODB_URI:
      process.env['MONGODB_URI'] ??
      'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true',
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'adverse-search-panel',
    OIDC_CLIENT_SECRET: 'bench-only-secret-value',
    OIDC_AUDIENCE: audience,
    SESSION_SECRET: 'bench-only-session-secret-value',
    SESSION_COOKIE_SECURE: 'false',
    CORS_ORIGINS: '',
    SEARCH_INDEX_KIND: indexKind,
    MEILI_HOST: process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700',
    MEILI_MASTER_KEY: process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me',
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig(env))
    .overrideProvider(TokenVerifier)
    .useValue(
      new TokenVerifier({
        issuer,
        audience,
        keyResolver: createLocalJWKSet({ keys: [publicJwk] }),
      }),
    )
    .compile();

  const app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });
  await app.init();

  const token = await new SignJWT({
    realm_access: { roles: ['analyst'] },
    environment: 'sandbox',
    scope: 'search:read search:write',
    // The tenant `pnpm local:bootstrap` seeds, with an active entitlement, a taxonomy version
    // and a policy version. Inventing a tenant here fails on a missing entitlement — and a
    // benchmark that measures the latency of a 403 is measuring the error path.
    tenant_id: 'tenant-alpha',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'bench-key' })
    .setSubject('bench-user')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(pair.privateKey);

  const server = app.getHttpServer();
  const subjectCreate = [];
  const searchAccept = [];
  const names = generateWorkloadPopulation({ size: 64, seed: 7 }).subjects;

  try {
    for (let i = 0; i < repeats; i += 1) {
      const name = names[i % names.length].nameOriginal;

      const t0 = performance.now();
      const subject = await request(server)
        .post('/v1/subjects')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: name,
          aliases: [],
          countryContext: ['GB'],
          knownCompanies: [],
          purpose: 'CUSTOMER_ONBOARDING',
        });
      const t1 = performance.now();
      if (subject.status !== 201) {
        throw new Error(
          `POST /v1/subjects returned ${subject.status}: ${JSON.stringify(subject.body)}`,
        );
      }
      subjectCreate.push(t1 - t0);

      const t2 = performance.now();
      const search = await request(server)
        .post('/v1/searches')
        .set('Authorization', `Bearer ${token}`)
        .send({
          subjectRef: { subjectId: subject.body.subjectId, version: subject.body.version },
          requestedScope: {
            jurisdictions: ['GB'],
            languages: ['en'],
            includeFormerDirectorships: false,
            fromDate: null,
          },
          environment: 'sandbox',
        });
      const t3 = performance.now();
      if (search.status !== 202) {
        throw new Error(
          `POST /v1/searches returned ${search.status}: ${JSON.stringify(search.body)}`,
        );
      }
      searchAccept.push(t3 - t2);
    }
  } finally {
    await app.close();
    try {
      await app.get(MONGO_CLIENT).close();
    } catch {
      // Already closed with the app.
    }
  }

  return {
    indexKind,
    subjectCreate: summarise(subjectCreate),
    searchAccept: summarise(searchAccept),
  };
}

// ---- reporting -----------------------------------------------------------------------------------

const ms = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}ms` : '—');
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : 'n/a');

function printStrategy(result) {
  log.info(
    `${result.strategy.padEnd(13)} retrieval p50 ${ms(result.retrieval.p50).padStart(9)}  ` +
      `p95 ${ms(result.retrieval.p95).padStart(9)}  p99 ${ms(result.retrieval.p99).padStart(9)}  ` +
      `| compare p95 ${ms(result.comparison.p95).padStart(8)}  ` +
      `| matcher p95 ${ms(result.matcherTotal.p95).padStart(9)}  ` +
      `| recall ${pct(result.recallOverall.recall)}`,
  );
}

function printRecall(result) {
  const parts = QUERY_CLASSES.map((cls) => {
    const r = result.recallByClass[cls];
    return `${cls}=${pct(r.recall)}(${r.found}/${r.attempted})`;
  });
  log.info(`${result.strategy.padEnd(13)} ${parts.join('  ')}`);
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  const opts = options();
  log.step('C4 — search-index workload test (closes D12)');
  log.info(`index: meilisearch @ ${opts.host}`);
  log.info(
    `sizes: ${opts.sizes.join(', ')} · seed ${opts.seed} · k=${opts.limit} · repeats ${opts.repeats}`,
  );

  const index = new MeilisearchAdapter({
    host: opts.host,
    apiKey: opts.key,
    taskTimeoutMs: 120_000,
  });
  if (!(await index.healthy())) {
    throw new Error(
      `Meilisearch is not reachable at ${opts.host}.\nStart the stack with:\n  pnpm local:up && pnpm local:bootstrap`,
    );
  }

  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: (await import('node:os')).cpus().length,
    index: { kind: index.kind, host: opts.host },
    parameters: { seed: opts.seed, limit: opts.limit, repeats: opts.repeats },
    sizes: [],
    api: null,
  };

  for (const size of opts.sizes) {
    log.step(`Population: ${size.toLocaleString('en-GB')} subjects`);
    const population = generateWorkloadPopulation({
      size,
      seed: opts.seed,
      tenantId: `workload-${size}`,
    });

    // A previous run's population for this size would double the haystack and halve the
    // meaning of every number below.
    await index.purgeTenant(population.tenantId);
    const loadMs = await loadPopulation(index, population);
    log.info(
      `indexed ${population.size.toLocaleString('en-GB')} subjects in ${(loadMs / 1000).toFixed(1)}s ` +
        `(${Math.round(population.size / (loadMs / 1000)).toLocaleString('en-GB')}/s) · ` +
        `${population.queries.length} queries`,
    );

    const strategies = [
      await measureStrategy(
        'naive',
        (q) => retrieveNaive(index, population.tenantId, q, opts.limit),
        population.queries,
        opts.repeats,
      ),
      await measureStrategy(
        'expanded',
        (q) => retrieveExpanded(index, population.tenantId, q, opts.limit),
        population.queries,
        opts.repeats,
      ),
      await measureStrategy(
        'batched',
        (q) => retrieveBatched(index, population.tenantId, q, opts.limit),
        population.queries,
        opts.repeats,
      ),
    ];

    log.info('');
    for (const result of strategies) {
      printStrategy(result);
    }
    log.info('');
    log.info('recall@k by FR-08 name form:');
    for (const result of strategies) {
      printRecall(result);
    }

    report.sizes.push({
      size: population.size,
      tenantId: population.tenantId,
      queries: population.queries.length,
      indexLoadMs: loadMs,
      strategies,
    });
  }

  log.step('API acceptance latency (POST /v1/subjects, POST /v1/searches)');
  // Measured against both index kinds, because `SearchesService.create` writes to the index
  // after the commit and the adapter waits for the write to become searchable. Running the
  // same path with the in-process index attributes that wait precisely, instead of leaving a
  // large acceptance latency sitting in the report with no owner. The difference between the
  // two rows *is* the index's contribution to acceptance.
  report.api = {};
  for (const kind of ['in-memory', 'meilisearch']) {
    try {
      const measured = await measureApiAcceptance({
        repeats: Math.max(opts.repeats, 20),
        indexKind: kind,
      });
      report.api[kind] = measured;
      log.info(
        `[${kind.padEnd(12)}] POST /v1/subjects  p50 ${ms(measured.subjectCreate.p50).padStart(9)}  p95 ${ms(measured.subjectCreate.p95).padStart(9)}  p99 ${ms(measured.subjectCreate.p99).padStart(9)}`,
      );
      log.info(
        `[${kind.padEnd(12)}] POST /v1/searches  p50 ${ms(measured.searchAccept.p50).padStart(9)}  p95 ${ms(measured.searchAccept.p95).padStart(9)}  p99 ${ms(measured.searchAccept.p99).padStart(9)}`,
      );
    } catch (error) {
      // A failure here must not discard the index measurement that already ran, but it must be
      // recorded as a failure rather than as an absent section.
      log.warn(`API acceptance measurement failed for ${kind}: ${String(error)}`);
      report.api[kind] = { error: String(error) };
    }
  }

  const outPath = path.resolve(opts.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  log.step(`Report written to ${opts.out}`);
}

main().catch((error) => {
  console.error(`\n${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
