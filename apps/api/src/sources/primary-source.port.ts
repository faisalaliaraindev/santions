/**
 * `PrimarySourcePort` — cascade rung 1 (FR-05).
 *
 * Court and judgment APIs, prosecutor and law-enforcement newsrooms, regulator registers and
 * enforcement archives, insolvency and gazette publications, development-bank debarment lists,
 * and public designation lists.
 *
 * **A primary record is not a lead, and the type says so.** A rung-2 headline says an article
 * exists that mentions a name; a rung-1 record is the naming authority's own publication of an
 * act. FR-11's authority axis (axis D) reads that difference, so it has to survive as far as
 * the banding engine — which it cannot if both arrive as `Lead`.
 *
 * Two things it deliberately does **not** carry.
 *
 * **No category.** Classification happens against the versioned FR-03 taxonomy, under the
 * version the search pinned. A source adapter that assigned a category would be classifying
 * under whatever taxonomy shipped with the adapter, and a historical search would then fail to
 * explain itself under its own pinned version (FR-03).
 *
 * **No identity grade.** The record names a person; whether that person is the subject is axis
 * A's decision and needs the name-frequency prior and the identifier set. An adapter returning
 * a match rather than a mention is the FR-02 failure — "unresolved officers must not attach
 * companies automatically" — in a different costume.
 *
 * One exception to "leads only" is spelled out in FR-05 and enforced here: public designation
 * and notice lists are usable **as leads only**, so an adapter serving one declares
 * `leadsOnly: true` and a designation never presents as a naming-authority record.
 *
 * **No adapter here is written in Phase D.** Phase E, behind this seam.
 */

import type { CountryCode, PreciseDate } from '@adverse-search/domain';

import type { AdapterDescriptor, SourceOutcome } from './source-adapter.js';

export const PRIMARY_SOURCE_PORT = 'PRIMARY_SOURCE_PORT';

/**
 * What kind of primary publication this is.
 *
 * Not cosmetic: FR-11's authority axis treats a court judgment and a regulator press release
 * differently, and D1's capability coverage is declared per capability — a jurisdiction can
 * have `COURT_RECORDS` unsupported while `GAZETTE_NOTICES` is supported, which is exactly the
 * Costa Rican situation D0 found.
 */
export type PrimaryRecordKind =
  | 'COURT_JUDGMENT'
  | 'COURT_DOCKET'
  | 'PROSECUTOR_BULLETIN'
  | 'REGULATOR_ENFORCEMENT'
  | 'GAZETTE_NOTICE'
  | 'INSOLVENCY_NOTICE'
  | 'DEBARMENT_LISTING'
  | 'DESIGNATION_LISTING';

/**
 * A name as the primary source printed it, with nothing inferred.
 *
 * `depersonalised` exists because of D15. Costa Rica's Poder Judicial publishes judgments
 * through a de-identification protocol, and a judgment with the names stripped is not a weak
 * match — there is no name in it to match. An adapter that returned such a document with an
 * empty `subjectNames` and no flag would let the pipeline treat "we cannot tell" as "not this
 * person". The flag makes the difference recordable.
 */
export interface PrimaryNaming {
  readonly subjectNames: readonly string[];
  /** The body that published this: a court, a regulator, a prosecutor. */
  readonly namingAuthority: string;
  /** True when the publisher applies a de-identification protocol to this document class. */
  readonly depersonalised: boolean;
}

export interface PrimaryRecord {
  readonly recordId: string;
  readonly kind: PrimaryRecordKind;
  readonly jurisdiction: CountryCode;
  /** Where the record can be read. The fetch gate (FR-06) still applies before retrieval. */
  readonly url: string;
  readonly title: string;
  readonly naming: PrimaryNaming;
  /** FR-07's four dates, each with declared precision. A missing one stays null. */
  readonly eventDate: PreciseDate;
  readonly publicationDate: PreciseDate;
  readonly updateDate: PreciseDate;
  readonly language: string | null;
  /** Company identifiers named in the record, for the FR-02 graph to corroborate against. */
  readonly companyRefs: readonly string[];
  /**
   * FR-05: "Source tiers describe authority for the reported act, not confidence that the
   * customer is the person named." 1 is highest. Declared by the registry, carried here so the
   * banding engine does not have to re-resolve the source to band a finding.
   */
  readonly authorityTier: number;
  /** True for designation and notice lists: usable as a lead, never as a naming authority. */
  readonly leadsOnly: boolean;
}

export interface PrimarySourceQuery {
  readonly tenantId: string;
  readonly queryId: string;
  readonly jurisdiction: CountryCode;
  /** The name to look for, in a form the source can accept. */
  readonly name: string;
  /** A company identifier, when the query is anchored on an eligible company instead. */
  readonly companyRef: string | null;
  readonly window: { readonly from: string; readonly to: string } | null;
  readonly limit: number;
}

export interface PrimarySourcePort {
  readonly descriptor: AdapterDescriptor;
  readonly recordKinds: readonly PrimaryRecordKind[];

  search(query: PrimarySourceQuery): Promise<SourceOutcome<readonly PrimaryRecord[]>>;

  /**
   * Fetch one record by its identifier.
   *
   * Present because a search result and the document behind it are retrieved at different
   * times and the second retrieval can fail on its own — a docket that lists a judgment whose
   * PDF 404s is a coverage gap for that judgment, not for the search.
   */
  fetchRecord(recordId: string): Promise<SourceOutcome<PrimaryRecord>>;
}
