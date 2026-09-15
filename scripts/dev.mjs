#!/usr/bin/env node
/**
 * `pnpm dev` — build the workspace and run the local processes against the local stack.
 *
 * ```
 * pnpm dev            # API and worker together — what you usually want
 * pnpm dev:api        # API only
 * pnpm dev:worker     # worker only
 * ```
 *
 * Builds first rather than running TypeScript directly: Node's type stripping does not rewrite
 * `.js` specifiers to `.ts`, and NestJS needs emitted decorator metadata, so `tsc` is doing real
 * work here rather than being a formality.
 *
 * # Why `dev:api` goes through this script rather than calling node directly
 *
 * It used to be `node apps/api/dist/main.js`, and it could not start: configuration is validated
 * at boot and refuses to run without `MONGODB_URI`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
 * `OIDC_CLIENT_SECRET` and `SESSION_SECRET` — but nothing loaded `.env`, so none of them were
 * set. The documented path in the README and in `postman/README.md` was broken, and the failure
 * looked like a configuration mistake by the reader rather than a missing step in the script.
 *
 * The refusal itself is right and stays: a service that starts with a missing session secret is
 * a service that generates one, and a generated session secret is a session that survives a
 * restart only by accident. What was wrong was that nothing supplied the values.
 *
 * # Why the worker is a second process and not a flag
 *
 * `worker-main.ts` is the same image and the same DI graph with no HTTP server (**D-016**). Two
 * processes locally is what production looks like, and running the handler inside the API would
 * hide the queue entirely — including the part where a search stays `QUEUED` forever because
 * nothing is consuming. That is the single most common local confusion and it is worth keeping
 * visible.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader.
 *
 * Written by hand because the Mongo connection string contains `&`, which a naive shell
 * `source` treats as a job separator — silently dropping every variable after it.
 */
function loadEnv() {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) {
    console.error('No .env found. Copy .env.example to .env first:\n\n  cp .env.example .env\n');
    process.exit(1);
  }
  const env = { ...process.env };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match && env[match[1]] === undefined) {
      env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
    }
  }
  return env;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

const PROCESSES = {
  api: { label: 'api', entry: 'apps/api/dist/main.js' },
  worker: { label: 'worker', entry: 'apps/api/dist/worker-main.js' },
};

/** Which processes to start. `--only api` / `--only worker`, else both. */
function selected() {
  const index = process.argv.indexOf('--only');
  const name = index === -1 ? null : process.argv[index + 1];
  if (name === null) {
    return ['api', 'worker'];
  }
  if (!(name in PROCESSES)) {
    console.error(
      `Unknown process "${name}". Expected one of: ${Object.keys(PROCESSES).join(', ')}`,
    );
    process.exit(1);
  }
  return [name];
}

const targets = selected();

const built = await run('pnpm', ['build']);
if (built !== 0) {
  console.error('\nBuild failed. Not starting against stale output.');
  process.exit(built);
}

const env = loadEnv();
env['OIDC_AUDIENCE'] ??= 'adverse-search-api';
env['CORS_ORIGINS'] ??= 'http://localhost:5173';

console.log(`\nStarting: ${targets.join(', ')}. Stop with Ctrl+C.\n`);

if (targets.length === 1) {
  const only = PROCESSES[targets[0]];
  process.exit(await run('node', [only.entry], { env }));
}

// Both. Each child keeps its own inherited stdio — Nest already prefixes every line with its
// context, so a second layer of prefixing would make the output harder to read rather than
// easier. If one exits, stop the other: a running API with a dead worker is the state where
// every search sits at QUEUED and nothing says why.
const children = targets.map((name) => {
  const { entry } = PROCESSES[name];
  const child = spawn('node', [entry], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  child.on('close', (code) => {
    console.error(`\n${name} exited (${String(code ?? 1)}). Stopping the rest.\n`);
    for (const other of children) {
      if (other !== child && other.exitCode === null) {
        other.kill();
      }
    }
    process.exitCode = code ?? 1;
  });
  return child;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) {
      child.kill();
    }
  });
}
