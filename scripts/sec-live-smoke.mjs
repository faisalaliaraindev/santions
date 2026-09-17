#!/usr/bin/env node
/**
 * `pnpm sec:live-smoke` — one real request to the SEC, through the real code, counted.
 *
 * # Why this exists separately from the end-to-end test
 *
 * The tenant end-to-end flow is eleven steps long, and when it fails at the SEC the failure
 * arrives wrapped in a search run, a queue message, a worker and a coverage statement. Debugging
 * that costs live requests at a publisher whose whole free tier is a hundred and twenty an hour.
 * This does the one thing the end-to-end test cannot do cheaply: it makes **one** poll and prints
 * everything about it.
 *
 * It proves six things, and prints each of them:
 *
 * 1. one real request was sent, to the address the registry records;
 * 2. a response came back, with its status and byte count;
 * 3. it parsed, as a feed, with an item count;
 * 4. items normalised into `Lead`s in our own shape;
 * 5. source health and the budget moved by the amount the request cost;
 * 6. the number of external requests made, read from the poll cache rather than assumed.
 *
 * # It is not part of any suite
 *
 * `vitest` never runs it, CI never runs it, and it will not run without `--yes-contact-the-sec`.
 * A live request that can happen because somebody typed `pnpm test` is a live request nobody
 * decided to make. It uses the same confirmation flag as `pnpm first-contact` on purpose: the two
 * are the same kind of act.
 *
 * # It runs the real composition
 *
 * `NestFactory.createApplicationContext(AppModule)` — the same DI graph the worker runs, with the
 * real `HttpEvidenceFetchAdapter`, the real `FetchGateService`, the real `SourceHealthService`
 * breaker and the real `FixedFeedPollCache`. Nothing here is a second, weaker path to the SEC. If
 * it works here and not in a search, the difference is in the pipeline, not in the connector —
 * which is exactly what makes this worth running first.
 *
 * ```
 * pnpm sec:live-smoke                        # says what it would do, sends nothing
 * pnpm sec:live-smoke --yes-contact-the-sec  # sends exactly one poll
 * ```
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_ID = 'sec-litigation-releases';

function loadEnv() {
  try {
    const content = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
      }
    }
  } catch {
    // No .env. The checks below produce the useful message.
  }
}

function dist(path) {
  return `file://${join(repoRoot, path).replaceAll('\\', '/')}`;
}

function line() {
  console.log('──────────────────────────────────────────────────────────────────────');
}

function health(record) {
  if (record === null || record === undefined) {
    return '(no record — this source has never been called)';
  }
  return (
    `breaker=${record.breaker} ` +
    `hourly=${String(record.hourly?.spent ?? 0)} ` +
    `daily=${String(record.daily?.spent ?? 0)} ` +
    `lastSuccess=${record.lastSuccessAt ?? '—'} ` +
    `lastFailure=${record.lastFailureAt ?? '—'}${record.lastFailureClass ? ` (${record.lastFailureClass})` : ''}`
  );
}

async function main() {
  loadEnv();

  if ((process.env['ADVERSE_SEARCH_MODE'] ?? '').toLowerCase() !== 'live') {
    throw new Error(
      'ADVERSE_SEARCH_MODE is not `live`, so this process builds fixture adapters and there is ' +
        'no live connector to smoke test. Set ADVERSE_SEARCH_MODE=live for this command only — ' +
        'a mock process that could reach a publisher would defeat the mode split entirely.',
    );
  }
  const contactUrl = process.env['FETCH_CONTACT_URL'];
  if (contactUrl === undefined || contactUrl.trim() === '') {
    throw new Error(
      'FETCH_CONTACT_URL is not set. FR-06 requires the user agent to identify this service ' +
        'honestly with a contact URL, and there is deliberately no default.',
    );
  }

  const confirmed = process.argv.includes('--yes-contact-the-sec');

  console.log('');
  line();
  console.log('  SEC LIVE SMOKE TEST');
  line();
  console.log(`\n  Source        ${SOURCE_ID}`);
  console.log(`  User agent    ErlyAdverseSearch/1.0 (+${contactUrl.trim()})`);
  console.log('  Requests      exactly one poll of the feed the registry records');
  console.log('  Authorised    D17, closed 2026-09-15, approved by Faisal Ali\n');

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import(dist('apps/api/dist/app.module.js'));
  const { LadderBuilder } = await import(dist('apps/api/dist/pipeline/ladder.builder.js'));
  const { FixedFeedPollCache } = await import(dist('apps/api/dist/sources/feed-poll-cache.js'));
  const { SourceHealthService } = await import(
    dist('apps/api/dist/sources/source-health.service.js')
  );
  const { SourceVersionService } = await import(
    dist('apps/api/dist/sources/source-version.service.js')
  );

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const versions = app.get(SourceVersionService);
    const version = await versions.loadActive(SOURCE_ID);
    if (version === null) {
      throw new Error(
        `${SOURCE_ID} has no ACTIVE approved version in this database, so nothing authorises a ` +
          'request to it. Take it through the D1 approval lifecycle first.',
      );
    }

    console.log(`  Endpoint      ${version.endpointUrl}`);
    console.log(`  Kind          ${version.endpointKind}`);
    console.log(
      `  Poll floor    ${version.pollFloorMs === null ? 'none recorded' : `${String(version.pollFloorMs / 1000)}s`}`,
    );
    console.log(`  Robots        ${version.robotsPosition}`);
    console.log(`  Rung          ${String(version.cascadeRung)}\n`);

    const healthService = app.get(SourceHealthService);
    const before = await healthService.get(SOURCE_ID, new Date());
    console.log(`  Health before ${health(before)}\n`);

    if (before.breaker !== 'CLOSED' && before.breaker !== 'HALF_OPEN') {
      console.log('  The breaker is not closed, so no request will be made.\n');
      console.log('  This is our own record of the source refusing us, not the SEC refusing us');
      console.log('  right now. To clear the recorded state locally and decide to try again:\n');
      console.log(`      pnpm source:health ${SOURCE_ID} --reset --reason "..."\n`);
      console.log('  SEC LIVE SMOKE TEST BLOCKED — breaker ' + before.breaker + '\n');
      process.exitCode = 1;
      return;
    }

    if (!confirmed) {
      console.log('  Nothing was sent. To make the one request:\n');
      console.log('      pnpm sec:live-smoke --yes-contact-the-sec\n');
      return;
    }

    const cache = app.get(FixedFeedPollCache);
    const requestsBefore = cache.statsFor(version.endpointUrl).requests;
    // A stored poll from earlier in this process would answer without a request, and this
    // command exists to prove a request happened.
    cache.clear();

    const ladder = await app.get(LadderBuilder).build();
    const entry = ladder.find((candidate) => candidate.sourceId === SOURCE_ID);
    if (entry === undefined) {
      throw new Error(
        `${SOURCE_ID} is approved but is not on the ladder this process built. That means no ` +
          'connector in this process serves its connector type, or the fetch adapter is absent ' +
          '(no contact URL, or no source health). The log above says which.',
      );
    }

    console.log('  Sending one request…\n');
    const startedAt = Date.now();
    const outcome = await entry.ask({
      tenantId: 'sec-live-smoke',
      run: {
        jobId: 'sec-live-smoke',
        subjectId: 'sec-live-smoke',
        jurisdictions: [...version.countries],
        languages: [...version.languages],
        taxonomy: {
          taxonomyVersionId: `sec-live-smoke:${version.sourceId}`,
          version: version.version,
          tenantId: 'sec-live-smoke',
          categories: [
            {
              category: 'FRAUD_FINANCIAL_CRIME',
              severityWeight: 1,
              enabledCountries: [...version.countries],
            },
          ],
          lexicon: [],
          languages: version.languages.map((language) => ({
            language,
            measuredRecall: null,
            measuredByEvaluationRunId: null,
          })),
          status: 'ACTIVE',
          proposedBy: 'sec-live-smoke',
          approvedBy: 'sec-live-smoke',
          activatedAt: new Date().toISOString(),
        },
      },
      queryId: 'sec-live-smoke-0001',
      // F1 is the family a fixed feed answers. An empty term matches the whole list, which is
      // what proves the parse rather than what proves anybody is in it.
      family: 'F1',
      text: '',
      language: version.languages[0] ?? null,
      country: version.countries[0] ?? null,
      window: null,
      limit: 50,
    });
    const elapsedMs = Date.now() - startedAt;

    const stats = cache.statsFor(version.endpointUrl);
    const after = await healthService.get(SOURCE_ID, new Date());

    console.log('');
    line();
    console.log('  RESULT');
    line();
    console.log(`\n  Outcome               ${outcome.status}`);
    if (outcome.status === 'FAILED') {
      console.log(`  Detail                ${outcome.detail}`);
      console.log(`  Signal                ${JSON.stringify(outcome.signal)}`);
    }
    const leads = 'data' in outcome ? outcome.data : [];
    console.log(`  Leads normalised      ${String(leads.length)}`);
    for (const lead of leads.slice(0, 3)) {
      console.log(`      ${lead.title.slice(0, 68)}`);
      console.log(`          ${lead.url}`);
      console.log(
        `          rung ${String(lead.rung)}  source ${lead.provenance.sourceId}  ` +
          `mode ${lead.provenance.mode}  published ${lead.publishedAt.value ?? '(none)'}`,
      );
    }
    if (leads.length > 3) {
      console.log(`      … and ${String(leads.length - 3)} more`);
    }
    console.log('');
    console.log(`  Elapsed               ${String(elapsedMs)}ms`);
    console.log(`  External requests     ${String(stats.requests)} for ${version.endpointUrl}`);
    console.log(
      `  Polls served          ${String(stats.served)} (${String(stats.reused)} without a request)`,
    );
    console.log(`  This process total    ${String(requestsBefore + stats.requests)}`);
    console.log('');
    console.log(`  Health before         ${health(before)}`);
    console.log(`  Health after          ${health(after)}`);
    const spent = (after.daily?.spent ?? 0) - (before.daily?.spent ?? 0);
    console.log(`  Budget moved by       ${String(spent)} (daily)`);
    console.log('');

    const passed = outcome.status !== 'FAILED' && stats.requests === 1;
    line();
    console.log(passed ? '  SEC LIVE SMOKE TEST PASSED' : '  SEC LIVE SMOKE TEST BLOCKED');
    line();
    if (!passed) {
      console.log('');
      if (stats.requests !== 1) {
        console.log(`  ${String(stats.requests)} external requests were made, not 1. That is the`);
        console.log('  amplification this command exists to detect.');
      }
      if (outcome.status === 'FAILED') {
        console.log(`  The poll failed: ${outcome.detail}`);
      }
      process.exitCode = 1;
    }
    console.log('');
  } finally {
    await app.close();
  }
}

main()
  .catch((error) => {
    console.error(`
${error.message ?? String(error)}
`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Explicit, and not a workaround for something unfinished.
    //
    // This builds the whole application context to get the *real* connector, and that graph holds
    // a Mongo client, an S3 client and an SQS client that outlive `app.close()` — those providers
    // are factories with no destroy hook, because in the API and the worker the process is meant
    // to keep running. A command that makes one request and reports on it is the opposite shape,
    // and a script that prints its answer and then hangs is one people stop reading to the end.
    // `main` has already set the exit code.
    process.exit(process.exitCode ?? 0);
  });
