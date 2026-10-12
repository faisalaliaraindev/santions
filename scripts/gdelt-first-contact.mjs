#!/usr/bin/env node
/**
 * `pnpm gdelt:first-contact` — the first request this project has ever made to GDELT.
 *
 * `www.sec.gov` is the only publisher this service has ever contacted. This is the second, and
 * it is a different relationship: **D17 authorises the SEC and must never be copied into it.**
 * This script gathers the evidence a GDELT source version needs; it does not supply the
 * approval, and it writes nothing to the registry.
 *
 * Four reads, in the order a polite client would make them:
 *
 *   1. `GET https://api.gdeltproject.org/robots.txt`, evaluated for `/api/v2/doc/doc`.
 *   2. `GET https://gdeltproject.org/robots.txt`, evaluated for `/about.html` — the terms
 *      live on a different host, and its rules are its own.
 *   3. `GET https://gdeltproject.org/about.html` — the published terms of use, so that
 *      `licenceTermsVersion` names something somebody actually loaded.
 *   4. `GET https://api.gdeltproject.org/api/v2/doc/doc?query=climate&...` — endpoint
 *      verification, with a benign non-person query. A widely documented address is still a
 *      guess until it is loaded.
 *
 * Each step is skipped if the step that authorises it did not permit it. Output goes to
 * `docs/sources/gdelt-evidence.json`.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const API_ROBOTS = 'https://api.gdeltproject.org/robots.txt';
const SITE_ROBOTS = 'https://gdeltproject.org/robots.txt';
const TERMS_URL = 'https://gdeltproject.org/about.html';
const DOC_PATH = '/api/v2/doc/doc';
const ENDPOINT =
  'https://api.gdeltproject.org/api/v2/doc/doc' +
  '?query=climate&mode=artlist&maxrecords=1&format=json&timespan=1d';

/**
 * GDELT's published minimum interval between requests, in milliseconds.
 *
 * Not a guess and not a courtesy margin: it is the figure GDELT returns in the body of its own
 * 429 — "Please limit requests to one every 5 seconds". Recorded here as a named constant
 * because the source version's `requestCeilingPerSecond` is derived from it (1/5 = 0.2), and the
 * two must not drift.
 */
const GDELT_MIN_REQUEST_INTERVAL_MS = 6_000;

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

async function main() {
  loadEnv();
  const contactUrl = process.env['FETCH_CONTACT_URL'];
  if (contactUrl === undefined || contactUrl.trim() === '') {
    throw new Error('FETCH_CONTACT_URL is not set. FR-06 requires an honest contact URL.');
  }
  const userAgent = `ErlyAdverseSearch/1.0 (+${contactUrl.trim()})`;

  console.log(`
────────────────────────────────────────────────────────────────────────
  FIRST CONTACT WITH GDELT — a publisher this project has never called
────────────────────────────────────────────────────────────────────────
  1. GET ${API_ROBOTS}
  2. GET ${SITE_ROBOTS}
  3. GET ${TERMS_URL}
  4. GET ${ENDPOINT}

  User agent   ${userAgent}

  This gathers evidence ONLY. It does not record a first-contact approval,
  and D17 (which is about www.sec.gov) is not applicable to this host.
────────────────────────────────────────────────────────────────────────
`);

  if (!process.argv.includes('--yes-contact-gdelt')) {
    console.log('  Nothing was sent. Re-run with --yes-contact-gdelt\n');
    return;
  }

  const { NodeHttpsTransport } = await import(
    pathToFileURL(join(repoRoot, 'apps/api/dist/sources/http-transport.js')).href
  );
  const { parseRobots, robotsVerdict } = await import(
    pathToFileURL(join(repoRoot, 'packages/domain/dist/index.js')).href
  );
  const transport = new NodeHttpsTransport();

  const get = async (url, accept, maxBytes) => {
    const at = new Date();
    const r = await transport.send({
      url,
      headers: { 'user-agent': userAgent, accept, 'accept-encoding': 'gzip' },
      timeoutMs: 25_000,
      maxWireBytes: maxBytes,
      maxDecompressedBytes: maxBytes * 4,
    });
    return { at: at.toISOString(), r };
  };

  const record = { sourceId: 'gdelt-doc-v2', userAgent, steps: {} };

  // ---- 1. api host robots ---------------------------------------------------------------
  const a = await get(API_ROBOTS, 'text/plain', 512 * 1024);
  let apiVerdict = 'UNKNOWN';
  if (a.r.kind === 'FAILURE') {
    console.log(`  1. FAILED: ${a.r.detail}`);
    record.steps.apiRobots = { url: API_ROBOTS, requestedAt: a.at, failure: a.r.detail };
  } else {
    const apiBody = Buffer.from(a.r.body).toString('utf8');
    // A 404 on robots.txt is the RFC 9309 "no rules published" case: an absent file is full
    // allowance. Recorded as exactly that — absent, not read — rather than laundered into a read.
    apiVerdict =
      a.r.status === 200
        ? robotsVerdict(parseRobots(apiBody), userAgent, DOC_PATH)
        : a.r.status === 404
          ? 'ALLOWED'
          : 'UNKNOWN';
    record.steps.apiRobots = {
      url: API_ROBOTS,
      requestedAt: a.at,
      httpStatus: a.r.status,
      wireBytes: a.r.wireBytes,
      contentType: a.r.headers['content-type'] ?? null,
      pathChecked: DOC_PATH,
      verdict: apiVerdict,
      absent: a.r.status === 404,
      body: apiBody,
    };
    console.log(`  1. HTTP ${a.r.status}  ${a.r.wireBytes}B  ->  ${DOC_PATH}: ${apiVerdict}`);
  }

  // ---- 2. site host robots --------------------------------------------------------------
  const b = await get(SITE_ROBOTS, 'text/plain', 512 * 1024);
  let siteVerdict = 'UNKNOWN';
  if (b.r.kind === 'FAILURE') {
    console.log(`  2. FAILED: ${b.r.detail}`);
    record.steps.siteRobots = { url: SITE_ROBOTS, requestedAt: b.at, failure: b.r.detail };
  } else {
    const body = Buffer.from(b.r.body).toString('utf8');
    siteVerdict =
      b.r.status === 200
        ? robotsVerdict(parseRobots(body), userAgent, '/about.html')
        : b.r.status === 404
          ? 'ALLOWED'
          : 'UNKNOWN';
    record.steps.siteRobots = {
      url: SITE_ROBOTS,
      requestedAt: b.at,
      httpStatus: b.r.status,
      wireBytes: b.r.wireBytes,
      pathChecked: '/about.html',
      verdict: siteVerdict,
      absent: b.r.status === 404,
      body,
    };
    console.log(`  2. HTTP ${b.r.status}  ${b.r.wireBytes}B  ->  /about.html: ${siteVerdict}`);
  }

  // ---- 3. the terms ---------------------------------------------------------------------
  if (siteVerdict === 'ALLOWED') {
    const c = await get(TERMS_URL, 'text/html', 4 * 1024 * 1024);
    if (c.r.kind === 'FAILURE') {
      console.log(`  3. FAILED: ${c.r.detail}`);
      record.steps.terms = { url: TERMS_URL, requestedAt: c.at, failure: c.r.detail };
    } else {
      const html = Buffer.from(c.r.body).toString('utf8');
      const text = html
        .replace(/<script[\s\S]*?<\/script>/giu, ' ')
        .replace(/<style[\s\S]*?<\/style>/giu, ' ')
        .replace(/<[^>]+>/gu, ' ')
        .replace(/&nbsp;/gu, ' ')
        .replace(/&amp;/gu, '&')
        .replace(/\s+/gu, ' ')
        .trim();
      // The licence sentences, kept verbatim and in context, so the recorded terms version names
      // something a reader can check rather than a summary nobody can audit.
      const hits = [];
      const pattern =
        /[^.]{0,320}(?:terms of use|free and open|creative commons|CC BY|licen[cs]e|copyright|redistribut|attribution|no charge|academic and commercial)[^.]{0,320}\./giu;
      for (const m of text.matchAll(pattern)) {
        const s = m[0].trim();
        if (s.length > 40 && !hits.includes(s)) {
          hits.push(s);
        }
      }
      record.steps.terms = {
        url: TERMS_URL,
        requestedAt: c.at,
        httpStatus: c.r.status,
        wireBytes: c.r.wireBytes,
        contentType: c.r.headers['content-type'] ?? null,
        lastModified: c.r.headers['last-modified'] ?? null,
        bodySha256: createHash('sha256').update(html).digest('hex'),
        extractedTermsSentences: hits.slice(0, 14),
        textLength: text.length,
      };
      console.log(
        `  3. HTTP ${c.r.status}  ${c.r.wireBytes}B  sha256 ${record.steps.terms.bodySha256.slice(0, 16)}`,
      );
      for (const h of hits.slice(0, 14)) {
        console.log(`       * ${h.slice(0, 230)}`);
      }
    }
  } else {
    console.log('  3. SKIPPED - robots for gdeltproject.org did not permit /about.html');
  }

  // ---- 4. endpoint verification ---------------------------------------------------------
  //
  // GDELT states its own ceiling in the body of its 429: "Please limit requests to one every 5
  // seconds". Step 3 was a request, so this one waits out that interval before making another.
  // Verifying an endpoint by exceeding the limit the same endpoint just told us about would be
  // a poor way to open a relationship with a publisher, and the wait is the cheapest possible
  // way to honour it.
  if (apiVerdict === 'ALLOWED') {
    await new Promise((resolve) => setTimeout(resolve, GDELT_MIN_REQUEST_INTERVAL_MS));
    const d = await get(ENDPOINT, 'application/json', 4 * 1024 * 1024);
    if (d.r.kind === 'FAILURE') {
      console.log(`  4. FAILED: ${d.r.detail}`);
      record.steps.endpoint = {
        url: ENDPOINT,
        requestedAt: d.at,
        failure: d.r.detail,
        verified: false,
      };
    } else {
      const raw = Buffer.from(d.r.body).toString('utf8');
      let parsed = null;
      let articles = null;
      try {
        parsed = JSON.parse(raw);
        articles = Array.isArray(parsed.articles) ? parsed.articles.length : null;
      } catch {
        // Recorded as parsedAsJson:false below rather than thrown — an unparseable body is
        // itself the verification result.
      }
      const verified = d.r.status === 200 && parsed !== null && articles !== null;
      record.steps.endpoint = {
        url: ENDPOINT,
        queryParam: 'query',
        endpointKind: 'QUERY_FEED',
        requestedAt: d.at,
        httpStatus: d.r.status,
        wireBytes: d.r.wireBytes,
        contentType: d.r.headers['content-type'] ?? null,
        parsedAsJson: parsed !== null,
        articleCount: articles,
        responseKeys: parsed === null ? null : Object.keys(parsed),
        sampleFields: articles !== null && articles > 0 ? Object.keys(parsed.articles[0]) : null,
        bodyPreview: raw.slice(0, 400),
        verified,
      };
      console.log(
        `  4. HTTP ${d.r.status}  ${d.r.wireBytes}B  ${d.r.headers['content-type'] ?? '?'}\n` +
          `     json: ${parsed !== null}  articles: ${articles}  keys: ${
            parsed === null ? '-' : Object.keys(parsed).join(',')
          }\n     VERIFIED: ${verified}`,
      );
    }
  } else {
    console.log('  4. SKIPPED - robots for api.gdeltproject.org did not permit the DOC path');
  }

  const path = join(repoRoot, 'docs/sources/gdelt-evidence.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(`\n  Recorded: ${path}\n`);
}

await main();
