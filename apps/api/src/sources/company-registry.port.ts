/**
 * `CompanyRegistryPort` — the FR-02 association graph's only data source.
 *
 * This is the one port of the six with a **real** adapter in Phase D, because it is the only
 * one the graph needs and the only one whose real contract this phase can settle. See
 * `companies-house.adapter.ts`, and read the jurisdiction note there before assuming it means
 * Costa Rican coverage: it does not.
 *
 * **The port returns candidates, never matches.** FR-02: "Unresolved officers must not attach
 * companies automatically." So `findOfficers` returns `OfficerCandidate` — a person the
 * register holds, with whatever identifiers the register publishes — and nothing in the
 * returned type says whether that person is the subject. Resolution is axis A's decision (D3),
 * made with the name-frequency prior and the full identifier set, and an adapter cannot make
 * it because an adapter does not have either. This is a type-level version of the rule: there
 * is no field on `OfficerCandidate` an adapter could set that would attach a company.
 *
 * **Three outcomes T20 requires to stay distinct.** A registry outage, a registry that returns
 * nothing, and a traversal that exceeded its bound. `SourceOutcome` keeps them apart; the
 * mock's fixtures can produce all three on demand (see `mock/company-registry.mock.ts`).
 *
 * **Dates carry precision and are never backfilled.** An appointment known only to the year is
 * `{ value: '2019-01-01', precision: 'YEAR' }` and `labelTenure` widens it to the whole year.
 * A missing resignation is `{ value: null, precision: 'UNKNOWN' }` — which FR-02 is explicit
 * does *not* mean the directorship is current.
 */

import type { CountryCode, PreciseDate, Tenure } from '@adverse-search/domain';

import type { AdapterDescriptor, SourceOutcome } from './source-adapter.js';

export const COMPANY_REGISTRY_PORT = 'COMPANY_REGISTRY_PORT';

/**
 * An identifier the register publishes about an officer.
 *
 * Deliberately a list of typed pairs rather than named fields. Registers differ in what they
 * publish — Companies House gives a month-and-year of birth and a partial address, others give
 * a national identity number or nothing at all — and a fixed field set forces every adapter to
 * either lie by omission or invent a mapping. Axis A already grades identifiers by kind and
 * strength, so the pair is the shape the grading wants anyway.
 */
export interface OfficerIdentifier {
  /** Matches the axis-A identifier vocabulary: 'DATE_OF_BIRTH', 'NATIONAL_ID', and so on. */
  readonly kind: string;
  readonly value: string;
  /** True when the register publishes only part of it — a birth month and year, a postcode. */
  readonly partial: boolean;
}

/**
 * A person the register holds, as the register holds them.
 *
 * Note what is absent: any notion of match, score or confidence. See the file header.
 */
export interface OfficerCandidate {
  /** The register's own identifier for this officer. Stable per register, not across them. */
  readonly officerRef: string;
  /** The name exactly as printed. Name-form derivation (FR-08) happens elsewhere. */
  readonly name: string;
  readonly jurisdiction: CountryCode;
  readonly identifiers: readonly OfficerIdentifier[];
  /**
   * How many appointments the register says this officer has, when it says. Null when it does
   * not. Used to decide whether a one-hop traversal will exceed its bound *before* spending
   * the calls.
   */
  readonly appointmentCount: number | null;
}

/** A company as the register holds it. */
export interface RegistryCompany {
  /** The register's company identifier — a company number, a cédula jurídica. */
  readonly companyRef: string;
  readonly name: string;
  readonly jurisdiction: CountryCode;
  /**
   * The register's own status string, normalised to a small set. `UNKNOWN` is a real answer
   * for a register that does not publish status, and is not the same as `DISSOLVED`.
   */
  readonly status: 'ACTIVE' | 'DISSOLVED' | 'LIQUIDATION' | 'INACTIVE' | 'UNKNOWN';
  readonly incorporatedOn: PreciseDate;
}

/**
 * A `DIRECTOR_OF` edge, sourced.
 *
 * FR-02 lists exactly what must be stored: source, jurisdiction, company identifier,
 * appointment and resignation dates, date precision, observed date and resolution status. All
 * of it is here except resolution status, which is **not** the adapter's to supply — it is
 * written by D3 when the edge is stored, after axis A has graded the officer. The adapter
 * reports what the register says; the graph decides what it means.
 */
export interface Directorship {
  readonly officerRef: string;
  readonly companyRef: string;
  readonly companyName: string;
  readonly jurisdiction: CountryCode;
  /** The office held, as printed: 'director', 'secretary', 'apoderado generalísimo'. */
  readonly role: string;
  /** Appointment and resignation, with precision. `labelTenure` consumes this directly. */
  readonly tenure: Tenure;
  /**
   * When the register was read. FR-02's "observed date": a directorship with no resignation
   * observed a year ago is a weaker claim to currency than the same edge observed today, and
   * without this the difference is invisible.
   */
  readonly observedAt: string;
}

export interface OfficerSearchQuery {
  readonly tenantId: string;
  readonly jurisdiction: CountryCode;
  readonly name: string;
  /**
   * The FR-02 traversal bound. More candidates than this produces a `BOUNDED` outcome carrying
   * the candidates that fit — never a silent slice, and never an error that loses them.
   */
  readonly limit: number;
}

export interface AppointmentsQuery {
  readonly tenantId: string;
  readonly officerRef: string;
  readonly jurisdiction: CountryCode;
  /** One-hop bound on appointments per officer. Same `BOUNDED` contract as above. */
  readonly limit: number;
}

export interface CompanyRegistryPort {
  readonly descriptor: AdapterDescriptor;

  /**
   * Find officers by name. Candidates, not matches — see the file header.
   *
   * Throws (rather than returning `FAILED`) when asked about a jurisdiction the adapter does
   * not cover: that is a programming error, not a coverage gap. See
   * `assertJurisdictionCovered`.
   */
  findOfficers(query: OfficerSearchQuery): Promise<SourceOutcome<readonly OfficerCandidate[]>>;

  /** The one hop. Appointments for one officer. */
  listAppointments(query: AppointmentsQuery): Promise<SourceOutcome<readonly Directorship[]>>;

  /** A company by its register identifier. */
  getCompany(
    companyRef: string,
    jurisdiction: CountryCode,
  ): Promise<SourceOutcome<RegistryCompany>>;
}
