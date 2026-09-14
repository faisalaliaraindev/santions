/**
 * The company-registry fixture corpus.
 *
 * **Authored against the tests, before the resolver that will consume it.** D2's brief is
 * explicit about the order, and the reason is that fixtures written after a resolver test what
 * the resolver already does. These were written from T14, T15 and T20 in section 9, and each
 * block below names the test it exists for and the distinction that test needs to survive.
 *
 * Every record here is fixture data. `mode: 'MOCK'` is stamped by the adapter's provenance on
 * the way out (T55), and the adapter itself cannot be constructed in live mode — see
 * `MockModeWitness`.
 *
 * Jurisdiction is **CR** throughout, because D-010 enables Costa Rica only and fixtures that
 * exercise the graph in a jurisdiction the tenant cannot search would be testing a path no
 * search takes. The one real adapter in this phase is British and is labelled as such; that is
 * a separate thing and is not coverage. See `companies-house.adapter.ts`.
 *
 * **Determinism.** Arrays here are already in `officerRef` / `companyRef` order and the mock
 * sorts again before returning. A mock whose ordering is incidental makes a graph test flaky
 * in a way that reads as a resolution bug, and someone then spends a day on the resolver.
 */

import type { Directorship, OfficerCandidate, RegistryCompany } from '../company-registry.port.js';

/** The jurisdiction every fixture below belongs to. */
export const FIXTURE_JURISDICTION = 'CR';

/**
 * T14 — two officers who genuinely share a name.
 *
 * Not a near-match and not a transliteration variant: the register holds the *same string*
 * twice, for two different people, with different identifiers and disjoint companies. This is
 * the case FR-02's "unresolved officers must not attach companies automatically" is written
 * for, and it only tests anything if the names are byte-identical — a fixture with "María" and
 * "Maria" tests the name matcher instead, and passes for the wrong reason.
 *
 * The identifiers are deliberately **partial and non-overlapping**: a birth month and year,
 * which is what a register that publishes anything at all typically publishes. Axis A can
 * separate these two people; nothing weaker can.
 */
export const SHARED_NAME = 'María Fernanda Solís Rojas';

/**
 * T20 — a name that matches more officers than any sensible one-hop bound.
 *
 * Twelve officers, all with the same common name. A bound of five leaves seven unseen, and the
 * question T20 asks is whether the result says so or quietly reports the five.
 */
export const HIGH_FREQUENCY_NAME = 'Juan Carlos Rodríguez';

/** T20 — a name the register holds nothing for. Must not read as "no associations exist". */
export const ABSENT_NAME = 'Wilberth Zamora Quesada';

/** T15 — the officer whose appointments produce all five tenure labels. */
export const TENURE_SUBJECT_NAME = 'Ana Lucía Vargas Méndez';

function officer(
  officerRef: string,
  name: string,
  identifiers: readonly { kind: string; value: string; partial: boolean }[],
  appointmentCount: number | null,
): OfficerCandidate {
  return {
    officerRef,
    name,
    jurisdiction: FIXTURE_JURISDICTION,
    identifiers,
    appointmentCount,
  };
}

/**
 * The officers.
 *
 * `appointmentCount` is null for one of the T14 pair on purpose. Registers vary in whether
 * they publish it, and code that decides whether a traversal will exceed its bound by reading
 * this field must handle the register that does not say — otherwise the bound check works in
 * the fixture and silently does nothing against half the real world.
 */
export const FIXTURE_OFFICERS: readonly OfficerCandidate[] = [
  // T14 — the shared-name pair.
  officer(
    'cr-officer-0001',
    SHARED_NAME,
    [
      { kind: 'DATE_OF_BIRTH', value: '1972-03', partial: true },
      { kind: 'NATIONALITY', value: 'CR', partial: false },
    ],
    1,
  ),
  officer(
    'cr-officer-0002',
    SHARED_NAME,
    [
      { kind: 'DATE_OF_BIRTH', value: '1985-11', partial: true },
      { kind: 'NATIONALITY', value: 'CR', partial: false },
    ],
    // Deliberately unpublished. See the note above.
    null,
  ),
  // T15 — the tenure subject.
  officer(
    'cr-officer-0003',
    TENURE_SUBJECT_NAME,
    [{ kind: 'DATE_OF_BIRTH', value: '1968-07', partial: true }],
    5,
  ),
  // T20 — twelve officers sharing a common name.
  ...Array.from({ length: 12 }, (_, i) =>
    officer(
      `cr-officer-01${String(i + 10).padStart(2, '0')}`,
      HIGH_FREQUENCY_NAME,
      [{ kind: 'DATE_OF_BIRTH', value: `19${String(60 + i).padStart(2, '0')}-04`, partial: true }],
      1,
    ),
  ),
];

function company(
  companyRef: string,
  name: string,
  status: RegistryCompany['status'],
  incorporatedOn: string,
): RegistryCompany {
  return {
    companyRef,
    name,
    jurisdiction: FIXTURE_JURISDICTION,
    status,
    incorporatedOn: { value: incorporatedOn, precision: 'DAY' },
  };
}

export const FIXTURE_COMPANIES: readonly RegistryCompany[] = [
  company('CR-3101-100001', 'Inversiones Talamanca S.A.', 'ACTIVE', '2011-04-18'),
  company('CR-3101-100002', 'Comercial Guanacaste Limitada', 'ACTIVE', '2008-09-02'),
  company('CR-3101-100003', 'Servicios Portuarios Caribe S.A.', 'DISSOLVED', '2004-01-30'),
  company('CR-3101-100004', 'Agroexportadora Sarapiquí S.A.', 'ACTIVE', '2014-11-11'),
  company('CR-3101-100005', 'Constructora Monteverde S.A.', 'LIQUIDATION', '2016-02-25'),
  company('CR-3101-100006', 'Transportes Puntarenas S.A.', 'UNKNOWN', '2001-06-14'),
];

function directorship(
  officerRef: string,
  companyRef: string,
  companyName: string,
  role: string,
  appointed: { value: string | null; precision: 'DAY' | 'MONTH' | 'YEAR' | 'UNKNOWN' },
  resigned: { value: string | null; precision: 'DAY' | 'MONTH' | 'YEAR' | 'UNKNOWN' },
): Directorship {
  return {
    officerRef,
    companyRef,
    companyName,
    jurisdiction: FIXTURE_JURISDICTION,
    role,
    tenure: { appointedOn: appointed, resignedOn: resigned },
    // Fixed, like the mock clock: an observed date that moves makes every assertion about
    // currency drift with the calendar, and a test written in March fails in April.
    observedAt: '2026-01-01T00:00:00.000Z',
  };
}

const UNKNOWN_DATE = { value: null, precision: 'UNKNOWN' } as const;

/**
 * T15 — five directorships chosen so that a fixed set of events produces all five tenure
 * labels through `labelTenure`. The labels are **not** stored here; they are computed, because
 * storing them would test the fixture rather than the labelling.
 *
 * Read this table with `TENURE_PROBE_EVENTS` below — the two were written together:
 *
 * | Company        | Tenure                              | Probe event      | Label          |
 * | :------------- | :---------------------------------- | :--------------- | :------------- |
 * | ...100001      | 2015-01-15 → 2020-06-30, DAY/DAY    | 2018-05-02       | DURING_TENURE  |
 * | ...100002      | 2019-01-10 → none                   | 2016-03-01       | BEFORE_TENURE  |
 * | ...100003      | 2010-01-05 → 2012-12-31, DAY/DAY    | 2018-05-02       | AFTER_TENURE   |
 * | ...100004      | 2017-06-01 → 2019-06-01, DAY/DAY    | 2017-01-01→12-31 | SPANNING       |
 * | ...100005      | 2019 (YEAR) → none                  | 2019-07-01       | UNKNOWN        |
 *
 * The last two rows are the ones the brief asks for by name. `...100005` has **both** an
 * appointment known only to the year and no resignation at all, and it is the case that most
 * often gets mislabelled `DURING_TENURE`: the event falls inside the calendar year of the
 * appointment, so a comparison that ignores precision says "during" and attaches the event to
 * a person who may have been appointed five months after it. `labelTenure` widens the year to
 * its full range and answers UNKNOWN, and this row is here to keep it doing that.
 *
 * `...100002` is the other trap, in the other direction: no resignation recorded. FR-02 is
 * explicit that an unknown end date does not prove current status, so this row exists to be
 * checked against `isConfirmedCurrent` as well as `labelTenure`.
 */
export const FIXTURE_DIRECTORSHIPS: readonly Directorship[] = [
  // T14 — the shared-name pair, with disjoint companies. If a resolver attaches the wrong
  // person's companies, it attaches *these*, and the test can name which one it got.
  directorship(
    'cr-officer-0001',
    'CR-3101-100001',
    'Inversiones Talamanca S.A.',
    'presidente',
    { value: '2015-01-15', precision: 'DAY' },
    { value: '2020-06-30', precision: 'DAY' },
  ),
  directorship(
    'cr-officer-0002',
    'CR-3101-100006',
    'Transportes Puntarenas S.A.',
    'secretario',
    { value: '2021-02-01', precision: 'DAY' },
    UNKNOWN_DATE,
  ),

  // T15 — the five.
  directorship(
    'cr-officer-0003',
    'CR-3101-100001',
    'Inversiones Talamanca S.A.',
    'director',
    { value: '2015-01-15', precision: 'DAY' },
    { value: '2020-06-30', precision: 'DAY' },
  ),
  directorship(
    'cr-officer-0003',
    'CR-3101-100002',
    'Comercial Guanacaste Limitada',
    'apoderado generalísimo',
    { value: '2019-01-10', precision: 'DAY' },
    UNKNOWN_DATE,
  ),
  directorship(
    'cr-officer-0003',
    'CR-3101-100003',
    'Servicios Portuarios Caribe S.A.',
    'tesorero',
    { value: '2010-01-05', precision: 'DAY' },
    { value: '2012-12-31', precision: 'DAY' },
  ),
  directorship(
    'cr-officer-0003',
    'CR-3101-100004',
    'Agroexportadora Sarapiquí S.A.',
    'director',
    { value: '2017-06-01', precision: 'DAY' },
    { value: '2019-06-01', precision: 'DAY' },
  ),
  directorship(
    'cr-officer-0003',
    'CR-3101-100005',
    'Constructora Monteverde S.A.',
    'fiscal',
    // Year precision, and no resignation. The two traps in one row.
    { value: '2019-01-01', precision: 'YEAR' },
    UNKNOWN_DATE,
  ),

  // T20 — one appointment each for the twelve common-name officers, so that a bounded officer
  // search and a bounded appointment traversal are separately observable.
  ...Array.from({ length: 12 }, (_, i) =>
    directorship(
      `cr-officer-01${String(i + 10).padStart(2, '0')}`,
      'CR-3101-100006',
      'Transportes Puntarenas S.A.',
      'director',
      { value: '2018-03-12', precision: 'DAY' },
      UNKNOWN_DATE,
    ),
  ),
];

/**
 * The events that turn the T15 fixture into five labels.
 *
 * Kept beside the fixture rather than in the test, because they are half of the same design:
 * the tenures were chosen so that *these* events land on each side of each boundary. Split
 * across two files, someone edits a tenure and the labels quietly collapse to three.
 */
export const TENURE_PROBE_EVENTS: readonly {
  readonly companyRef: string;
  readonly expected: 'DURING_TENURE' | 'BEFORE_TENURE' | 'AFTER_TENURE' | 'SPANNING' | 'UNKNOWN';
  readonly event: {
    readonly start: { value: string; precision: 'DAY' };
    readonly end: { value: string; precision: 'DAY' };
  };
}[] = [
  {
    companyRef: 'CR-3101-100001',
    expected: 'DURING_TENURE',
    event: {
      start: { value: '2018-05-02', precision: 'DAY' },
      end: { value: '2018-05-02', precision: 'DAY' },
    },
  },
  {
    companyRef: 'CR-3101-100002',
    expected: 'BEFORE_TENURE',
    event: {
      start: { value: '2016-03-01', precision: 'DAY' },
      end: { value: '2016-03-01', precision: 'DAY' },
    },
  },
  {
    companyRef: 'CR-3101-100003',
    expected: 'AFTER_TENURE',
    event: {
      start: { value: '2018-05-02', precision: 'DAY' },
      end: { value: '2018-05-02', precision: 'DAY' },
    },
  },
  {
    companyRef: 'CR-3101-100004',
    expected: 'SPANNING',
    event: {
      start: { value: '2017-01-01', precision: 'DAY' },
      end: { value: '2017-12-31', precision: 'DAY' },
    },
  },
  {
    companyRef: 'CR-3101-100005',
    expected: 'UNKNOWN',
    event: {
      start: { value: '2019-07-01', precision: 'DAY' },
      end: { value: '2019-07-01', precision: 'DAY' },
    },
  },
];
