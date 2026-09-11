/**
 * C4 — the subject population the search-index workload test measures against.
 *
 * **Why this exists at all.** The FR-16 labelled corpus holds sixteen cases. Sixteen names is a
 * correctness fixture, not a workload: every index answers a sixteen-document query in under a
 * millisecond, so a latency measured over it would say nothing about either candidate and would
 * close D12 on noise. So the FR-16 names are used as the *queries* — they are the hard ones,
 * chosen to be hard — and this module generates the *haystack* they have to be found in.
 *
 * **What makes the haystack honest.** A population of random unrelated names is also no test: an
 * index finds a unique string trivially, whatever its analyser does. What discriminates the two
 * candidates is whether the right subject surfaces when the population is full of names that
 * look almost the same. So the generator plants, around every query target:
 *
 * - **collisions** — other people with the identical name (the FR-16 corpus already contains a
 *   `HIGH_FREQUENCY_NAME` case for exactly this reason),
 * - **near misses** — one edit away, a shared surname, a shared phonetic key,
 * - **shared blocking keys** — different names that fold to the same sorted core or the same
 *   phonetic key, which is what makes a blocking strategy expensive rather than free.
 *
 * Everything here is pure and deterministic: same seed, same population, byte for byte. A
 * benchmark whose corpus changes between runs cannot be compared against its own previous run,
 * and a decision record citing an unreproducible number is not evidence.
 *
 * This is a synthetic corpus. Names are invented and are not intended to refer to any real
 * person or company.
 */

import { normaliseName, phoneticKeys } from '@erly/adverse-domain';

import { SEED_DATASET } from '../dataset/seed.js';

/**
 * The shape the index holds, mirrored here **structurally** rather than imported.
 *
 * `SubjectIndexDocument` lives in `apps/api/src/search-index`, and this package must not depend
 * on the API — it is pure by contract, and the I1–I10 harness has to run with no I/O. The
 * benchmark runner maps this to the real projection, so the fields are the fields the index
 * actually stores.
 */
export interface WorkloadSubject {
  readonly subjectVersionId: string;
  readonly subjectId: string;
  readonly version: number;
  readonly tenantId: string;
  readonly nameOriginal: string;
  readonly nameFolded: string;
  readonly sortedCoreKey: string;
  readonly phoneticKeys: readonly string[];
  readonly aliasesFolded: readonly string[];
  readonly countryContext: readonly string[];
  readonly scripts: readonly string[];
}

/**
 * How a query differs from the name the index holds.
 *
 * These are the FR-08 name forms, one class each, because a single blended recall figure hides
 * the only thing the D12 decision turns on: *which* forms an index handles. An index that is
 * excellent at typos and blind to transliteration is not "85% good", it is unusable for the
 * Cyrillic and Arabic names this service exists to screen.
 */
export const QUERY_CLASSES = [
  'EXACT',
  'WORD_ORDER',
  'PARTICLE',
  'INITIAL_EXPANSION',
  'DIACRITIC',
  'PHONETIC',
  'TRANSLITERATION',
  'TYPO',
] as const;
export type QueryClass = (typeof QUERY_CLASSES)[number];

export interface WorkloadQuery {
  readonly queryId: string;
  readonly class: QueryClass;
  /** The string a caller would actually type. */
  readonly text: string;
  /** The FR-16 case this query descends from, so a failure names a real labelled case. */
  readonly caseId: string;
  /**
   * The subject the index must return. Recall is measured against this one id — not against
   * "something plausible came back", which is how a retrieval test passes while retrieving the
   * wrong person.
   */
  readonly expectedSubjectVersionId: string;
}

export interface WorkloadPopulation {
  readonly tenantId: string;
  readonly subjects: readonly WorkloadSubject[];
  readonly queries: readonly WorkloadQuery[];
  /** Recorded in the decision record. A latency without its corpus size is not a measurement. */
  readonly size: number;
  readonly seed: number;
}

// ---- deterministic randomness ---------------------------------------------------------------

/** mulberry32 — small, fast, and identical on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(values: readonly T[], next: () => number): T {
  const value = values[Math.floor(next() * values.length) % values.length];
  if (value === undefined) {
    throw new Error('Empty pool: the population generator cannot pick from nothing.');
  }
  return value;
}

// ---- name pools -----------------------------------------------------------------------------

/**
 * Deliberately multi-script and multi-tradition.
 *
 * A pool of Anglophone names would make the population easy in precisely the way real screening
 * is not: patronymic chains, particles, and non-Latin scripts are where a naive analyser loses
 * recall, and a generator that omits them measures the easy case and calls it the workload.
 */
const GIVEN_NAMES: readonly string[] = [
  'Aleksandr',
  'Amara',
  'Aminata',
  'Anders',
  'Anne-Marie',
  'Beatriz',
  'Camila',
  'Chidi',
  'Dmitri',
  'Elena',
  'Elin',
  'Emeka',
  'Farhan',
  'Fatima',
  'Femi',
  'Giulia',
  'Harpreet',
  'Ingrid',
  'Ismail',
  'Jean-Luc',
  'João',
  'John',
  'José',
  'Katarzyna',
  'Kwabena',
  'Lars',
  'Léa',
  'Mariana',
  'Mehmet',
  'Mohammed',
  'Ngozi',
  'Nikolai',
  'Olusegun',
  'Priya',
  'Rhys',
  'Rui',
  'Sanjay',
  'Siobhán',
  'Suleiman',
  'Tomas',
  'Vikram',
  'Yusuf',
  'Zainab',
  'Zhang',
];

const SURNAMES: readonly string[] = [
  'Abubakar',
  'Andersson',
  'Berec',
  'Braga',
  'Chen',
  'Diallo',
  'Ferreira',
  'Fitzgerald',
  'Halvorsen',
  'Haruna',
  'Ivanov',
  'Kaur',
  'Kowalski',
  'Lindqvist',
  'Mensah',
  'Mordaunt',
  'Nowak',
  'Okonkwo',
  'Oyelaran',
  'Petrov',
  'Raghunathan',
  'Rossi',
  'Sharma',
  'Silva',
  'Smith',
  'Solís-Rojas',
  'Vasquez',
  'Williams',
  'Yilmaz',
  'Zhao',
];

/** Particles are generated as part of the name, not appended: they belong to the tradition. */
const PARTICLE_SURNAMES: readonly string[] = [
  'van der Berg',
  'de Vries',
  'von Habsburg',
  'bin Rashid',
  'al-Masri',
  'da Costa',
  'del Rosario',
  'O’Sullivan',
];

const COUNTRIES: readonly string[] = ['GB', 'US', 'NG', 'IN', 'BR', 'PL', 'SE', 'AE', 'CN', 'RU'];

// ---- query derivation -----------------------------------------------------------------------

/**
 * Cyrillic and Arabic renderings for the FR-16 names that plausibly have one.
 *
 * Kept as an explicit table rather than generated: a machine-transliterated string would test
 * whether our transliteration matches our transliteration, which is a tautology. These are the
 * forms a document in the source language would actually carry, and the index has the Latin
 * form — which is the real asymmetry FR-08 exists for.
 */
const NON_LATIN_FORMS: Readonly<Record<string, string>> = {
  'Tomas Berec': 'Томас Берец',
  'Suleiman Haruna': 'سليمان هارونا',
  'Katarzyna Nowak': 'Катажина Новак',
  'Aminata Diallo': 'أميناتا ديالو',
};

/** A respelling that preserves the phonetic key but not the letters. */
function respell(name: string): string {
  return name
    .replace(/c(?=[aou])/gu, 'k')
    .replace(/ph/giu, 'f')
    .replace(/v/gu, 'w')
    .replace(/z(?=[aeiou])/giu, 's')
    .replace(/y(?=[aeiou])/giu, 'i')
    .replace(/ei/gu, 'ie');
}

/** One transposition in the longest token: the single most common real typing error. */
function transpose(name: string): string {
  const tokens = name.split(' ');
  let longest = 0;
  for (const [i, token] of tokens.entries()) {
    if (token.length > (tokens[longest]?.length ?? 0)) {
      longest = i;
    }
  }
  const token = tokens[longest];
  if (token === undefined || token.length < 4) {
    return name;
  }
  const at = Math.floor(token.length / 2);
  const a = token[at] ?? '';
  const b = token[at - 1] ?? '';
  tokens[longest] = `${token.slice(0, at - 1)}${a}${b}${token.slice(at + 1)}`;
  return tokens.join(' ');
}

function addDiacritics(name: string): string {
  return name
    .replace(/a(?=[bcdfglmnprstvz])/u, 'á')
    .replace(/e(?=[bcdfglmnprstvz])/u, 'é')
    .replace(/o(?=[bcdfglmnprstvz])/u, 'ó');
}

function initialise(name: string): string {
  const tokens = name.split(' ');
  const first = tokens[0];
  if (tokens.length < 2 || first === undefined || first.length < 2) {
    return name;
  }
  return [`${first[0] ?? ''}.`, ...tokens.slice(1)].join(' ');
}

function reorder(name: string): string {
  const tokens = name.split(' ');
  if (tokens.length < 2) {
    return name;
  }
  return [...tokens.slice(1), tokens[0]].join(' ');
}

function withParticle(name: string): string {
  const tokens = name.split(' ');
  if (tokens.length < 2) {
    return name;
  }
  return [...tokens.slice(0, -1), 'de', tokens[tokens.length - 1] ?? ''].join(' ');
}

// ---- generation -----------------------------------------------------------------------------

function toSubject(input: {
  readonly tenantId: string;
  readonly ordinal: number;
  readonly fullName: string;
  readonly aliases: readonly string[];
  readonly countryContext: readonly string[];
}): WorkloadSubject {
  const normalised = normaliseName(input.fullName);
  const id = `wl-${String(input.ordinal).padStart(8, '0')}`;
  return {
    subjectVersionId: `${id}-v1`,
    subjectId: id,
    version: 1,
    tenantId: input.tenantId,
    nameOriginal: input.fullName,
    nameFolded: normalised.folded,
    sortedCoreKey: normalised.sortedCoreKey,
    phoneticKeys: phoneticKeys(normalised),
    aliasesFolded: input.aliases.map((a) => normaliseName(a).folded),
    countryContext: input.countryContext,
    scripts: normalised.scripts,
  };
}

export interface PopulationOptions {
  readonly size: number;
  readonly seed?: number;
  readonly tenantId?: string;
}

/**
 * Build the population and the query set together.
 *
 * Together, because a query is only meaningful if its target is genuinely in the haystack, and
 * the two drifting apart is how a recall figure silently becomes a measurement of nothing.
 */
export function generateWorkloadPopulation(options: PopulationOptions): WorkloadPopulation {
  const seed = options.seed ?? 20260911;
  const tenantId = options.tenantId ?? 'workload-tenant';
  const next = rng(seed);

  const subjects: WorkloadSubject[] = [];
  const queries: WorkloadQuery[] = [];
  let ordinal = 0;

  // 1. Plant every FR-16 case subject, and hang its query set off the planted id.
  for (const labelled of SEED_DATASET.cases) {
    const target = toSubject({
      tenantId,
      ordinal: ordinal++,
      fullName: labelled.subjectName,
      aliases: [],
      countryContext: [labelled.jurisdiction],
    });
    subjects.push(target);

    for (const cls of QUERY_CLASSES) {
      const text = deriveQuery(cls, labelled.subjectName);
      if (text === null) {
        continue;
      }
      queries.push({
        queryId: `${labelled.caseId}-${cls}`,
        class: cls,
        text,
        caseId: labelled.caseId,
        expectedSubjectVersionId: target.subjectVersionId,
      });
    }

    // 2. Crowd the target. Without this the index is asked to find a unique string, which is
    //    not the question — the question is whether it finds the right one among lookalikes.
    for (const distractor of crowd(labelled.subjectName, next)) {
      subjects.push(
        toSubject({
          tenantId,
          ordinal: ordinal++,
          fullName: distractor,
          aliases: [],
          countryContext: [pick(COUNTRIES, next)],
        }),
      );
    }
  }

  // 3. Fill the rest with generated names.
  while (subjects.length < options.size) {
    const given = pick(GIVEN_NAMES, next);
    const surname = next() < 0.12 ? pick(PARTICLE_SURNAMES, next) : pick(SURNAMES, next);
    const middle = next() < 0.25 ? ` ${pick(GIVEN_NAMES, next)}` : '';
    const fullName = `${given}${middle} ${surname}`;
    subjects.push(
      toSubject({
        tenantId,
        ordinal: ordinal++,
        fullName,
        aliases: next() < 0.15 ? [`${pick(GIVEN_NAMES, next)} ${surname}`] : [],
        countryContext: [pick(COUNTRIES, next)],
      }),
    );
  }

  return { tenantId, subjects, queries, size: subjects.length, seed };
}

function deriveQuery(cls: QueryClass, name: string): string | null {
  switch (cls) {
    case 'EXACT':
      return name;
    case 'WORD_ORDER': {
      const reordered = reorder(name);
      return reordered === name ? null : reordered;
    }
    case 'PARTICLE': {
      const particled = withParticle(name);
      return particled === name ? null : particled;
    }
    case 'INITIAL_EXPANSION': {
      const initialled = initialise(name);
      return initialled === name ? null : initialled;
    }
    case 'DIACRITIC': {
      const accented = addDiacritics(name);
      return accented === name ? null : accented;
    }
    case 'PHONETIC': {
      const respelled = respell(name);
      return respelled === name ? null : respelled;
    }
    case 'TRANSLITERATION':
      return NON_LATIN_FORMS[name] ?? null;
    case 'TYPO': {
      const typo = transpose(name);
      return typo === name ? null : typo;
    }
  }
}

/**
 * Names planted next to a target so that finding it is a discrimination problem.
 *
 * Six per target: two exact collisions (different people, same name), a shared surname, a
 * shared given name, a phonetic neighbour, and a one-edit neighbour.
 */
function crowd(name: string, next: () => number): readonly string[] {
  const tokens = name.split(' ');
  const given = tokens[0] ?? name;
  const surname = tokens[tokens.length - 1] ?? name;
  return [
    name,
    name,
    `${pick(GIVEN_NAMES, next)} ${surname}`,
    `${given} ${pick(SURNAMES, next)}`,
    respell(name),
    transpose(name),
  ];
}
