#!/usr/bin/env node
/**
 * `pnpm local:up` — start the local dependency stack and wait for it to be genuinely ready.
 *
 * "Ready" means each service's own healthcheck reports healthy, not that the container
 * started. A missing prerequisite produces an actionable error, never a silent bypass
 * (G1 exit condition).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(repoRoot, 'infra', 'local', 'docker-compose.yml');

/** Run a command, streaming its output, and resolve with the exit code. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (err += String(d)));
    child.on('error', () => {
      resolve({ code: 127, out, err });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, out, err });
    });
  });
}

async function main() {
  if (!existsSync(composeFile)) {
    console.error(`Compose file not found at ${composeFile}.`);
    process.exit(1);
  }

  const docker = await capture('docker', ['version', '--format', '{{.Server.Version}}']);
  if (docker.code !== 0) {
    console.error(
      [
        'Docker is not available or the daemon is not running.',
        '',
        'This is a genuine prerequisite, not something to work around: the local stack needs a',
        'MongoDB replica set, a search index, S3/SQS emulation, an OIDC provider, a metasearch',
        'instance and a model runtime. Start Docker Desktop (or your daemon) and try again.',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(`Docker server ${docker.out.trim()} detected.`);

  console.log('Starting the local stack. First run pulls images and can take several minutes.');
  const up = await run('docker', [
    'compose',
    '-f',
    composeFile,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '600',
  ]);

  if (up !== 0) {
    console.error(
      [
        '',
        'The stack did not become healthy.',
        '',
        `Inspect it with:  docker compose -f ${composeFile} ps`,
        `Read the logs with:  docker compose -f ${composeFile} logs --tail=100`,
        '',
        'Do not proceed by disabling healthchecks. A dependency that is not actually ready',
        'produces test failures that look like application defects.',
      ].join('\n'),
    );
    process.exit(up);
  }

  console.log(
    [
      '',
      'Local stack healthy:',
      '  MongoDB (rs0)   mongodb://127.0.0.1:27017',
      '  Meilisearch     http://127.0.0.1:7700',
      '  LocalStack      http://127.0.0.1:4566   (S3, SQS)',
      '  Keycloak        http://127.0.0.1:8080',
      '  SearXNG         http://127.0.0.1:8888',
      '  Model runtime   http://127.0.0.1:11434',
      '  Fixture server  http://127.0.0.1:8090',
      '',
      'Next:  pnpm local:bootstrap',
      '',
      'Note: no extraction model is pulled automatically. Which open-weight model to use is',
      'open decision D7 — see docs/open-decisions.md.',
    ].join('\n'),
  );
}

await main();
