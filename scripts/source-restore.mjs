#!/usr/bin/env node
/**
 * `pnpm source:restore` — bring a SUSPENDED source version back to ACTIVE, over the real Admin API.
 *
 * # Why this is its own script and not part of `source:onboard`
 *
 * `source-onboard.mjs` walks a source **into** the registry: propose → submit → approve →
 * activate. It is written for a source that has no usable version yet, and it is content-driven —
 * it compares what it would propose against what exists and creates a version when they differ.
 *
 * Restoring is the opposite shape. The version already exists, it was already approved once, and
 * the only thing that changed is that somebody suspended it. Feeding that through the onboarding
 * script would either propose a duplicate version of something already correct, or require the
 * onboarding script to grow a second mode — and a script with two modes is one nobody reads
 * carefully before running.
 *
 * # RESTORE is not a status flip
 *
 * `packages/domain/src/lifecycle/versioned-lifecycle.ts` gives RESTORE three requirements that
 * SUSPEND does not have, and all three are the point:
 *
 * - **Four eyes.** The acting principal must differ from the version's `proposedBy`. A source
 *   somebody suspended is a source somebody had a reason to stop, and one person must not be able
 *   to undo that alone.
 * - **A reason, required.** It lands in the version's own history, permanently.
 * - **Rights clearance re-evaluated** (SEC-05). A licence that lapsed during the suspension must
 *   not be restored past. This is why restoring goes back through the gate rather than writing
 *   `ACTIVE` onto the record.
 *
 * So this script does what a person with the same credential would do by hand through Postman
 * folder 5 — nothing more. It writes nothing to Mongo and holds no privileged access of its own.
 *
 * ## Usage
 *
 * ```
 * pnpm source:restore                                        # plan only, changes nothing
 * pnpm source:restore --apply --source sec-press-releases --reason "..."
 * ```
 *
 * The credential comes from the environment, never from an argument — an argument lands in shell
 * history and in the process table:
 *
 * ```
 * SOURCE_APPROVER_KEY=erly_... pnpm source:restore --apply --source sec-press-releases \
 *   --reason "Restored because ..."
 * ```
 *
 * `--source` may be repeated. With no `--source`, every SUSPENDED source version is listed and
 * nothing is restored: a blanket restore is exactly the act that should require naming what is
 * being restored.
 */

const BASE_URL = process.env['ADMIN_BASE_URL'] ?? 'http://127.0.0.1:3000';

function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** Every `--name value` occurrence, in order. */
function values(name) {
  const found = [];
  for (const [index, argument] of process.argv.entries()) {
    if (argument === `--${name}` && index + 1 < process.argv.length) {
      found.push(process.argv[index + 1]);
    }
  }
  return found;
}

function single(name) {
  const found = values(name);
  return found.length === 0 ? null : found[found.length - 1];
}

async function call(method, path, key, body, ifMatch) {
  const headers = { authorization: `ApiKey ${key}` };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (ifMatch !== undefined) {
    headers['if-match'] = String(ifMatch);
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function ok(status) {
  return status >= 200 && status < 300;
}

async function main() {
  const apply = flag('apply');
  const requested = values('source');
  const reason = single('reason');
  const key = process.env['SOURCE_APPROVER_KEY'] ?? '';

  console.log(`
────────────────────────────────────────────────────────────────────────
  SOURCE RESTORE — SUSPENDED -> ACTIVE, through four eyes and SEC-05
────────────────────────────────────────────────────────────────────────
  API   ${BASE_URL}
  Mode  ${apply ? 'APPLY — this changes the registry' : 'PLAN — nothing is sent'}
`);

  if (key === '') {
    console.error('SOURCE_APPROVER_KEY is not set. It must be a source_admin credential, and it\n');
    console.error('must NOT be the credential that proposed the version — four eyes means two.\n');
    process.exit(1);
  }

  const listed = await call('GET', '/v1/admin/sources?limit=200', key);
  if (!ok(listed.status)) {
    console.error(`Could not read the source registry: HTTP ${String(listed.status)}`);
    console.error(JSON.stringify(listed.body, null, 2));
    process.exit(1);
  }

  const items = Array.isArray(listed.body?.items) ? listed.body.items : [];
  const suspended = items.filter((item) => item.status === 'SUSPENDED');

  if (suspended.length === 0) {
    console.log('  No SUSPENDED source version exists. Nothing to restore.\n');
    return;
  }

  console.log('  SUSPENDED source versions:\n');
  for (const item of suspended) {
    const mark = requested.includes(item.recordId) ? '->' : '  ';
    console.log(
      `  ${mark} ${String(item.recordId).padEnd(30)} v${String(item.version).padEnd(3)} ` +
        `revision ${String(item.revision)}`,
    );
  }
  console.log('');

  if (requested.length === 0) {
    console.log('  Name what to restore with --source <sourceId>. Nothing was sent.\n');
    return;
  }

  const targets = requested.map((sourceId) => {
    const found = suspended.find((item) => item.recordId === sourceId);
    if (found === undefined) {
      console.error(`  ${sourceId} is not a SUSPENDED source version. Refusing to guess.`);
      process.exit(1);
    }
    return found;
  });

  if (reason === null || reason.trim() === '') {
    console.error('  --reason is required. RESTORE records it permanently in the version history.\n');
    process.exit(1);
  }

  if (!apply) {
    console.log(`  Would restore ${targets.length} version(s) with the reason:\n`);
    console.log(`    ${reason}\n`);
    console.log('  Nothing was sent. Re-run with --apply\n');
    return;
  }

  let failures = 0;

  for (const target of targets) {
    const path =
      `/v1/admin/sources/${encodeURIComponent(target.recordId)}` +
      `/versions/${String(target.version)}/transitions`;

    const restored = await call('POST', path, key, { action: 'RESTORE', reason }, target.revision);

    if (!ok(restored.status)) {
      console.error(`  ${target.recordId}: RESTORE refused — HTTP ${String(restored.status)}`);
      console.error(`    ${JSON.stringify(restored.body)}`);
      failures += 1;
      continue;
    }

    let status = restored.body?.status ?? 'UNKNOWN';
    let revision = restored.body?.revision ?? target.revision;
    console.log(`  ${target.recordId}: RESTORE -> ${String(status)}`);

    // RESTORE lands in ACTIVATING when the record's activation is a two-step gate, and the
    // rights clearance is evaluated by `activate`. Left at ACTIVATING a source is neither
    // suspended nor usable, so the second step belongs here rather than in the operator's head.
    if (status === 'ACTIVATING' || status === 'APPROVED') {
      const activatePath =
        `/v1/admin/sources/${encodeURIComponent(target.recordId)}` +
        `/versions/${String(target.version)}/activate`;
      const activated = await call('POST', activatePath, key, undefined, revision);

      if (!ok(activated.status)) {
        console.error(`  ${target.recordId}: activate refused — HTTP ${String(activated.status)}`);
        console.error(`    ${JSON.stringify(activated.body)}`);
        failures += 1;
        continue;
      }

      status = activated.body?.version?.status ?? 'UNKNOWN';
      revision = activated.body?.version?.revision ?? revision;

      if (activated.body?.activated !== true) {
        console.error(
          `  ${target.recordId}: the SEC-05 rights gate refused activation — the source is ` +
            `${String(status)}, not ACTIVE.`,
        );
        console.error(`    clearance: ${JSON.stringify(activated.body?.clearance)}`);
        failures += 1;
        continue;
      }

      console.log(`  ${target.recordId}: activate -> ${String(status)}`);
    }

    if (status !== 'ACTIVE') {
      console.error(`  ${target.recordId}: ended at ${String(status)}, not ACTIVE.`);
      failures += 1;
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`  ${String(failures)} source(s) did not reach ACTIVE.\n`);
    process.exit(1);
  }
  console.log('  Done. Confirm with GET /v1/admin/sources on a source_admin credential.\n');
}

await main();
