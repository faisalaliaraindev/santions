/**
 * Per-jurisdiction, per-capability coverage status.
 *
 * This exists to stop one specific failure, which is the worst failure this product has: a
 * capability that was never available reads as a capability that found nothing. "No officer
 * associations were found" and "we have no way to look for officer associations here" are the
 * same empty list, and only one of them is a screening result.
 *
 * So the status is **stored configuration, surfaced on every result**, not an inference from an
 * empty array. `interpretEmptyResult` is the function that keeps the two apart, and nothing may
 * report "no findings" without going through it.
 *
 * Jurisdiction-agnostic by construction: every country is a row of data. There is no Costa Rica
 * in this file, and there must not be — CR's officer-association status is `UNKNOWN` because a
 * seeded record says so, not because any code knows about Costa Rica.
 */

import type { CountryCode } from '../taxonomy/types.js';

/**
 * What the service can do for a jurisdiction, capability by capability.
 *
 * Each is a distinct question a reviewer might ask of a result, and each can be answered
 * differently in the same country — which is exactly why one blanket "CR: supported" flag would
 * be useless.
 */
export const CAPABILITIES = [
  'COMPANY_REGISTRY',
  'OFFICER_ASSOCIATIONS',
  'COURT_RECORDS',
  'GAZETTE_NOTICES',
  'REGULATOR_ENFORCEMENT',
  'PROSECUTOR_BULLETINS',
  'NEWS_DISCOVERY',
  'NAME_FREQUENCY',
  'SANCTIONS_DESIGNATIONS',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The four statuses, and the distinction that carries the weight.
 *
 * `UNSUPPORTED` and `UNKNOWN` are **not** the same and must never be merged. `UNSUPPORTED` is a
 * finished investigation: we looked into it and there is no way to do this here.  `UNKNOWN` is
 * an unfinished one: nobody has established whether it is possible. Merging them either claims
 * knowledge nobody has, or hides a gap that somebody could close.
 */
export const CAPABILITY_STATUSES = [
  /** An approved source covers this, and a nil result means the source returned nothing. */
  'SUPPORTED',
  /** Covered incompletely — some sources, some document classes, or a known gap. */
  'PARTIAL',
  /** Not established. Nobody has determined whether this is possible here. */
  'UNKNOWN',
  /** Established as not possible on approved terms. An investigation that concluded. */
  'UNSUPPORTED',
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilityCoverage {
  readonly jurisdiction: CountryCode;
  readonly capability: Capability;
  readonly status: CapabilityStatus;
  /**
   * Why it has this status, in language a reviewer reading a coverage statement can use.
   * Required — a status with no rationale is an assertion, and this file exists to prevent
   * assertions standing in for evidence.
   */
  readonly rationale: string;
  /** The approved sources that provide it. Empty for everything except SUPPORTED and PARTIAL. */
  readonly sourceIds: readonly string[];
  /** Where the determination is written down — a dossier section, a decision, a review. */
  readonly evidenceRef: string | null;
  readonly assessedAt: string;
  /** The open decision that would change this status, when one exists. */
  readonly blockedByDecision: string | null;
}

/**
 * How an empty result must be described, given the coverage behind it.
 *
 * The whole point of the module in one function. `SUPPORTED` is the only status under which
 * nothing found may be reported as nothing there.
 */
export type EmptyResultMeaning =
  /** The capability ran and returned nothing. A real, reportable negative. */
  | 'NO_FINDINGS'
  /** Nothing was found because nothing could be looked for, or not everywhere. Not a negative. */
  | 'NOT_ESTABLISHED';

export function interpretEmptyResult(status: CapabilityStatus): EmptyResultMeaning {
  return status === 'SUPPORTED' ? 'NO_FINDINGS' : 'NOT_ESTABLISHED';
}

/**
 * Fold a set of capability statuses into the FR-02 / D4 coverage outcome.
 *
 * The three values are kept distinct deliberately, and the difference between the last two is
 * the one people collapse: `INCOMPLETE` means we asked and something failed or was bounded;
 * `UNKNOWN` means we never asked, because there was nothing approved to ask. Reporting
 * `UNKNOWN` as `INCOMPLETE` claims an attempt that never happened.
 */
export type CoverageOutcome = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';

export function coverageOutcomeFor(statuses: readonly CapabilityStatus[]): CoverageOutcome {
  if (statuses.length === 0) {
    return 'UNKNOWN';
  }
  if (statuses.every((s) => s === 'SUPPORTED')) {
    return 'COMPLETE';
  }
  // Nothing was askable at all: every capability is either unestablished or established as
  // impossible. That is not a partial answer, it is the absence of one.
  if (statuses.every((s) => s === 'UNKNOWN' || s === 'UNSUPPORTED')) {
    return 'UNKNOWN';
  }
  return 'INCOMPLETE';
}

/**
 * The sentence a coverage statement carries for one capability.
 *
 * Written here rather than in the panel so that the API, an export and the panel cannot
 * describe the same gap three different ways — and so that the wording cannot quietly soften
 * on the way to the screen, which is how "we could not look" becomes "we found nothing".
 */
export function describeCoverage(coverage: CapabilityCoverage): string {
  const where = `${coverage.capability} in ${coverage.jurisdiction}`;
  switch (coverage.status) {
    case 'SUPPORTED':
      return `${where}: covered by ${coverage.sourceIds.join(', ')}.`;
    case 'PARTIAL':
      return (
        `${where}: partially covered — ${coverage.rationale} ` +
        `A nil result here does not mean there is nothing to find.`
      );
    case 'UNSUPPORTED':
      return (
        `${where}: not available on approved terms — ${coverage.rationale} ` +
        `Nothing was searched, so nothing can be concluded.`
      );
    case 'UNKNOWN':
      return (
        `${where}: coverage not established — ${coverage.rationale} ` +
        `Nothing was searched, so nothing can be concluded.`
      );
  }
}

/**
 * Guard for the one mistake this module exists to prevent.
 *
 * Call it wherever a nil result is about to be reported as a clean one. It throws rather than
 * returning a boolean because the correct handling of "you are about to state something untrue
 * about a person" is not a branch the caller can forget to take.
 */
export function assertMayReportNoFindings(coverage: CapabilityCoverage): void {
  if (interpretEmptyResult(coverage.status) === 'NO_FINDINGS') {
    return;
  }
  throw new Error(
    `Refusing to report "no findings" for ${coverage.capability} in ${coverage.jurisdiction}: ` +
      `coverage is ${coverage.status}. ${describeCoverage(coverage)}`,
  );
}

/** Index a coverage set for lookup. Later entries win, so a seed can be overridden by an edit. */
export function coverageIndex(
  entries: readonly CapabilityCoverage[],
): ReadonlyMap<string, CapabilityCoverage> {
  const map = new Map<string, CapabilityCoverage>();
  for (const entry of entries) {
    map.set(coverageKey(entry.jurisdiction, entry.capability), entry);
  }
  return map;
}

export function coverageKey(jurisdiction: CountryCode, capability: Capability): string {
  return `${jurisdiction}:${capability}`;
}

/**
 * Look a capability up, defaulting to `UNKNOWN` when nothing is recorded.
 *
 * The default matters more than the lookup. An unrecorded capability must read as "nobody has
 * established this" and never as "supported" — an absent row is the most common way a coverage
 * model ends up claiming capability it does not have.
 */
export function lookupCoverage(
  index: ReadonlyMap<string, CapabilityCoverage>,
  jurisdiction: CountryCode,
  capability: Capability,
  asOf: string,
): CapabilityCoverage {
  return (
    index.get(coverageKey(jurisdiction, capability)) ?? {
      jurisdiction,
      capability,
      status: 'UNKNOWN',
      rationale: 'No coverage has been recorded for this capability in this jurisdiction.',
      sourceIds: [],
      evidenceRef: null,
      assessedAt: asOf,
      blockedByDecision: null,
    }
  );
}
