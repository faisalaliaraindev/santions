#!/usr/bin/env node
/**
 * `pnpm source:health` — read, and optionally reset, a source's **internal** health record.
 *
 * # What this is for
 *
 * D5's breaker exists so that a source which has started refusing us stops being asked. It works.
 * The consequence is that after a bad afternoon — a burst of polls, a 403, a spent budget — the
 * SEC source sits `OPEN` / `HARD_BLOCK` and no local live test can run until somebody decides it
 * is safe to try again. That decision is a person's, and this is the smallest thing that lets
 * them act on it.
 *
 * # What it does not do
 *
 * **It does not disable the breaker.** There is no flag here that turns D5 off, and adding one
 * would be worse than the problem it solved: a breaker that can be switched off is a breaker
 * nobody trusts, and the next burst reaches the publisher. What this does is clear the *recorded
 * state* — the open breaker, the consecutive-failure count, the spent budget windows — and leave
 * every rule that produced it in force. The very next failure opens it again.
 *
 * **It does not touch the kill switch.** A kill switch is somebody's deliberate suspension, it is
 * released through the admin API under four eyes (`POST /v1/admin/sources/:id/kill-switch/
 * release`), and a script that cleared it would be a way around that. If one is engaged, this
 * refuses and says so.
 *
 * **It cannot reset the SEC.** Our breaker is our record of what the SEC did. Clearing it changes
 * nothing at sec.gov: if they are rate-limiting or blocking our address, they still are, and the
 * only evidence of that is the next request. The output says this in as many words, because
 * "breaker CLOSED" reads like permission and is not.
 *
 * # Local only, by construction
 *
 * It refuses when `NODE_ENV=production` and refuses when `MONGODB_URI` points anywhere that is
 * not local (`scripts/lib/local-guard.mjs`, the same guard `local:bootstrap` and `local:reset`
 * use). There is deliberately **no HTTP route** for this: an endpoint would exist in production
 * whether or not a guard were correct, and the thing being guarded is the one control that stops
 * us hammering a publisher.
 *
 * ```
 * pnpm source:health                              # show every source
 * pnpm source:health sec-litigation-releases      # show one
 * pnpm source:health sec-litigation-releases --reset --reason "..."
 * ```
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MongoClient } from 'mongodb';

import { assertLocalOnly } from './lib/local-guard.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    // No .env. The URI check below produces the useful message.
  }
}

/** The fields this script will clear, named so the output can list exactly what changed. */
const RESET_FIELDS = {
  breaker: 'CLOSED',
  consecutiveFailures: 0,
  consecutiveServerErrors: 0,
  halfOpenProbes: 0,
  openedAt: null,
  lastFailureAt: null,
  lastFailureClass: null,
};

function describe(record) {
  const hourly = record.hourly ?? {};
  const daily = record.daily ?? {};
  return [
    `  source                  ${record._id}`,
    `  breaker                 ${record.breaker ?? '(none)'}`,
    `  opened at               ${record.openedAt ?? '—'}`,
    `  last failure            ${record.lastFailureAt ?? '—'} ${record.lastFailureClass ?? ''}`,
    `  last success            ${record.lastSuccessAt ?? '—'}`,
    `  consecutive failures    ${String(record.consecutiveFailures ?? 0)}`,
    `  consecutive 5xx         ${String(record.consecutiveServerErrors ?? 0)}`,
    `  hourly spend            ${String(hourly.spent ?? 0)} since ${hourly.windowStart ?? '—'}`,
    `  daily spend             ${String(daily.spent ?? 0)} since ${daily.windowStart ?? '—'}`,
    `  kill switch             ${record.killSwitch === null || record.killSwitch === undefined ? 'not engaged' : JSON.stringify(record.killSwitch)}`,
  ].join('\n');
}

async function main() {
  loadEnv();

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'Refusing to run: NODE_ENV=production.\n\n' +
        'Clearing a breaker is a decision about traffic to somebody else’s server. In ' +
        'production it goes through the admin API under an identity that gets audited, not ' +
        'through a script on a laptop.',
    );
  }

  const uri = process.env['MONGODB_URI'];
  if (uri === undefined || uri.trim() === '') {
    throw new Error('MONGODB_URI is not set. This command only ever runs against the local stack.');
  }
  assertLocalOnly({ MONGODB_URI: uri }, 'read or reset source health');

  const args = process.argv.slice(2);
  const sourceId = args.find((arg) => !arg.startsWith('--')) ?? null;
  const reset = args.includes('--reset');
  const reasonIndex = args.indexOf('--reason');
  const reason = reasonIndex === -1 ? null : (args[reasonIndex + 1] ?? null);

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const collection = client.db().collection('sourceHealth');
    const filter = sourceId === null ? {} : { _id: sourceId };
    const records = await collection.find(filter).toArray();

    if (records.length === 0) {
      console.log(
        sourceId === null
          ? '\nNo source health records exist yet. Nothing has been called.\n'
          : `\nNo health record for ${sourceId}. It has never been called from this database.\n`,
      );
      return;
    }

    console.log('\n──────────────────────────────────────────────────────────────────────');
    console.log('  SOURCE HEALTH — this service’s own record, not the publisher’s');
    console.log('──────────────────────────────────────────────────────────────────────\n');
    for (const record of records) {
      console.log(describe(record));
      console.log('');
    }

    if (!reset) {
      console.log('  Nothing was changed. To clear the recorded state for one source:\n');
      console.log('      pnpm source:health <sourceId> --reset --reason "why"\n');
      return;
    }

    if (sourceId === null) {
      throw new Error(
        'A reset needs a source id. Resetting every source at once is never the deliberate act ' +
          'this command is for.',
      );
    }
    if (reason === null || reason.trim() === '') {
      throw new Error(
        '--reason is required. The record is the only account of why a breaker that opened for a ' +
          'reason was cleared.',
      );
    }

    const record = records[0];
    if (record.killSwitch !== null && record.killSwitch !== undefined) {
      throw new Error(
        `${sourceId} is suspended by a kill switch (${JSON.stringify(record.killSwitch)}).\n\n` +
          'That is somebody’s deliberate decision and it is released under four eyes through ' +
          'POST /v1/admin/sources/' +
          sourceId +
          '/kill-switch/release. This script will not go around it.',
      );
    }

    const now = new Date();
    await collection.updateOne(
      { _id: sourceId },
      {
        $set: {
          ...RESET_FIELDS,
          // The budget windows are rolled to now rather than deleted: a window with no start is
          // a window the reader has to invent, and the next `checkAccess` would invent a
          // different one.
          hourly: { windowStart: new Date(now).toISOString(), spent: 0 },
          daily: { windowStart: new Date(now).toISOString(), spent: 0 },
          updatedAt: now.toISOString(),
          lastLocalResetAt: now.toISOString(),
          lastLocalResetReason: reason,
        },
      },
    );

    const after = await collection.findOne({ _id: sourceId });
    console.log('──────────────────────────────────────────────────────────────────────');
    console.log(`  RESET — ${sourceId}`);
    console.log('──────────────────────────────────────────────────────────────────────\n');
    console.log(`  reason                  ${reason}`);
    console.log('  cleared                 breaker, failure counts, open timestamp,');
    console.log('                          hourly and daily spend windows');
    console.log('  left alone              kill switch, last success, the approved version,');
    console.log('                          and every rule that opened the breaker\n');
    console.log(describe(after));
    console.log('');
    console.log('  What this did NOT do\n');
    console.log('    It did not reset anything at sec.gov. If the SEC is rate-limiting or');
    console.log('    blocking this address, they still are, and the only way to find out is');
    console.log('    the next request. A CLOSED breaker here is our willingness to try, not');
    console.log('    their permission.\n');
    console.log('    It did not weaken the breaker. The next failure opens it again on the');
    console.log('    same terms, including the D17 stop conditions.\n');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`\n${error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
