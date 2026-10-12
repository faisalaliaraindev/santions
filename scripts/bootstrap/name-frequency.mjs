/**
 * Load a measured name-frequency distribution into `nameFrequencyProfiles` (FR-01).
 *
 * # Nothing is loaded today, and that is deliberate
 *
 * This script requires a **real** counts file and refuses to run without one. No distribution
 * is committed to this repository, so on a clean checkout it does nothing but say so.
 *
 * That is not an unfinished job. Inventing plausible-looking deciles would be the single most
 * damaging thing this file could do: the prior is an input to identity grading, and a fabricated
 * one does not look like a gap — it looks like evidence. `NameFrequencyService.lookup` already
 * returns `null` for an unmeasured population, Axis A already treats `null` as "apply no
 * penalty", and the coverage statement already says the prior is missing. All of that is honest.
 * A fabricated file would silently replace it with a lie.
 *
 * # What it costs, stated plainly
 *
 * Without a Costa Rican distribution the FR-08 top-decile penalty never fires for Costa Rican
 * names. A common name therefore reaches a higher identity grade on the same evidence than it
 * would with the distribution loaded. Test T71 covers the mechanism; the mechanism has nothing
 * to act on here. See `describeMissingNameFrequency`.
 *
 * # What is needed before it can run
 *
 * D0 identified the source: the TSE *padrón electoral*, which is a public electoral roll. Its
 * use is subject to an **aggregate-only** condition recorded in the dossier — derive the surname
 * counts, **discard the roll**, and name the use in the SEC-05 approval. That approval does not
 * exist yet, so neither does the file. See `docs/sources/cr-dossier.md`.
 *
 * The roll itself must never be loaded into this service. This script's input is a counts file:
 * a surname and how many people carry it, with no row describing a person. That is enforced by
 * the shape it accepts, not by a note in a runbook.
 *
 * # Usage, once a counts file exists
 *
 *   node scripts/bootstrap/name-frequency.mjs --population CR --file ./cr-surnames.json \
 *     --source-ref "TSE padrón electoral 2026, aggregated surname counts"
 *
 * The file is JSON: `[{ "name": "RODRIGUEZ", "count": 412903 }, ...]`.
 *
 * `nameFrequencyProfiles` is **shared, not tenant-owned**, and must stay that way. Population
 * data is not customer data, and making it tenant-owned would mean measuring the same surname
 * once per customer.
 */

import { readFile } from 'node:fs/promises';

import { assignDeciles } from '../../packages/domain/dist/index.js';

import { log } from '../lib/local-guard.mjs';

/** Fold a name the same way `normaliseName` does for the key it will be looked up by. */
function foldNameKey(value) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (typeof key === 'string' && key.startsWith('--') && value !== undefined) {
      args[key.slice(2)] = value;
    }
  }
  return args;
}

export async function loadNameFrequency(db, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.file === undefined) {
    // The whole point. No file, no data — and a message that says what is missing and why,
    // rather than a silent success that leaves somebody believing a prior was loaded.
    log.info(
      'No name-frequency distribution loaded: no --file was given, and none is committed to ' +
        'this repository.',
    );
    log.info(
      '  Consequence: the FR-08 top-decile penalty does not fire for this population, so a ' +
        'common name reaches a higher identity grade than it would with the distribution.',
    );
    log.info(
      '  Blocked on: the SEC-05 approval for aggregate-only use of the TSE padrón (D0, D-011). ' +
        'See docs/sources/cr-dossier.md.',
    );
    return { loaded: 0, skipped: true };
  }

  const population = args.population;
  const sourceRef = args['source-ref'];
  if (population === undefined || sourceRef === undefined) {
    throw new Error(
      '--population and --source-ref are both required with --file. A distribution whose ' +
        'population or provenance is unrecorded cannot be explained to a reviewer later, and ' +
        'the prior it produces would be unattributable.',
    );
  }

  const raw = JSON.parse(await readFile(args.file, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error('The counts file must be a JSON array of { name, count } objects.');
  }

  const counts = raw.map((row) => {
    if (typeof row?.name !== 'string' || typeof row?.count !== 'number') {
      throw new Error(
        `Every row must be { name: string, count: number }. Got: ${JSON.stringify(row)}. ` +
          'If your file has one row per person, it is a roll and not a counts file — aggregate ' +
          'it before it reaches this service (D0 aggregate-only condition).',
      );
    }
    return { nameKey: foldNameKey(row.name), count: row.count };
  });

  // Pure, tested, and the part that is easy to get wrong. See the domain module for why the
  // deciles are drawn on population mass rather than on the surname ranking.
  const deciles = assignDeciles(counts);

  const profiles = db.collection('nameFrequencyProfiles');
  await profiles.createIndex({ nameKey: 1, population: 1 }, { unique: true });

  let loaded = 0;
  for (const entry of deciles) {
    await profiles.updateOne(
      { nameKey: entry.nameKey, population },
      {
        $set: {
          nameKey: entry.nameKey,
          population,
          decile: entry.decile,
          sourceRef,
          // The count is kept so the decile can be re-derived and checked. Note what is **not**
          // kept: anything about a person.
          count: entry.count,
          loadedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    loaded += 1;
  }

  log.created(`nameFrequencyProfiles: ${String(loaded)} names for population ${population}`);
  return { loaded, skipped: false };
}
