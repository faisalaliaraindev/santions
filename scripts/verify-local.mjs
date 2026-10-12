#!/usr/bin/env node
/**
 * `pnpm verify:local` — aggregate the mandatory non-live checks.
 *
 * Per section 11: it "fails on required skipped suites". A suite that is not implemented is
 * reported as UNIMPLEMENTED and fails the run. It is never reported as a pass, and the
 * summary states plainly what was and was not verified.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `required: true` suites must pass for `verify:local` to succeed.
 * `implemented: false` marks a suite that does not exist yet — it fails loudly rather than
 * being silently skipped, which is how a gate goes green without being met.
 */
const SUITES = [
  { name: 'lint', script: 'lint', required: true, implemented: true },
  { name: 'typecheck', script: 'typecheck', required: true, implemented: true },
  { name: 'unit', script: 'test:unit', required: true, implemented: true },
  {
    name: 'invariants (I1-I10 release gate)',
    script: 'test:invariants',
    required: true,
    implemented: true,
  },
  { name: 'evaluation metrics', script: 'test:evaluation', required: true, implemented: true },
  { name: 'integration', script: 'test:integration', required: true, implemented: true },
  { name: 'security', script: 'test:security', required: true, implemented: true },
  { name: 'end-to-end (API)', script: 'test:e2e:api', required: true, implemented: true },
  // The **browser** end-to-end suite, gate G8, mostly in `adverse-search-frontend`.
  // Deliberately still unimplemented: the API suite above goes in through the HTTP door and out
  // through it, which is a real end-to-end and is not the same claim. Letting it satisfy this
  // entry would be this file's own failure mode — a gate going green without being met.
  { name: 'end-to-end (browser)', script: 'test:e2e', required: true, implemented: false },
];

function run(script) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['run', script], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', () => {
      resolve(1);
    });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

const results = [];

for (const suite of SUITES) {
  if (!suite.implemented) {
    results.push({ ...suite, status: 'UNIMPLEMENTED' });
    continue;
  }
  console.log(`\n─── ${suite.name} ─────────────────────────────────────────`);
  const code = await run(suite.script);
  results.push({ ...suite, status: code === 0 ? 'PASS' : 'FAIL' });
}

console.log('\n═══ verify:local summary ═══════════════════════════════════\n');
for (const r of results) {
  const mark = r.status === 'PASS' ? '  ok  ' : r.status === 'FAIL' ? ' FAIL ' : ' n/i  ';
  console.log(
    `[${mark}] ${r.name}${r.status === 'UNIMPLEMENTED' ? '  — suite not implemented' : ''}`,
  );
}

const failed = results.filter((r) => r.status === 'FAIL');
const missing = results.filter((r) => r.status === 'UNIMPLEMENTED' && r.required);

console.log('');
if (failed.length > 0) {
  console.error(`${String(failed.length)} suite(s) failed.`);
}
if (missing.length > 0) {
  console.error(
    [
      `${String(missing.length)} required suite(s) are not implemented:`,
      ...missing.map((r) => `  - ${r.name} (pnpm run ${r.script})`),
      '',
      'These are reported as unverified, not as passes. See docs/implementation-status.md',
      'for which gate each belongs to.',
    ].join('\n'),
  );
}

if (failed.length > 0 || missing.length > 0) {
  console.error('\nverify:local FAILED — local verification is not complete.');
  process.exit(1);
}

console.log('verify:local passed — all mandatory non-live checks are green.');
