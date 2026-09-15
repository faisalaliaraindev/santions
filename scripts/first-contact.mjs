#!/usr/bin/env node
/**
 * `pnpm first-contact` — the first deliberate live request this project ever makes.
 *
 * # Read this before running it
 *
 * **No live source has ever been contacted by this project.** That sentence appears in
 * `CLAUDE.md`, in `START-HERE.md`, in every phase brief and at the end of every demo run, and it
 * has been true through five phases. It is much easier to keep than to recover: the day it stops
 * being true, it stops being true permanently, and the only question left is whether anybody
 * decided it.
 *
 * Somebody did. **D17**, closed 2026-09-15, records which source, under whose approval, at what
 * rate, and on what stop condition. This script is the act that decision authorises, and nothing
 * more:
 *
 * > One `GET https://www.sec.gov/robots.txt`. Nothing else.
 *
 * It does not poll the feed. It does not activate a source. It does not write to the registry.
 * It makes one request, prints what came back, and stops.
 *
 * # Why a robots read is the right first request
 *
 * It is the smallest possible first contact, and it answers a question we are required to answer
 * anyway. The fetch gate refuses a source whose `robotsPosition` is `NOT_ESTABLISHED`, and the
 * SEC's record says exactly that today — because nobody has read their robots.txt. So this is
 * both the first live request and the **D6** evidence-gathering step for this source, in one act.
 *
 * It is also the politest possible opening: the first thing this service ever says to a publisher
 * is "what are your rules?".
 *
 * # What it uses, and why that matters
 *
 * The **real** `NodeHttpsTransport`, with the real screening `lookup` (D-034) and the real user
 * agent built from `FETCH_CONTACT_URL`. Not `fetch`, not curl. If the address screening or the
 * user agent were wrong, this is where that shows up — which is the point of making the first
 * request through the same code every later request uses.
 *
 * # It will not run by accident
 *
 * It requires `--yes-contact-the-sec` and prints exactly what it is about to do first. There is
 * no default that makes a request.
 */

import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one URL this script is authorised to request. Not a parameter, deliberately. */
const TARGET = 'https://www.sec.gov/robots.txt';

/** The feed path the answer has to permit for the source to be usable. */
const FEED_PATH = '/enforcement-litigation/litigation-releases/rss';

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
    // No .env. The contact URL check below will fail with a useful message.
  }
}

function announce(userAgent) {
  console.log(`
────────────────────────────────────────────────────────────────────────
  THE FIRST LIVE REQUEST THIS PROJECT HAS EVER MADE
────────────────────────────────────────────────────────────────────────

  Request      GET ${TARGET}
  User agent   ${userAgent}
  Authorised   D17, closed 2026-09-15
  Approved by  Faisal Ali, Source admin

  What this does
    Reads the SEC's robots.txt, once. Prints it. Records it as D6 evidence.

  What this does NOT do
    Poll the feed. Activate a source. Write to the registry. Make a second
    request of any kind.

  After this, "no live source has been contacted by this project" stops
  being true, permanently.

────────────────────────────────────────────────────────────────────────
`);
}

async function main() {
  loadEnv();

  const contactUrl = process.env['FETCH_CONTACT_URL'];
  if (contactUrl === undefined || contactUrl.trim() === '') {
    throw new Error(
      'FETCH_CONTACT_URL is not set.\n\n' +
        'FR-06 requires the user agent to identify this service honestly with a contact URL, ' +
        'and there is deliberately no default: a default would be a URL nobody reads on a host ' +
        'nobody owns, and the SEC would have nowhere to write if they wanted us to stop.',
    );
  }

  const { NodeHttpsTransport } = await import(
    `file://${join(repoRoot, 'apps/api/dist/sources/http-transport.js').replaceAll('\\', '/')}`
  );

  const userAgent = `ErlyAdverseSearch/1.0 (+${contactUrl.trim()})`;
  announce(userAgent);

  if (!process.argv.includes('--yes-contact-the-sec')) {
    console.log('  Nothing was sent. To actually make the request:\n');
    console.log('      pnpm first-contact --yes-contact-the-sec\n');
    return;
  }

  console.log('  Sending…\n');
  const startedAt = new Date();

  const transport = new NodeHttpsTransport();
  const result = await transport.send({
    url: TARGET,
    headers: {
      'user-agent': userAgent,
      accept: 'text/plain',
      'accept-encoding': 'gzip',
    },
    timeoutMs: 20_000,
    // A robots.txt larger than this is not a robots.txt.
    maxWireBytes: 512 * 1024,
    maxDecompressedBytes: 512 * 1024,
  });

  if (result.kind === 'FAILURE') {
    console.error(`  FAILED: ${result.detail}`);
    console.error(`  Signal: ${JSON.stringify(result.signal)}\n`);
    console.error(
      '  Nothing is recorded. The source keeps robotsPosition NOT_ESTABLISHED, which the\n' +
        '  fetch gate refuses — so the feed stays unreachable, which is the safe direction.\n',
    );
    process.exitCode = 1;
    return;
  }

  const body = Buffer.from(result.body).toString('utf8');
  console.log(`  HTTP ${String(result.status)}   ${String(result.wireBytes)} bytes on the wire`);
  console.log(`  content-type: ${result.headers['content-type'] ?? '(none)'}\n`);

  // The verdict, using the same parser the fetch adapter uses — so what is recorded here is what
  // the gate will decide later, rather than a second reading of the same file.
  const { parseRobots, robotsVerdict } = await import(
    `file://${join(repoRoot, 'packages/domain/dist/index.js').replaceAll('\\', '/')}`
  );

  let verdict = 'UNKNOWN';
  if (result.status === 200) {
    verdict = robotsVerdict(parseRobots(body), userAgent, FEED_PATH);
  }

  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(`  robots.txt verdict for ${FEED_PATH}`);
  console.log(`      ${verdict}`);
  console.log('────────────────────────────────────────────────────────────────────────\n');

  if (verdict === 'ALLOWED') {
    console.log('  The feed path is permitted. Next: update the source version to record');
    console.log('  robotsPosition HONOURED, through the approval lifecycle — not by hand.\n');
  } else if (verdict === 'DISALLOWED') {
    console.log('  The feed path is DISALLOWED. Do not fetch it. A robots exception needs a');
    console.log('  named approver and open decision D6 has not closed, so none can be applied.\n');
  } else {
    console.log('  Could not establish a position. UNKNOWN is not permission — an outage at the');
    console.log('  publisher is not consent. The source stays unreachable.\n');
  }

  // The record. Written to a file rather than only printed, because this is D6 evidence for this
  // source and "somebody ran a script once and read the output" is not evidence.
  const record = {
    decision: 'D17',
    purpose: 'First deliberate live request; D6 evidence for this source',
    url: TARGET,
    feedPathChecked: FEED_PATH,
    userAgent,
    requestedAt: startedAt.toISOString(),
    httpStatus: result.status,
    wireBytes: result.wireBytes,
    contentType: result.headers['content-type'] ?? null,
    verdict,
    body,
  };

  const path = join(repoRoot, 'docs/sources/sec-robots-evidence.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(`  Recorded: ${path}`);
  console.log('  Commit it. It is the evidence that this request happened and what it said.\n');
}

main().catch((error) => {
  console.error(`\n  FAILED   ${String(error.message ?? error)}\n`);
  process.exitCode = 1;
});
