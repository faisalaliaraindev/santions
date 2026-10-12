/**
 * Phase D step D2 — the vocabulary every FR-05 adapter shares.
 *
 * FR-05 names six seams — news discovery, web discovery, primary sources, company registry,
 * evidence fetch and extraction. They are defined together, and now, for a reason that has
 * nothing to do with tidiness: Phase E builds the discovery and fetch adapters *behind* these
 * seams, and a seam invented at the moment its first adapter is written is shaped by that
 * adapter. Defining all six against the specification, with mocks that have to satisfy them,
 * is what stops `WebDiscoveryPort` from quietly becoming "whatever SearXNG returns".
 *
 * Three things are shared by all six and are declared here rather than six times over.
 *
 * **1. The outcome is a four-way answer, never a list.** T20 requires that a registry outage, a
 * registry that returns nothing, and a registry that returned more than the bound allows are
 * three visibly different results. An adapter that returns `Officer[]` collapses all three into
 * `[]`, and `[]` then reads as "no associations exist" — which is precisely the false clean
 * result FR-02's last sentence forbids ("No result from a registry does not prove no
 * associations exist"). So every call returns a `SourceOutcome`, and the caller cannot obtain
 * the data without first having matched on which of the four happened.
 *
 * **2. Provenance rides with the data, not beside it.** Every outcome carries the adapter id,
 * the parser version and the stability class that produced it. FR-05's volatility-control
 * paragraph keys the scheduled contract test off the parser version, and D5's breaker keys off
 * the stability class; both are useless if the figure has to be looked up from the registry
 * afterwards, because by then the record is a row and the adapter that wrote it is a guess.
 *
 * **3. Mode is on the record and on the adapter.** T55: a fixture must never be servable as a
 * live result. `mode` on the provenance stamp is the record half. The adapter half is
 * `MockModeWitness` below, which is stronger than a stamp.
 */

import {
  classifyFailure,
  type CountryCode,
  type FailurePolicy,
  type FailureSignal,
} from '@adverse-search/domain';

/** Operating mode, matching `ADVERSE_SEARCH_MODE` and the `mode` field on every seeded record. */
export type OperatingMode = 'MOCK' | 'LIVE';

/**
 * FR-05 stability class.
 *
 * `DOCUMENTED_STABLE` means the publisher documents the response shape and versions changes to
 * it. `UNDOCUMENTED_VOLATILE` means we are parsing something that was never promised to us —
 * Google News RSS above all — and a silent shape change there drops recall to zero while the
 * service keeps reporting clean results. That is the failure FR-05's volatility paragraph is
 * written against, so the class is declared per adapter and is not optional.
 */
export type StabilityClass = 'DOCUMENTED_STABLE' | 'UNDOCUMENTED_VOLATILE';

/** Which seam an adapter implements. Recorded so a coverage view can group by capability. */
export type PortKind =
  | 'NEWS_DISCOVERY'
  | 'WEB_DISCOVERY'
  | 'PRIMARY_SOURCE'
  | 'COMPANY_REGISTRY'
  | 'EVIDENCE_FETCH'
  | 'EXTRACTION_MODEL';

/**
 * What an adapter declares about itself, before it is ever called.
 *
 * `jurisdictions` is the load-bearing field and the reason this interface is not just a name.
 * D-010 enables Costa Rica only, and D0 established that the single real registry adapter this
 * phase can write is British. A UK adapter that does not say so is indistinguishable from CR
 * coverage at the point where it matters — a reviewer reading a coverage statement. So the
 * adapter declares the countries it actually covers and the caller checks; see
 * `assertJurisdictionCovered`.
 */
export interface AdapterDescriptor {
  /** Stable across restarts and across parser versions. Used in provenance and in audit. */
  readonly adapterId: string;
  readonly portKind: PortKind;
  /** The registry `sourceId` this adapter reads, so a record can be traced to its approval. */
  readonly sourceId: string;
  /** FR-05: bumped whenever the parse changes. The contract test alerts on a shape change. */
  readonly parserVersion: string;
  readonly stabilityClass: StabilityClass;
  readonly mode: OperatingMode;
  /** ISO 3166-1 alpha-2. FR-05: "EU", "MENA" and "SEA" are not blanket source permissions. */
  readonly jurisdictions: readonly CountryCode[];
}

/** The stamp carried by every record an adapter produces. */
export interface AdapterProvenance {
  readonly adapterId: string;
  readonly sourceId: string;
  readonly parserVersion: string;
  readonly stabilityClass: StabilityClass;
  readonly mode: OperatingMode;
  /** ISO 8601. FR-07's retrieval date — never used to backfill a missing event date. */
  readonly retrievedAt: string;
}

/**
 * Why a call returned fewer results than exist.
 *
 * Separate from the outcome status because a bound and a quota are different facts about the
 * run: FR-04 bounds the traversal on purpose, while `TRUNCATED_BY_QUOTA` (FR-06) means the
 * budget ran out and more would have been available. Reported differently to a reviewer, so
 * recorded differently here.
 */
export type TruncationReason = 'BOUND_EXCEEDED' | 'TRUNCATED_BY_QUOTA' | 'SOURCE_PAGE_LIMIT';

export interface Truncation {
  readonly reason: TruncationReason;
  /** The bound that applied. */
  readonly limit: number;
  /**
   * How many the source said exist, when it says. Null when it does not — which is itself
   * worth recording, because "more than 50, we do not know how many" and "exactly 312" lead a
   * reviewer to different next steps.
   */
  readonly availableCount: number | null;
}

/**
 * The four answers an adapter can give.
 *
 * `NO_RESULTS` and `FAILED` are the pair that must never merge, and `BOUNDED` is the third
 * thing T20 asks for. `BOUNDED` carries data *and* a truncation, because a bounded traversal
 * still produced real associations — discarding them would be worse than reporting them with
 * the bound stated.
 */
export type SourceOutcome<T> =
  | { readonly status: 'OK'; readonly data: T; readonly provenance: AdapterProvenance }
  | {
      readonly status: 'BOUNDED';
      readonly data: T;
      readonly truncation: Truncation;
      readonly provenance: AdapterProvenance;
    }
  | {
      /** The source answered, and its answer was "nothing". Not the same as no answer. */
      readonly status: 'NO_RESULTS';
      readonly provenance: AdapterProvenance;
    }
  | {
      readonly status: 'FAILED';
      readonly signal: FailureSignal;
      /** Classified by the FR-06 table, here, so no caller invents a second taxonomy. */
      readonly policy: FailurePolicy;
      /**
       * What happened, in a sentence a reviewer can act on. Required, never null.
       *
       * The class alone is not enough and the gap was visible in the product: a lead refused
       * because robots.txt disallowed it read as "could not be retrieved (HARD_BLOCK)", which
       * tells a reviewer that something went wrong and nothing about what. The adapter knows the
       * sentence — it logged it — and the coverage record is where a reviewer reads it, so the
       * outcome carries it rather than the log. It describes the *event*, never the subject, and
       * is safe to show: a host, a status code, a robots path.
       */
      readonly detail: string;
      readonly provenance: AdapterProvenance;
    };

/** True when the outcome carries usable data. Narrows, so callers get `data` typed. */
export function hasData<T>(
  outcome: SourceOutcome<T>,
): outcome is Extract<SourceOutcome<T>, { data: T }> {
  return outcome.status === 'OK' || outcome.status === 'BOUNDED';
}

/**
 * Did this call leave coverage incomplete?
 *
 * A failure and a bound both do; an empty answer from a working source does not. This is the
 * one-line version of the distinction the whole outcome type exists to preserve, and it is
 * here so that the fifteenth caller does not write `status !== 'OK'` and silently start
 * reporting "nothing found" as a coverage gap.
 */
export function leavesCoverageIncomplete(outcome: SourceOutcome<unknown>): boolean {
  return outcome.status === 'FAILED' || outcome.status === 'BOUNDED';
}

/** Build the provenance stamp for a descriptor at a moment. */
export function stampProvenance(
  descriptor: AdapterDescriptor,
  retrievedAt: Date,
): AdapterProvenance {
  return {
    adapterId: descriptor.adapterId,
    sourceId: descriptor.sourceId,
    parserVersion: descriptor.parserVersion,
    stabilityClass: descriptor.stabilityClass,
    mode: descriptor.mode,
    retrievedAt: retrievedAt.toISOString(),
  };
}

/** Convenience constructors, so the four statuses are built the same way everywhere. */
export function ok<T>(descriptor: AdapterDescriptor, retrievedAt: Date, data: T): SourceOutcome<T> {
  return { status: 'OK', data, provenance: stampProvenance(descriptor, retrievedAt) };
}

export function bounded<T>(
  descriptor: AdapterDescriptor,
  retrievedAt: Date,
  data: T,
  truncation: Truncation,
): SourceOutcome<T> {
  return {
    status: 'BOUNDED',
    data,
    truncation,
    provenance: stampProvenance(descriptor, retrievedAt),
  };
}

export function noResults<T>(descriptor: AdapterDescriptor, retrievedAt: Date): SourceOutcome<T> {
  return { status: 'NO_RESULTS', provenance: stampProvenance(descriptor, retrievedAt) };
}

/**
 * A failure, classified at the point of observation.
 *
 * Classification happens here and nowhere else (REL-01: classification precedes retry). The
 * adapter supplies facts — a status code, a syscall name — and the FR-06 table decides what
 * they mean. An adapter that decided its own retry policy would be the second taxonomy that
 * `failure-classification.ts` exists to prevent.
 */
export function failed<T>(
  descriptor: AdapterDescriptor,
  retrievedAt: Date,
  signal: FailureSignal,
  detail: string,
): SourceOutcome<T> {
  return {
    status: 'FAILED',
    signal,
    policy: classifyFailure(signal),
    detail,
    provenance: stampProvenance(descriptor, retrievedAt),
  };
}

/**
 * Proof that the process is running in mock mode.
 *
 * D2's brief asks that mock adapters be "unreachable in live mode by construction, not by a
 * runtime check that can be forgotten". This is that construction. The constructor is private,
 * so the only way to obtain a witness is `MockModeWitness.forMode`, which returns `null` for
 * `LIVE`. Every mock adapter takes a witness as its first constructor argument. A live-mode
 * process therefore cannot build one — not because someone remembered to check, but because
 * there is no value in the program that would let it.
 *
 * The difference from an `if (mode === 'LIVE') throw` inside each adapter is that the check
 * cannot be omitted from the *next* mock adapter: omitting it means the constructor does not
 * compile. A check you can forget to write is a check that eventually is not written.
 */
export class MockModeWitness {
  private constructor(readonly mode: 'MOCK') {}

  static forMode(mode: OperatingMode): MockModeWitness | null {
    return mode === 'MOCK' ? new MockModeWitness('MOCK') : null;
  }

  /**
   * For call sites that have already established the mode and want a hard failure otherwise —
   * the composition root, and tests. Throws rather than returning null so a misconfiguration
   * stops the process at startup instead of at the first search.
   */
  static require(mode: OperatingMode): MockModeWitness {
    const witness = MockModeWitness.forMode(mode);
    if (witness === null) {
      throw new Error(
        'Refusing to construct a mock source adapter in LIVE mode: fixture data must never be ' +
          'servable as a live result (test T55).',
      );
    }
    return witness;
  }
}

/**
 * Refuse a call for a jurisdiction the adapter does not cover.
 *
 * Thrown, not returned as a `FAILED` outcome, and the distinction is deliberate. A `FAILED`
 * outcome means the source was asked and did not answer, which produces a coverage gap for
 * that source. Asking a British registry about Costa Rica is not a coverage gap — it is a
 * programming error, and reporting it as a gap would put a line in a coverage statement
 * implying CR officer data was attempted and unavailable, when it was never attempted at all.
 */
export function assertJurisdictionCovered(
  descriptor: AdapterDescriptor,
  jurisdiction: CountryCode,
): void {
  if (!descriptor.jurisdictions.includes(jurisdiction)) {
    throw new Error(
      `Adapter ${descriptor.adapterId} covers [${descriptor.jurisdictions.join(', ')}] and was ` +
        `asked about ${jurisdiction}. Out-of-jurisdiction coverage is never inferred: a source ` +
        `that does not hold a country's records cannot report on that country (FR-05).`,
    );
  }
}

/**
 * The clock an adapter reads.
 *
 * Injected rather than called, because "the same input returns the same result" is a rule the
 * mocks must actually keep and a `new Date()` inside a mock breaks it in the one field every
 * record carries. Real adapters get `() => new Date()` from the composition root; mocks get a
 * fixed instant unless a test supplies otherwise.
 */
export type Clock = () => Date;

/** The instant every mock stamps unless a test overrides it. Arbitrary, and fixed forever. */
export const MOCK_CLOCK_INSTANT = '2026-01-01T00:00:00.000Z';
export const fixedMockClock: Clock = () => new Date(MOCK_CLOCK_INSTANT);
