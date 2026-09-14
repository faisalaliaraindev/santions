#!/usr/bin/env node
/**
 * `pnpm demo:api` — an end-to-end walkthrough over the real HTTP API.
 *
 * This is the integration path, not a shortcut around it. It issues a **machine API key** and
 * then does everything a calling application does: create a subject, submit a search, poll for
 * completion, read the findings and read the association graph. Nothing here reaches into the
 * database to fake a step, because a demo that bypasses the API proves nothing about the API.
 *
 * The search really executes: the run is committed with an outbox event, the publisher moves it
 * to the queue, the worker leases it, and the pipeline runs. If the worker is not running, the
 * search stays `QUEUED` and this script says so rather than pretending.
 *
 * # What this demonstrates, and what it does not
 *
 * Every source is a **fixture**. `ADVERSE_SEARCH_MODE=mock` means no live source is contacted —
 * not one, ever, by this project — and every record produced carries `mode: "MOCK"`. What is
 * being demonstrated is the *pipeline and the contract*: that a search resolves associations,
 * plans bounded queries, discovers leads, fetches and stores evidence, extracts assertions,
 * bands them across four axes, and reports coverage honestly.
 *
 * What is **not** demonstrated is whether this finds real adverse media about real people. That
 * requires live sources and a measured recall figure, which is gate G10. Saying otherwise on a
 * call would be the exact failure this service is built to prevent.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MongoClient } from 'mongodb';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const c = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  cyan: '[36m',
};

function step(n, title) {
  console.log(`\n${c.bold}${c.blue}${String(n)}. ${title}${c.reset}`);
}
function detail(text) {
  console.log(`   ${c.dim}${text}${c.reset}`);
}
function good(text) {
  console.log(`   ${c.green}✓${c.reset} ${text}`);
}
function warn(text) {
  console.log(`   ${c.yellow}!${c.reset} ${text}`);
}
function fail(text) {
  console.log(`   ${c.red}✗${c.reset} ${text}`);
}

/** Minimal .env loader — the Mongo URI contains `&`, which a shell `source` would truncate. */
function loadEnv() {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) {
    console.error('No .env found. Copy .env.example to .env first.');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) continue;
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(), ...process.env };
const PORT = env.PORT ?? '3000';
const BASE = `http://127.0.0.1:${PORT}`;

async function healthy() {
  try {
    const response = await fetch(`${BASE}/health/live`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start a child process and keep its output for the failure path. */
function start(name, script) {
  const child = spawn(process.execPath, [script], {
    cwd: repoRoot,
    env: { ...env, NODE_ENV: env.NODE_ENV ?? 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const keep = (buffer) => {
    log.push(buffer.toString());
    if (log.length > 200) log.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return { name, child, log };
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `ApiKey ${options.apiKey ?? ''}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text === '' ? null : JSON.parse(text);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${path} → ${String(response.status)}\n` +
        `${JSON.stringify(body, null, 2)}`,
    );
  }
  return body;
}

async function main() {
  console.log(
    `${c.bold}Adverse-search API — end-to-end walkthrough${c.reset}\n` +
      `${c.dim}Every source is a fixture. No live source is contacted by this project.${c.reset}`,
  );

  if (env.ADVERSE_SEARCH_MODE !== 'mock') {
    fail(`ADVERSE_SEARCH_MODE is "${env.ADVERSE_SEARCH_MODE}". This demo only runs in mock mode.`);
    process.exit(1);
  }

  const started = [];
  let mongo;

  try {
    // ---- 0. Bring the service up ---------------------------------------------------------
    step(0, 'Service');
    if (await healthy()) {
      good(`API already running on ${BASE}`);
    } else {
      detail('Starting the API and the worker…');
      started.push(start('api', join(repoRoot, 'apps/api/dist/main.js')));
      started.push(start('worker', join(repoRoot, 'apps/api/dist/worker-main.js')));

      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline && !(await healthy())) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!(await healthy())) {
        fail('The API did not become healthy. Output:');
        for (const s of started) console.log(`\n--- ${s.name} ---\n${s.log.join('')}`);
        throw new Error(
          'API did not start. Is the stack up? `pnpm local:up && pnpm local:bootstrap`',
        );
      }
      good(`API and worker started (${BASE})`);
    }

    // ---- 1. Issue a machine API key ------------------------------------------------------
    step(1, 'Issue a machine API key');
    detail('The credential an integrating application uses. Scoped to one tenant, one');
    detail('environment, and the roles it needs — nothing else.');

    mongo = new MongoClient(env.MONGODB_URI);
    await mongo.connect();
    const { ApiKeyService } = await import(
      `file://${join(repoRoot, 'apps/api/dist/tenancy/api-key.service.js').replaceAll('\\', '/')}`
    );
    const apiKeys = new ApiKeyService(mongo.db());
    await apiKeys.ensureIndexes();

    const issued = await apiKeys.create({
      tenantId: 'tenant-alpha',
      environment: 'sandbox',
      label: `demo ${new Date().toISOString()}`,
      roles: ['analyst'],
      scopes: ['search:read', 'search:write'],
      createdBy: 'demo:api',
    });
    const key = issued.secret;
    good(`key ${issued.keyId} for tenant-alpha (sandbox, role: analyst)`);
    detail(`The secret is shown once and never stored: ${key.slice(0, 24)}…`);

    // ---- 2. Create the subject -----------------------------------------------------------
    step(2, 'Create the subject');
    detail('A name is enough (decision D-011). Anything more improves resolution;');
    detail('this one supplies a date of birth and a known company, which is what lets');
    detail('the association graph resolve an officer rather than leave a candidate.');

    const subject = await request('/v1/subjects', {
      method: 'POST',
      apiKey: key,
      body: JSON.stringify({
        fullName: 'María Fernanda Solís Rojas',
        aliases: [],
        countryContext: ['CR'],
        dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
        knownCompanies: [{ registrationNumber: 'CR-3101-100001', jurisdiction: 'CR' }],
        purpose: 'CUSTOMER_ONBOARDING',
      }),
    });
    good(`subject ${subject.subjectId} v${String(subject.version)}`);
    detail(
      `name-frequency prior: ${
        subject.nameFrequencyPrior === null
          ? 'none — no distribution is loaded for CR (open decision D-011)'
          : JSON.stringify(subject.nameFrequencyPrior)
      }`,
    );

    // ---- 3. Submit the search ------------------------------------------------------------
    step(3, 'Submit the search');
    const accepted = await request('/v1/searches', {
      method: 'POST',
      apiKey: key,
      headers: { 'idempotency-key': `demo-${Date.now().toString()}` },
      body: JSON.stringify({
        environment: 'sandbox',
        subjectRef: { subjectId: subject.subjectId, version: subject.version },
        requestedScope: {
          jurisdictions: ['CR'],
          languages: ['es'],
          includeFormerDirectorships: false,
          fromDate: null,
        },
      }),
    });
    good(`202 Accepted — search ${accepted.searchId} (${accepted.execution})`);
    detail('202, not 200: the run is queued. Returning a result-shaped body here would');
    detail('invite a caller to read "accepted" as "completed with no findings".');

    // ---- 4. Poll -------------------------------------------------------------------------
    step(4, 'Poll until the run completes');
    const deadline = Date.now() + 60_000;
    let run = null;
    while (Date.now() < deadline) {
      run = await request(`/v1/searches/${accepted.searchId}`, { apiKey: key });
      if (run.execution !== 'QUEUED' && run.execution !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    if (run === null || run.execution === 'QUEUED') {
      fail('The run is still QUEUED. The worker is not consuming.');
      for (const s of started) console.log(`\n--- ${s.name} ---\n${s.log.slice(-40).join('')}`);
      throw new Error('Worker did not pick up the job.');
    }
    good(`${run.execution} · findings: ${run.findings} · coverage: ${run.coverage}`);
    detail('Three independent dimensions, read together. "The job finished", "we found');
    detail('nothing" and "we searched everything we promised" are three different facts.');
    for (const warning of run.progress.warnings ?? []) warn(warning);

    // ---- 5. Associations -----------------------------------------------------------------
    step(5, 'The association graph (FR-02)');
    const graph = await request(`/v1/searches/${accepted.searchId}/associations`, { apiKey: key });
    good(
      `${String(graph.edges.length)} edge(s), ${String(graph.unresolvedCandidates.length)} ` +
        `unresolved candidate(s) · coverage ${graph.coverage.outcome}`,
    );
    for (const edge of graph.edges) {
      const anchors = edge.attachesCompany ? 'anchors queries' : 'shown only, anchors nothing';
      console.log(
        `   · ${edge.companyName} — ${edge.role} · ${edge.resolution} · ${edge.currency} ` +
          `${c.dim}(${anchors})${c.reset}`,
      );
    }
    for (const candidate of graph.unresolvedCandidates) {
      console.log(
        `   · ${c.yellow}unresolved${c.reset} ${candidate.officerName} — ${candidate.resolution}`,
      );
    }
    detail('Only a CORROBORATED identity attaches a company. A near match is a candidate');
    detail('for review and anchors no query — the wrong person’s companies never attach.');

    // ---- 6. Findings ---------------------------------------------------------------------
    step(6, 'Findings (FR-11), with the reasoning behind each band');
    const page = await request(`/v1/searches/${accepted.searchId}/findings`, { apiKey: key });

    if (page.findings.length === 0) {
      warn('No findings.');
      if (page.noMatchStatement !== null) {
        console.log(`   ${c.bold}${page.noMatchStatement.headline}${c.reset}`);
        for (const line of page.noMatchStatement.limitations)
          console.log(`     ${c.dim}${line}${c.reset}`);
      }
    }

    for (const finding of page.findings) {
      console.log(`\n   ${c.bold}${finding.band}${c.reset} — ${finding.document.title}`);
      console.log(`     ${c.dim}${finding.document.publisher} · ${finding.document.url}${c.reset}`);
      console.log(
        `     category ${String(finding.category)} · stage ${finding.proceduralStage} · ` +
          `role ${finding.partyRole}`,
      );
      console.log(
        `     axes — identity ${finding.axes.identity} · attribution ${finding.axes.attribution} ` +
          `· tier ${String(finding.axes.authorityTier)} · independent sources ` +
          `${String(finding.axes.independenceCount)}`,
      );
      if (finding.attribution.isInference) {
        console.log(
          `     ${c.yellow}inference:${c.reset} ${String(finding.attribution.statement)}`,
        );
      }
      for (const line of finding.rationale) console.log(`     ${c.dim}· ${line}${c.reset}`);
    }

    // ---- 7. What was not promoted, and what was not covered -------------------------------
    step(7, 'What was rejected, and what was not covered');
    good(`${String(page.rejectedLeads.length)} lead(s) found and not promoted:`);
    for (const lead of page.rejectedLeads) {
      console.log(`   · ${lead.title} ${c.dim}[${lead.stage}] ${lead.reason}${c.reset}`);
    }
    console.log('');
    good('Source outcomes:');
    for (const outcome of page.sourceOutcomes) {
      console.log(
        `   · ${outcome.sourceName} — ${outcome.outcome}` +
          (outcome.detail === null ? '' : ` ${c.dim}${outcome.detail}${c.reset}`),
      );
    }
    if (page.unmeasuredLanguages.length > 0) {
      warn(
        `Languages searched with no measured recall figure: ` +
          `${page.unmeasuredLanguages.join(', ')}. Coverage there is not established (FR-03).`,
      );
    }

    // ---- Closing ---------------------------------------------------------------------------
    console.log(
      `\n${c.bold}${c.cyan}What this run is, and is not${c.reset}\n` +
        `  ${c.green}Is:${c.reset} the whole pipeline — associations, a bounded query plan, discovery,\n` +
        `      fetch into stored evidence, extraction, four-axis banding, and an honest\n` +
        `      coverage statement. Over the real HTTP API, with a machine API key.\n` +
        `  ${c.yellow}Is not:${c.reset} evidence that this finds real adverse media. Every source is a\n` +
        `      fixture (mode: ${page.mode}); no live source has ever been contacted by this\n` +
        `      project, and no language has a measured recall figure. That is gate G10.\n`,
    );
  } finally {
    if (mongo !== undefined) await mongo.close();
    for (const s of started) s.child.kill();
  }
}

main().catch((error) => {
  console.error(
    `\n${c.red}Demo failed:${c.reset} ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
