#!/usr/bin/env node
/**
 * `pnpm indexed:first-contact` — gather the governance evidence the ten indexed sources need
 * before a single one of them can be proposed, let alone activated.
 *
 * # Why this script exists rather than ten scripts
 *
 * `first-contact.mjs`, `sec-press-first-contact.mjs` and `gdelt-first-contact.mjs` are each
 * written for one publisher, because each was the first contact with that publisher and the
 * shape of the evidence was not yet known. It is known now, and it is the same four reads for
 * every indexed source:
 *
 *   1. `robots.txt` on the host the artifact lives on, evaluated for the artifact's own path.
 *   2. `robots.txt` on the host the published policy lives on, when that is a different host —
 *      a second host's rules are its own and are never inherited.
 *   3. The publisher's own policy/terms page, so `licenceTermsVersion` names something somebody
 *      actually loaded rather than a URL somebody pasted.
 *   4. The configured artifact endpoint itself. A documented address is a guess until it is
 *      loaded, and "the parser exists" is not the same fact as "the publisher serves this".
 *
 * Ten near-identical scripts would be ten places for the robots evaluation to drift, and the
 * copy that drifts is the one that records `HONOURED` for a path nobody checked.
 *
 * # What it does not do
 *
 * **It records no approval and writes nothing to the registry.** The approval is an act by a
 * named person; this script only gathers what that person needs in order to take it, and what a
 * later complaint would be checked against. `source-onboard.mjs` is the thing that reads these
 * files and drives the lifecycle, and it refuses any source whose evidence does not support
 * activation.
 *
 * It also never widens a decision. **D17 is www.sec.gov and D18 is GDELT**; neither is
 * applicable to any host here. The authorising decision for every publisher below is **D19**
 * (2026-09-21, Faisal Ali, Source admin), which permits exactly: read robots, read terms, verify
 * the configured endpoint, one controlled initial refresh, and record the result.
 *
 * ## Usage
 *
 * ```
 * pnpm indexed:first-contact                                  # prints the plan, sends nothing
 * pnpm indexed:first-contact --yes-contact-publishers         # all ten
 * pnpm indexed:first-contact --source ofac-sdn --yes-contact-publishers
 * ```
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = join(repoRoot, 'docs/sources/evidence');

/**
 * The decision authorising every request this script makes.
 *
 * Written out in full, on the evidence record, because "approved" with no name attached is the
 * thing an auditor cannot check. It is not copied from D17 or D18 — see the header.
 */
const D19 = {
  decision: 'D19',
  approvedBy: 'Faisal Ali',
  role: 'Source admin',
  approvedOn: '2026-09-21',
  scope:
    'Read robots.txt, read applicable terms/access-policy pages, verify the configured official ' +
    'endpoint, perform one controlled initial refresh, and record response metadata and ' +
    'applicable rate/access restrictions. Not blanket permission for unrestricted crawling.',
};

/**
 * The minimum gap between two requests this script makes to the same host.
 *
 * Not derived from any publisher's stated ceiling, because most of these publish none. It is a
 * deliberately conservative floor for a script whose entire job is to make a good first
 * impression on nine organisations that did not ask to hear from us.
 */
const PER_HOST_MIN_INTERVAL_MS = 4_000;

/** Bounded so an unexpected response cannot become an unbounded read. */
const ROBOTS_MAX_BYTES = 512 * 1024;
const TERMS_MAX_BYTES = 8 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

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
    // No .env. The FETCH_CONTACT_URL check below fails with a useful message.
  }
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
}

/**
 * The ten sources, read from the compiled registry rather than restated here.
 *
 * A second copy of an endpoint URL is a second thing to keep in step, and the copy that drifts
 * is the one the evidence is gathered against — so the evidence would describe an address the
 * scheduler never calls.
 */
async function loadSources() {
  const registry = async (file) =>
    import(pathToFileURL(join(repoRoot, 'apps/api/dist/sources/registry', file)).href);

  const global = await registry('global-indexed-sources.js');
  const regulators = await registry('regulator-indexed-sources.js');
  const worldBank = await registry('world-bank-indexed-source.js');

  const entries = [
    ...Object.entries(global.GLOBAL_INDEXED_SOURCE_CONTENT),
    ...Object.entries(regulators.REGULATOR_INDEXED_SOURCE_CONTENT),
    [worldBank.WORLD_BANK_DEBARRED_SOURCE_ID, worldBank.WORLD_BANK_DEBARRED_CONTENT],
  ];

  return entries.map(([sourceId, content]) => ({
    sourceId,
    publisher: content.publisher,
    sourceName: content.sourceName,
    contentFormat: content.contentFormat,
    connectorType: content.connectorType,
    credentialsRef: content.credentialsRef,
    endpointUrl: content.accessPolicy.endpointUrl,
    policyUrl: content.accessPolicy.policyUrl,
    userAgentRequired: content.accessPolicy.userAgentRequired,
  }));
}

/** Accept headers by content format, so a publisher is told what we can actually read. */
const ACCEPT = {
  XML: 'application/xml, text/xml;q=0.9, */*;q=0.1',
  XML_FEED: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
  JSON: 'application/json, */*;q=0.1',
};

async function main() {
  loadEnv();
  const contactUrl = process.env['FETCH_CONTACT_URL'];
  if (contactUrl === undefined || contactUrl.trim() === '') {
    throw new Error('FETCH_CONTACT_URL is not set. FR-06 requires an honest contact URL.');
  }
  const userAgent = `ErlyAdverseSearch/1.0 (+${contactUrl.trim()})`;

  const only = arg('source');
  const all = await loadSources();
  const sources = only === undefined ? all : all.filter((s) => s.sourceId === only);
  if (sources.length === 0) {
    throw new Error(`No indexed source matches --source ${String(only)}.`);
  }

  console.log(`
────────────────────────────────────────────────────────────────────────────────
  FIRST CONTACT WITH ${sources.length} INDEXED PUBLISHER SOURCE(S)
────────────────────────────────────────────────────────────────────────────────
  Authorising decision  ${D19.decision} — ${D19.approvedBy}, ${D19.role}, ${D19.approvedOn}
  User agent            ${userAgent}

  Per source, in order: artifact-host robots -> policy-host robots -> terms -> endpoint.
  Each step is skipped when the step that authorises it did not permit it.
  Minimum ${String(PER_HOST_MIN_INTERVAL_MS / 1000)}s between requests to one host.

  This gathers EVIDENCE ONLY. It records no approval and writes nothing to the registry.
`);
  for (const source of sources) {
    console.log(`    ${source.sourceId.padEnd(40)} ${source.publisher}`);
  }
  console.log('');

  if (!process.argv.includes('--yes-contact-publishers')) {
    console.log('  Nothing was sent. Re-run with --yes-contact-publishers\n');
    return;
  }

  const { NodeHttpsTransport } = await import(
    pathToFileURL(join(repoRoot, 'apps/api/dist/sources/http-transport.js')).href
  );
  const { parseRobots, robotsVerdict } = await import(
    pathToFileURL(join(repoRoot, 'packages/domain/dist/index.js')).href
  );
  const transport = new NodeHttpsTransport();

  /** Last request time per host, so the pacing floor is actually enforced and not just stated. */
  const lastRequestAt = new Map();

  const get = async (url, accept, maxBytes) => {
    const host = new URL(url).host;
    const since = Date.now() - (lastRequestAt.get(host) ?? 0);
    if (since < PER_HOST_MIN_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, PER_HOST_MIN_INTERVAL_MS - since));
    }
    lastRequestAt.set(host, Date.now());
    const at = new Date();
    const result = await transport.send({
      url,
      headers: { 'user-agent': userAgent, accept, 'accept-encoding': 'gzip' },
      timeoutMs: 60_000,
      maxWireBytes: maxBytes,
      maxDecompressedBytes: maxBytes * 4,
    });
    return { at: at.toISOString(), result };
  };

  /**
   * Read a host's robots.txt and evaluate it for one path.
   *
   * A 404 is RFC 9309's "no rules published", which is full allowance — recorded as `absent`
   * rather than laundered into a read, so a reader can tell the difference between a publisher
   * who permitted this and a publisher who said nothing.
   */
  const readRobots = async (origin, pathChecked) => {
    const url = `${origin}/robots.txt`;
    const { at, result } = await get(url, 'text/plain', ROBOTS_MAX_BYTES);
    if (result.kind === 'FAILURE') {
      return { url, pathChecked, requestedAt: at, failure: result.detail, verdict: 'UNKNOWN' };
    }
    const body = Buffer.from(result.body).toString('utf8');
    const verdict =
      result.status === 200
        ? robotsVerdict(parseRobots(body), userAgent, pathChecked)
        : result.status === 404
          ? 'ALLOWED'
          : 'UNKNOWN';
    return {
      url,
      pathChecked,
      requestedAt: at,
      httpStatus: result.status,
      wireBytes: result.wireBytes,
      contentType: result.headers['content-type'] ?? null,
      verdict,
      absent: result.status === 404,
      body,
    };
  };

  mkdirSync(evidenceDir, { recursive: true });
  const summary = [];

  for (const source of sources) {
    console.log(`\n──── ${source.sourceId} — ${source.publisher}`);
    const endpoint = new URL(source.endpointUrl);
    const record = {
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      publisher: source.publisher,
      userAgent,
      authorisingDecision: D19,
      steps: {},
    };

    // ---- 1. robots on the artifact host -------------------------------------------------
    const artifactRobots = await readRobots(
      endpoint.origin,
      `${endpoint.pathname}${endpoint.search}`,
    );
    record.steps.artifactRobots = artifactRobots;
    console.log(
      `  1. robots ${endpoint.host}  HTTP ${String(artifactRobots.httpStatus ?? 'FAIL')}  -> ${artifactRobots.verdict}`,
    );

    // ---- 2. robots on the policy host, when it is a different host ----------------------
    const policy = source.policyUrl === null ? null : new URL(source.policyUrl);
    let policyVerdict = 'ALLOWED';
    if (policy !== null && policy.origin !== endpoint.origin) {
      const policyRobots = await readRobots(policy.origin, policy.pathname);
      record.steps.policyRobots = policyRobots;
      policyVerdict = policyRobots.verdict;
      console.log(
        `  2. robots ${policy.host}  HTTP ${String(policyRobots.httpStatus ?? 'FAIL')}  -> ${policyRobots.verdict}`,
      );
    } else if (policy !== null) {
      policyVerdict = robotsVerdictForSameHost(
        artifactRobots,
        policy,
        parseRobots,
        robotsVerdict,
        userAgent,
      );
      record.steps.policyRobots = {
        url: `${policy.origin}/robots.txt`,
        pathChecked: policy.pathname,
        sameHostAsArtifact: true,
        verdict: policyVerdict,
      };
      console.log(`  2. robots ${policy.host} (same host, re-evaluated) -> ${policyVerdict}`);
    }

    // ---- 3. the published terms / access policy -----------------------------------------
    if (policy !== null && policyVerdict === 'ALLOWED') {
      const { at, result } = await get(
        policy.href,
        'text/html,application/xhtml+xml',
        TERMS_MAX_BYTES,
      );
      if (result.kind === 'FAILURE') {
        record.steps.terms = { url: policy.href, requestedAt: at, failure: result.detail };
        console.log(`  3. terms FAILED: ${result.detail}`);
      } else {
        const html = Buffer.from(result.body).toString('utf8');
        const text = html
          .replace(/<script[\s\S]*?<\/script>/giu, ' ')
          .replace(/<style[\s\S]*?<\/style>/giu, ' ')
          .replace(/<[^>]+>/gu, ' ')
          .replace(/&nbsp;/gu, ' ')
          .replace(/&amp;/gu, '&')
          .replace(/\s+/gu, ' ')
          .trim();
        const hits = [];
        const pattern =
          /[^.]{0,320}(?:terms of use|terms and conditions|open government licence|public domain|creative commons|CC BY|licen[cs]e|copyright|redistribut|attribution|reuse|no charge|free to use|acceptable use|privacy and security|automated|scraping|web crawl|rate limit|api key)[^.]{0,320}\./giu;
        for (const match of text.matchAll(pattern)) {
          const sentence = match[0].trim();
          if (sentence.length > 40 && !hits.includes(sentence)) {
            hits.push(sentence);
          }
        }
        record.steps.terms = {
          url: policy.href,
          requestedAt: at,
          httpStatus: result.status,
          wireBytes: result.wireBytes,
          contentType: result.headers['content-type'] ?? null,
          lastModified: result.headers['last-modified'] ?? null,
          bodySha256: createHash('sha256').update(html).digest('hex'),
          extractedTermsSentences: hits.slice(0, 16),
          textLength: text.length,
        };
        console.log(
          `  3. terms HTTP ${result.status}  ${result.wireBytes}B  ${hits.length} licence sentence(s)`,
        );
        for (const hit of hits.slice(0, 6)) {
          console.log(`       * ${hit.slice(0, 200)}`);
        }
      }
    } else {
      record.steps.terms = { skipped: true, reason: `policy-host robots verdict ${policyVerdict}` };
      console.log(`  3. terms SKIPPED — policy-host robots verdict ${policyVerdict}`);
    }

    // ---- 4. endpoint verification -------------------------------------------------------
    //
    // A real GET of the real artifact, because the fact being established is "the publisher
    // serves this document at this address in this format", and nothing short of loading it
    // establishes that. The credentialled source is the exception: it is verified as far as the
    // gateway's own refusal, which is itself the evidence that the credential is required.
    if (artifactRobots.verdict === 'ALLOWED') {
      const accept = ACCEPT[source.contentFormat] ?? '*/*';
      // Redirects are followed here for the same reason `HttpEvidenceFetchAdapter` follows them
      // (up to three): a publisher answering 302 has not refused us, and an evidence record that
      // says "302, unverified" would describe this script's limitation rather than the
      // publisher's behaviour. Each hop is re-screened by the transport's own lookup, and a hop
      // onto a new host has its robots read before it is followed — a second host's rules are
      // its own.
      const hops = [];
      let currentUrl = source.endpointUrl;
      let at;
      let result;
      let redirectRefusal = null;
      for (let hop = 0; hop <= 3; hop += 1) {
        ({ at, result } = await get(currentUrl, accept, ARTIFACT_MAX_BYTES));
        if (result.kind === 'FAILURE' || result.status < 300 || result.status >= 400) {
          break;
        }
        const location = result.headers['location'] ?? null;
        if (location === null) {
          redirectRefusal = `HTTP ${String(result.status)} carried no Location header.`;
          break;
        }
        const next = new URL(location, currentUrl);
        hops.push({ from: currentUrl, status: result.status, to: next.href, at });
        console.log(`     ${String(result.status)} -> ${next.href}`);
        if (hop === 3) {
          redirectRefusal = 'More than three redirects; not followed further.';
          break;
        }
        if (next.origin !== new URL(currentUrl).origin) {
          const hopRobots = await readRobots(next.origin, `${next.pathname}${next.search}`);
          record.steps[`redirectRobots:${next.host}`] = hopRobots;
          console.log(`     robots ${next.host} -> ${hopRobots.verdict}`);
          if (hopRobots.verdict !== 'ALLOWED') {
            redirectRefusal =
              `The redirect target host ${next.host} has robots verdict ${hopRobots.verdict}; ` +
              'it was not followed.';
            break;
          }
        }
        currentUrl = next.href;
      }
      if (hops.length > 0) {
        record.steps.redirects = hops;
        record.steps.resolvedEndpointUrl = currentUrl;
      }
      if (redirectRefusal !== null) {
        record.steps.endpoint = {
          url: source.endpointUrl,
          resolvedUrl: currentUrl,
          requestedAt: at,
          failure: redirectRefusal,
          verified: false,
        };
        console.log(`  4. endpoint NOT VERIFIED: ${redirectRefusal}`);
      } else if (result.kind === 'FAILURE') {
        record.steps.endpoint = {
          url: source.endpointUrl,
          resolvedUrl: currentUrl,
          requestedAt: at,
          failure: result.detail,
          verified: false,
        };
        console.log(`  4. endpoint FAILED: ${result.detail}`);
      } else {
        const body = Buffer.from(result.body);
        const text = body.toString('utf8');
        const contentType = result.headers['content-type'] ?? null;
        const mediaType =
          contentType === null ? null : contentType.split(';', 1)[0].trim().toLowerCase();
        const looksLikeHtmlError = /^\s*<(?:!doctype\s+html|html)\b/iu.test(text.slice(0, 400));
        const verified = result.status === 200 && body.length > 0 && !looksLikeHtmlError;
        record.steps.endpoint = {
          url: source.endpointUrl,
          resolvedUrl: currentUrl,
          requestedAt: at,
          httpStatus: result.status,
          wireBytes: result.wireBytes,
          decompressedBytes: body.length,
          contentType,
          mediaType,
          bodySha256: createHash('sha256').update(body).digest('hex'),
          bodyPreview: text.slice(0, 400),
          looksLikeHtmlErrorPage: looksLikeHtmlError,
          credentialRequired: source.credentialsRef,
          verified,
        };
        console.log(
          `  4. endpoint HTTP ${result.status}  ${result.wireBytes}B wire / ${body.length}B body  ` +
            `${mediaType ?? '?'}  VERIFIED: ${verified}`,
        );
        if (!verified) {
          console.log(`       preview: ${text.slice(0, 200).replace(/\s+/gu, ' ')}`);
        }
      }
    } else {
      record.steps.endpoint = {
        skipped: true,
        reason: `artifact-host robots verdict ${artifactRobots.verdict}`,
        verified: false,
      };
      console.log(`  4. endpoint SKIPPED — artifact-host robots verdict ${artifactRobots.verdict}`);
    }

    // ---- the conclusion, stated rather than left for a reader to infer -------------------
    //
    // `robotsPosition` is HONOURED only when robots was actually read (or found absent) and
    // permits the artifact path. Anything else stays NOT_ESTABLISHED, which the fetch gate
    // refuses — so an unreadable robots.txt produces a source that cannot call anyone, which is
    // the correct outcome and not a broken build.
    const robotsPosition = artifactRobots.verdict === 'ALLOWED' ? 'HONOURED' : 'NOT_ESTABLISHED';
    const endpointVerified = record.steps.endpoint.verified === true;
    record.conclusion = {
      robotsPosition,
      endpointVerified,
      activationSupported: robotsPosition === 'HONOURED' && endpointVerified,
      blocker:
        robotsPosition !== 'HONOURED'
          ? `robots.txt for ${endpoint.host} did not permit ${endpoint.pathname} (verdict ${artifactRobots.verdict}).`
          : endpointVerified
            ? null
            : `The configured endpoint did not return a usable ${source.contentFormat} document. ` +
              (source.credentialsRef === null
                ? 'See steps.endpoint for what it did return.'
                : `${source.credentialsRef} is required and is not configured in this deployment.`),
    };
    summary.push({ sourceId: source.sourceId, ...record.conclusion });

    const path = join(evidenceDir, `${source.sourceId}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    console.log(`  → ${path}`);
  }

  console.log(`
────────────────────────────────────────────────────────────────────────────────
  EVIDENCE SUMMARY
────────────────────────────────────────────────────────────────────────────────`);
  console.log(
    `  ${'sourceId'.padEnd(40)} ${'robots'.padEnd(16)} ${'endpoint'.padEnd(10)} activation`,
  );
  for (const row of summary) {
    console.log(
      `  ${row.sourceId.padEnd(40)} ${row.robotsPosition.padEnd(16)} ` +
        `${String(row.endpointVerified).padEnd(10)} ${row.activationSupported ? 'SUPPORTED' : 'BLOCKED'}`,
    );
    if (row.blocker !== null) {
      console.log(`      ${row.blocker}`);
    }
  }
  console.log(`
  Nothing above is an approval. Run \`pnpm source:onboard\` to put the supported ones
  through propose -> submit -> approve -> activate with two distinct principals.
`);
}

/** Re-evaluate an already-fetched robots body for a second path on the same host. */
function robotsVerdictForSameHost(artifactRobots, policy, parseRobots, robotsVerdict, userAgent) {
  if (typeof artifactRobots.body !== 'string') {
    return artifactRobots.verdict;
  }
  return artifactRobots.absent === true
    ? 'ALLOWED'
    : robotsVerdict(parseRobots(artifactRobots.body), userAgent, policy.pathname);
}

await main();
