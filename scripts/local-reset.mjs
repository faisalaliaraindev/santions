#!/usr/bin/env node
/**
 * `pnpm local:reset` — destroy local volumes.
 *
 * Separate from `local:down` on purpose, and gated behind an explicit typed confirmation.
 * The plan requires that reset never happens implicitly during startup and never points at
 * a cloud resource.
 */

import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(repoRoot, 'infra', 'local', 'docker-compose.yml');

const CONFIRMATION = 'reset local data';

/**
 * Refuse to run if anything in the environment points at a real cloud endpoint. A reset
 * script that can reach production is a reset script that eventually does.
 */
function assertLocalOnly() {
  const endpoint = process.env['AWS_ENDPOINT_URL'] ?? '';
  const mongo = process.env['MONGODB_URI'] ?? '';
  const offenders = [];

  const isLocal = (value) =>
    value === '' ||
    /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\]|host\.docker\.internal)([:/]|$)/u.test(value);

  if (!isLocal(endpoint)) {
    offenders.push(`AWS_ENDPOINT_URL=${endpoint}`);
  }
  if (!isLocal(mongo)) {
    offenders.push(`MONGODB_URI=${mongo}`);
  }

  if (offenders.length > 0) {
    console.error(
      [
        'Refusing to reset: the environment points at a non-local endpoint.',
        ...offenders.map((o) => `  ${o}`),
        '',
        'This command destroys data. It only ever operates on the local Docker volumes.',
      ].join('\n'),
    );
    process.exit(1);
  }
}

async function main() {
  assertLocalOnly();

  console.log(
    [
      'This permanently deletes the local MongoDB, search index, S3/SQS, Keycloak and model',
      'volumes for this project. Local searches, evidence and seeded tenants will be gone.',
      '',
      `Type exactly:  ${CONFIRMATION}`,
    ].join('\n'),
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('> ');
  rl.close();

  if (answer.trim() !== CONFIRMATION) {
    console.log('Confirmation did not match. Nothing was deleted.');
    process.exit(1);
  }

  const child = spawn('docker', ['compose', '-f', composeFile, 'down', '-v'], { stdio: 'inherit' });
  child.on('close', (code) => {
    if (code === 0) {
      console.log('Local volumes removed. Run `pnpm local:up` to start again.');
    }
    process.exit(code ?? 1);
  });
}

await main();
