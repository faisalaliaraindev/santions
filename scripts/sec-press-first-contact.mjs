#!/usr/bin/env node
/**
 * `pnpm sec:press-contact` — the evidence acts D17 authorises for the SEC **press-releases** feed.
 *
 * `scripts/first-contact.mjs` is hard-coded to the litigation feed on purpose, and this is its
 * sibling rather than a parameter on it, for the same reason: a script that takes a URL is a
 * crawler, and the thing that makes these requests defensible is that each one is named in a
 * decision before it is written down.
 *
 * Two requests, both authorised by **D17**, which names this feed in its own text ("the SEC
 * litigation-releases RSS feed ... with the press-releases feed as a second, later"):
 *
 *   1. `GET https://www.sec.gov/robots.txt`, evaluated against `/news/pressreleases.rss`.
 *      The recorded 2026-09-16 read checked the *litigation* path, so its `feedPathChecked`
 *      cannot be read as covering this one. This re-reads rather than re-interprets.
 *   2. `GET https://www.sec.gov/news/pressreleases.rss` — endpoint verification. A widely
 *      documented address is still a guess until somebody loads it.
 *
 * It writes `docs/sources/sec-press-robots-evidence.json` and prints the verdict. It does not
 * propose, approve or activate anything.
 */

import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROBOTS_TARGET = 'https://www.sec.gov/robots.txt';
const FEED_TARGET = 'https://www.sec.gov/news/pressreleases.rss';
const FEED_PATH = '/news/pressreleases.rss';

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

async function main() {
  loadEnv();
  const contactUrl = process.env['FETCH_CONTACT_URL'];
  if (contactUrl === undefined || contactUrl.trim() === '') {
    throw new Error('FETCH_CONTACT_URL is not set. FR-06 requires an honest contact URL.');
  }
  const userAgent = `ErlyAdverseSearch/1.0 (+${contactUrl.trim()})`;

  console.log(`
────────────────────────────────────────────────────────────────────────
  SEC PRESS-RELEASES FEED — D17 EVIDENCE ACTS
────────────────────────────────────────────────────────────────────────
  1. GET ${ROBOTS_TARGET}   (re-read, evaluated for ${FEED_PATH})
  2. GET ${FEED_TARGET}   (endpoint verification)
  User agent   ${userAgent}
  Authorised   D17, closed 2026-09-15, Faisal Ali, Source admin
────────────────────────────────────────────────────────────────────────
`);

  if (!process.argv.includes('--yes-contact-the-sec')) {
    console.log('  Nothing was sent. Re-run with --yes-contact-the-sec\n');
    return;
  }

  const { NodeHttpsTransport } = await import(
    pathToFileURL(join(repoRoot, 'apps/api/dist/sources/http-transport.js')).href
  );
  const { parseRobots, robotsVerdict } = await import(
    pathToFileURL(join(repoRoot, 'packages/domain/dist/index.js')).href
  );
  const transport = new NodeHttpsTransport();

  // ---- 1. robots ------------------------------------------------------------------------
  const robotsAt = new Date();
  const robots = await transport.send({
    url: ROBOTS_TARGET,
    headers: { 'user-agent': userAgent, accept: 'text/plain', 'accept-encoding': 'gzip' },
    timeoutMs: 20_000,
    maxWireBytes: 512 * 1024,
    maxDecompressedBytes: 512 * 1024,
  });
  if (robots.kind === 'FAILURE') {
    console.error(`  robots.txt FAILED: ${robots.detail}`);
    process.exitCode = 1;
    return;
  }
  const body = Buffer.from(robots.body).toString('utf8');
  const verdict =
    robots.status === 200 ? robotsVerdict(parseRobots(body), userAgent, FEED_PATH) : 'UNKNOWN';
  console.log(`  1. HTTP ${robots.status}  ${robots.wireBytes}B  →  ${FEED_PATH}: ${verdict}\n`);

  // ---- 2. the feed itself ---------------------------------------------------------------
  let endpoint = null;
  if (verdict === 'ALLOWED') {
    const feedAt = new Date();
    const feed = await transport.send({
      url: FEED_TARGET,
      headers: {
        'user-agent': userAgent,
        accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'accept-encoding': 'gzip',
      },
      timeoutMs: 20_000,
      maxWireBytes: 4 * 1024 * 1024,
      maxDecompressedBytes: 8 * 1024 * 1024,
    });
    if (feed.kind === 'FAILURE') {
      console.error(`  2. feed FAILED: ${feed.detail}`);
      endpoint = { requestedAt: feedAt.toISOString(), verified: false, detail: feed.detail };
    } else {
      const text = Buffer.from(feed.body).toString('utf8');
      const items = (text.match(/<item[\s>]/gu) ?? []).length;
      const title = /<title>([^<]{0,200})<\/title>/u.exec(text)?.[1] ?? null;
      const firstItem = /<item[\s>][\s\S]*?<title>([^<]{0,200})<\/title>/u.exec(text)?.[1] ?? null;
      const isRss = /<rss[\s>]|<feed[\s>]/u.test(text);
      endpoint = {
        requestedAt: feedAt.toISOString(),
        httpStatus: feed.status,
        wireBytes: feed.wireBytes,
        contentType: feed.headers['content-type'] ?? null,
        lastModified: feed.headers['last-modified'] ?? null,
        etag: feed.headers['etag'] ?? null,
        parsedAsFeed: isRss,
        channelTitle: title,
        itemCount: items,
        firstItemTitle: firstItem,
        verified: feed.status === 200 && isRss && items > 0,
      };
      console.log(
        `  2. HTTP ${feed.status}  ${feed.wireBytes}B  ${feed.headers['content-type'] ?? '?'}\n` +
          `     channel: ${title}\n     items: ${items}   newest: ${firstItem}\n` +
          `     VERIFIED: ${endpoint.verified}\n`,
      );
    }
  } else {
    console.log('  2. SKIPPED — robots did not permit the path, so the feed was not requested.\n');
  }

  const record = {
    decision: 'D17',
    purpose:
      'Robots position and endpoint verification for the SEC press-releases feed, the second ' +
      'feed D17 names. Separate from sec-robots-evidence.json, whose feedPathChecked is the ' +
      'litigation path.',
    sourceId: 'sec-press-releases',
    url: ROBOTS_TARGET,
    feedPathChecked: FEED_PATH,
    userAgent,
    requestedAt: robotsAt.toISOString(),
    httpStatus: robots.status,
    wireBytes: robots.wireBytes,
    contentType: robots.headers['content-type'] ?? null,
    verdict,
    endpointVerification: endpoint,
    body,
  };
  const path = join(repoRoot, 'docs/sources/sec-press-robots-evidence.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(`  Recorded: ${path}\n`);
}

await main();
