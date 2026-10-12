#!/usr/bin/env node
/**
 * `pnpm wikinews:first-contact` — the evidence acts **D22** authorises for `en.wikinews.org`.
 *
 * # Why this is its own script and not a `--source` on `indexed-first-contact.mjs`
 *
 * That script gathers evidence for an **indexed artifact source**: it reads the artifact host's
 * robots, then the policy host's robots, then the terms, then *the configured endpoint*. Wikinews
 * has no configured endpoint and never will — `wikinews-en.ts` records `endpointUrl: null` because
 * this publisher is never polled. It is reached only by following a link a discovery service
 * produced, which is what `EVIDENCE_FETCH_HTTP` means (D-043). Passing it through a script whose
 * fourth step is "load the endpoint" would either crash on the null or, worse, invite somebody to
 * invent an endpoint so the script would run.
 *
 * It is also a **different publisher under a different decision**. `indexed-first-contact.mjs`
 * makes every request under D19, which names ten publishers and none of them is the Wikimedia
 * Foundation. Reusing D19's signature here would be recording an approval nobody gave.
 *
 * # The three requests, and why exactly three
 *
 *   1. `GET https://en.wikinews.org/robots.txt`, evaluated for `/wiki/` with our real user agent.
 *      This is the field `wikinews-en.ts` ships as `NOT_ESTABLISHED`, and the fetch gate refuses
 *      on that value. Nothing but an actual read establishes it.
 *   2. `GET https://foundation.wikimedia.org/robots.txt`, evaluated for the terms path. **A second
 *      host's rules are its own and are never inherited from the first.** The terms live on a
 *      different host from the content, so reading them is a second act needing its own clearance.
 *   3. `GET https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use` — the page
 *      `WIKINEWS_EN_ACCESS_POLICY.policyUrl` names. That URL is a guess until somebody loads it,
 *      and `licenceTermsVersion` should name something that was actually read.
 *
 * Step 3 is skipped if step 2 does not permit it, and both are skipped if step 1 fails — each act
 * is authorised by the one before it rather than by the plan.
 *
 * # What it deliberately does NOT do
 *
 * **It does not fetch an article.** The point of this whole exercise is to prove the chain
 * *SearXNG discovery → publisher authorisation → FetchGate → fetch → extraction → finding*, and an
 * article pulled down here would be a fetch that went round the gate rather than through it. The
 * first Wikinews article this service reads must be read by the pipeline, under the approved
 * registry version, or it proves nothing about the path.
 *
 * **It records no approval and writes nothing to the registry.** It writes
 * `docs/sources/evidence/wikinews-en.json` and stops. `source-onboard.mjs` reads that file and
 * drives propose → submit → approve → activate with two distinct principals; a source whose
 * evidence does not support activation is stopped before activation, and there is no flag to
 * override that.
 *
 * **It covers `en.wikinews.org` and nothing else.** Not `wikinews.org`, not the other language
 * editions, not any other Wikimedia property. Each has its own community and its own content, and
 * an approval covering them all would be an approval nobody scoped.
 *
 * ## Usage
 *
 * ```
 * pnpm wikinews:first-contact                      # prints the plan, sends nothing
 * pnpm wikinews:first-contact --yes-contact-wikimedia
 * ```
 */

import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The decision authorising every request below, written out in full on the evidence record.
 *
 * "Approved" with no name attached is the thing an auditor cannot check. Not copied from D17
 * (www.sec.gov), D18 (GDELT) or D19 (the ten indexed publishers) — none of them names this
 * publisher.
 */
const D22 = {
  decision: 'D22',
  approvedBy: 'Faisal Ali',
  role: 'Source admin',
  approvedOn: '2026-09-22',
  scope:
    'Read en.wikinews.org/robots.txt and evaluate it for the article path; read ' +
    'foundation.wikimedia.org/robots.txt and evaluate it for the terms path; read the Wikimedia ' +
    'Foundation Terms of Use page; record the result. Three GET requests, serial, to two hosts. ' +
    'Not permission to fetch an article — that happens through FetchGate under the approved ' +
    'registry version, once this evidence supports activation. Not permission for any other ' +
    'Wikimedia property or any other language edition of Wikinews.',
};

/**
 * Wikimedia's published API etiquette asks for serial requests rather than parallel ones, and
 * this script is the first impression this service makes on them. Four seconds is not derived
 * from a stated ceiling; it is a deliberately conservative floor.
 */
const PER_REQUEST_GAP_MS = 4_000;

const CONTENT_ROBOTS = 'https://en.wikinews.org/robots.txt';
/**
 * The path the robots verdict is evaluated for.
 *
 * `/wiki/` rather than the exact Madoff article, on purpose: the approval covers articles on this
 * domain generally, and a verdict recorded against one title would be evidence about that title.
 * MediaWiki robots.txt files disallow specific query-string paths (`/w/index.php`) and action
 * URLs while permitting `/wiki/` article reads, so this is the distinction that matters.
 */
const CONTENT_PATH = '/wiki/';
const TERMS_URL = 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use';
const TERMS_HOST_ROBOTS = 'https://foundation.wikimedia.org/robots.txt';
const TERMS_PATH = '/wiki/Policy:Terms_of_Use';

const ROBOTS_MAX_BYTES = 512 * 1024;
const TERMS_MAX_BYTES = 8 * 1024 * 1024;

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
    /* handled by the FETCH_CONTACT_URL check */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  loadEnv();
  const contactUrl = process.env['FETCH_CONTACT_URL'];
  if (contactUrl === undefined || contactUrl.trim() === '') {
    throw new Error('FETCH_CONTACT_URL is not set. FR-06 requires an honest contact URL.');
  }
  // Wikimedia's etiquette asks for a descriptive agent identifying the application with a way to
  // reach somebody. This is that agent, and it is the same one the fetch path sends.
  const userAgent = `ErlyAdverseSearch/1.0 (+${contactUrl.trim()})`;

  console.log(`
────────────────────────────────────────────────────────────────────────
  en.wikinews.org — D22 EVIDENCE ACTS
────────────────────────────────────────────────────────────────────────
  1. GET ${CONTENT_ROBOTS}        (evaluated for ${CONTENT_PATH})
  2. GET ${TERMS_HOST_ROBOTS}  (evaluated for ${TERMS_PATH})
  3. GET ${TERMS_URL}

  User agent   ${userAgent}
  Authorised   ${D22.decision} — ${D22.approvedBy}, ${D22.role}, ${D22.approvedOn}
  Pacing       serial, minimum ${String(PER_REQUEST_GAP_MS / 1000)}s between requests

  Each step is skipped when the step authorising it did not permit it.
  NO ARTICLE IS FETCHED. That happens through FetchGate, under the approved
  registry version, or it proves nothing about the path.
  This gathers EVIDENCE ONLY. It records no approval and writes nothing to
  the registry.
────────────────────────────────────────────────────────────────────────
`);

  if (!process.argv.includes('--yes-contact-wikimedia')) {
    console.log('  Nothing was sent. Re-run with --yes-contact-wikimedia\n');
    return;
  }

  const { NodeHttpsTransport } = await import(
    pathToFileURL(join(repoRoot, 'apps/api/dist/sources/http-transport.js')).href
  );
  const { parseRobots, robotsVerdict } = await import(
    pathToFileURL(join(repoRoot, 'packages/domain/dist/index.js')).href
  );
  const transport = new NodeHttpsTransport();
  const steps = [];

  /** One robots read, evaluated for one path with our real agent. */
  const readRobots = async (url, path, label) => {
    const at = new Date();
    const response = await transport.send({
      url,
      headers: { 'user-agent': userAgent, accept: 'text/plain', 'accept-encoding': 'gzip' },
      timeoutMs: 20_000,
      maxWireBytes: ROBOTS_MAX_BYTES,
      maxDecompressedBytes: ROBOTS_MAX_BYTES,
    });
    if (response.kind === 'FAILURE') {
      console.log(`  ${label} FAILED: ${response.detail}`);
      return { step: label, url, pathChecked: path, requestedAt: at.toISOString(),
        failure: response.detail, verdict: 'UNKNOWN', body: null };
    }
    const body = Buffer.from(response.body).toString('utf8');
    // A robots.txt that did not answer 200 is UNKNOWN, never "allowed by default". Reading an
    // unreadable robots as permission is the exact failure D6 was written about.
    const verdict =
      response.status === 200 ? robotsVerdict(parseRobots(body), userAgent, path) : 'UNKNOWN';
    console.log(
      `  ${label} HTTP ${response.status}  ${response.wireBytes}B  →  ${path}: ${verdict}`,
    );
    return {
      step: label,
      url,
      pathChecked: path,
      requestedAt: at.toISOString(),
      httpStatus: response.status,
      wireBytes: response.wireBytes,
      contentType: response.headers['content-type'] ?? null,
      verdict,
      body,
    };
  };

  // ---- 1. the content host's robots -------------------------------------------------------
  const contentRobots = await readRobots(CONTENT_ROBOTS, CONTENT_PATH, '1. content robots ');
  steps.push(contentRobots);

  // ---- 2. the terms host's robots ---------------------------------------------------------
  // Read whatever step 1 concluded: the terms live on a different host, so step 1's verdict is
  // not about them either way. Step 1 gates the ARTICLE path, not this one.
  await sleep(PER_REQUEST_GAP_MS);
  const termsRobots = await readRobots(TERMS_HOST_ROBOTS, TERMS_PATH, '2. terms robots   ');
  steps.push(termsRobots);

  // ---- 3. the terms page ------------------------------------------------------------------
  let terms = null;
  if (termsRobots.verdict === 'ALLOWED') {
    await sleep(PER_REQUEST_GAP_MS);
    const at = new Date();
    const response = await transport.send({
      url: TERMS_URL,
      headers: {
        'user-agent': userAgent,
        accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1',
        'accept-encoding': 'gzip',
      },
      timeoutMs: 30_000,
      maxWireBytes: TERMS_MAX_BYTES,
      maxDecompressedBytes: TERMS_MAX_BYTES,
    });
    if (response.kind === 'FAILURE') {
      console.log(`  3. terms          FAILED: ${response.detail}`);
      terms = { step: '3. terms', url: TERMS_URL, requestedAt: at.toISOString(),
        failure: response.detail, verified: false };
    } else {
      const text = Buffer.from(response.body).toString('utf8');
      const title = /<title>([^<]{0,300})<\/title>/u.exec(text)?.[1]?.trim() ?? null;
      terms = {
        step: '3. terms',
        url: TERMS_URL,
        requestedAt: at.toISOString(),
        httpStatus: response.status,
        wireBytes: response.wireBytes,
        contentType: response.headers['content-type'] ?? null,
        lastModified: response.headers['last-modified'] ?? null,
        pageTitle: title,
        // Recorded as bytes-and-title rather than as an interpretation. Whether these terms
        // permit this use is a reading a person makes, not something a script concludes.
        verified: response.status === 200 && title !== null,
      };
      console.log(
        `  3. terms          HTTP ${response.status}  ${response.wireBytes}B  ${title ?? '?'}`,
      );
    }
    steps.push(terms);
  } else {
    console.log('  3. terms          SKIPPED — that host\'s robots did not permit the path.');
    steps.push({ step: '3. terms', url: TERMS_URL, skipped: true,
      reason: `terms-host robots verdict was ${termsRobots.verdict}` });
  }

  /**
   * The conclusion, in the shape `source-onboard.mjs` reads.
   *
   * `robotsPosition` is `HONOURED` only on an explicit ALLOWED for the article path. Everything
   * else — DISALLOWED, UNKNOWN, a failed read — leaves it `NOT_ESTABLISHED`, which is the value
   * the registry template already carries and which the fetch gate refuses on. There is
   * deliberately no branch here that produces `EXCEPTION_APPROVED`: that is D6's shape, it is
   * host-scoped to publishers serving a bulk artifact from delivery infrastructure, and it is a
   * named human decision rather than something a script can reach.
   */
  const robotsPosition = contentRobots.verdict === 'ALLOWED' ? 'HONOURED' : 'NOT_ESTABLISHED';
  const termsRead = terms !== null && terms.verified === true;
  const blocker =
    robotsPosition === 'HONOURED'
      ? termsRead
        ? null
        : 'The Terms of Use page was not read, so licenceTermsVersion names a URL nobody loaded.'
      : `en.wikinews.org/robots.txt gave ${contentRobots.verdict} for ${CONTENT_PATH}.`;

  const record = {
    sourceId: 'wikinews-en',
    sourceName: 'English Wikinews',
    publisher: 'Wikimedia Foundation',
    canonicalDomain: 'en.wikinews.org',
    userAgent,
    authorisingDecision: D22,
    scopeNote:
      'Covers en.wikinews.org only. Not wikinews.org, not other language editions, not any ' +
      'other Wikimedia property. No article was fetched by this script — the first article this ' +
      'service reads from this publisher goes through FetchGate under the approved registry ' +
      'version.',
    steps,
    conclusion: {
      robotsPosition,
      // No endpoint to verify: this source is never polled (endpointUrl is null by design). Null
      // rather than false, because false would read as "we tried and it did not work".
      endpointVerified: null,
      termsRead,
      activationSupported: robotsPosition === 'HONOURED' && termsRead,
      blocker,
    },
  };

  const path = join(repoRoot, 'docs/sources/evidence/wikinews-en.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  console.log(`
  ──── conclusion
  robotsPosition        ${record.conclusion.robotsPosition}
  termsRead             ${String(record.conclusion.termsRead)}
  activationSupported   ${String(record.conclusion.activationSupported)}
  blocker               ${record.conclusion.blocker ?? '(none)'}

  Recorded: ${path}

  Next, and NOT done by this script — the four-eyes lifecycle, two distinct principals:
    SOURCE_PROPOSER_KEY=... SOURCE_APPROVER_KEY=... \\
      pnpm source:onboard --apply --source wikinews-en
`);
}

await main();
