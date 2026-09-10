#!/usr/bin/env node
/**
 * `pnpm dev` — build the workspace and run the API against the local stack.
 *
 * Builds first rather than running TypeScript directly: Node's type stripping does not
 * rewrite `.js` specifiers to `.ts`, and NestJS needs emitted decorator metadata, so `tsc` is
 * doing real work here rather than being a formality.
 *
 * The worker and control panel join this script in later phases.
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
    console.error('No .env found. Copy .env.example to .env first.');
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

const built = await run('pnpm', ['build']);
if (built !== 0) {
  console.error('\nBuild failed. Not starting the API against stale output.');
  process.exit(built);
}

const env = loadEnv();
env['OIDC_AUDIENCE'] ??= 'adverse-search-api';
env['CORS_ORIGINS'] ??= 'http://localhost:5173';

console.log('\nStarting the API. Stop with Ctrl+C.\n');
process.exit(await run('node', ['apps/api/dist/main.js'], { env }));
