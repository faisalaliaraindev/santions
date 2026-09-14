/**
 * FR-02 — which directorships a search may look at, and what may be claimed about each.
 *
 * "Default local policy: current confirmed directorships only; former-director search is
 * selectable only under an approved historical scope. Unknown end dates do not prove current
 * status."
 *
 * # The distinction this file exists to keep
 *
 * Three different things all look like "no resignation date" and they are not the same:
 *
 * 1. the register recorded a resignation, and it is in the past — the person **has left**;
 * 2. the register has a resignation field for this officer and it is **empty** — the register
 *    is positively stating that they still serve;
 * 3. we do not know, because the appointment date itself is too coarse or missing.
 *
 * `classifyCurrency` keeps all three apart. The second one is the interesting case, and it is
 * where this file reads FR-02's sentence carefully rather than literally.
 *
 * **"Unknown end dates do not prove current status" is about proof, not about scope.** Real
 * registers almost never publish an end date for a serving officer — absence *is* how they say
 * "still serving". Excluding every silence-based edge from the default scope would make
 * "current confirmed directorships only" return nothing at all against most registers, and the
 * honest coverage statement for that search would have to say we looked at no companies. That
 * is worse than useless: it is a clean-looking result produced by not looking.
 *
 * So silence-based edges **are** in the default scope, and they are **never labelled
 * confirmed**. `CURRENT_CONFIRMED` and `CURRENT_PER_REGISTER_SILENCE` are separate values, they
 * travel separately all the way to the reviewer, and no code merges them. The proof half of
 * FR-02's sentence is enforced where it actually bites — attaching an *event* to a person's
 * tenure, which goes through `labelTenure`, which returns `UNKNOWN` rather than
 * `DURING_TENURE` whenever the dates cannot show the person still held the role.
 *
 * Recorded as decision **D-024**.
 */

import { isConfirmedCurrent, type PreciseDate, type Tenure } from '../tenure/tenure.js';

/**
 * The scope a search runs under.
 *
 * `INCLUDE_FORMER` is **selectable only under an approved historical scope** (FR-02), which is
 * an entitlement question and not this function's to answer. `requiresApprovedHistoricalScope`
 * below is what a caller checks before honouring it.
 */
export const ASSOCIATION_SCOPES = ['CURRENT_ONLY', 'INCLUDE_FORMER'] as const;
export type AssociationScope = (typeof ASSOCIATION_SCOPES)[number];

export const CURRENCY_STATES = [
  /** The register records an end date, and it has not arrived. The strongest claim available. */
  'CURRENT_CONFIRMED',
  /** An appointment with no end date recorded. The register's silence, not our inference. */
  'CURRENT_PER_REGISTER_SILENCE',
  /** The register records an end date and it has passed. */
  'FORMER',
  /** The dates cannot support any of the above — usually a missing or too-coarse appointment. */
  'UNKNOWN',
] as const;
export type CurrencyState = (typeof CURRENCY_STATES)[number];

/**
 * Classify a directorship's currency as of a date.
 *
 * Delegates the confirmed case to `isConfirmedCurrent` rather than re-deriving it — FR-02's
 * default policy is already written and tested there, and a second copy here would be the one
 * that drifts. What this adds is the split between "confirmed" and "the register said nothing",
 * which `isConfirmedCurrent` deliberately answers with a single boolean.
 */
export function classifyCurrency(tenure: Tenure, asOf: PreciseDate): CurrencyState {
  const appointmentKnown =
    tenure.appointedOn.value !== null && tenure.appointedOn.precision !== 'UNKNOWN';
  if (!appointmentKnown) {
    // Without an appointment date there is nothing to be current *from*. Not "former", and not
    // "current": unknown, which is a different line in a coverage statement.
    return 'UNKNOWN';
  }

  const current = isConfirmedCurrent(tenure, asOf);
  const resignationRecorded =
    tenure.resignedOn.value !== null && tenure.resignedOn.precision !== 'UNKNOWN';

  if (!current) {
    // `isConfirmedCurrent` says no. With a recorded resignation that means they left; without
    // one it means the appointment itself is not yet established as having begun.
    return resignationRecorded ? 'FORMER' : 'UNKNOWN';
  }

  return resignationRecorded ? 'CURRENT_CONFIRMED' : 'CURRENT_PER_REGISTER_SILENCE';
}

export interface ScopeDecision {
  readonly included: boolean;
  readonly currency: CurrencyState;
  /** Shown to the reviewer when an edge was omitted. An omission with no reason is a gap. */
  readonly reason: string;
}

/**
 * Is this directorship inside the requested scope?
 *
 * `UNKNOWN` is **excluded from the default scope and included under the historical one**. It is
 * not current — nothing establishes that it is — but it is also not something to discard
 * silently, and a reviewer who has asked for the historical picture should see it with its
 * state named rather than have it quietly dropped.
 */
export function edgeInScope(
  tenure: Tenure,
  scope: AssociationScope,
  asOf: PreciseDate,
): ScopeDecision {
  const currency = classifyCurrency(tenure, asOf);

  if (scope === 'INCLUDE_FORMER') {
    return {
      included: true,
      currency,
      reason: 'Historical scope: current and former directorships are both in scope.',
    };
  }

  switch (currency) {
    case 'CURRENT_CONFIRMED':
      return {
        included: true,
        currency,
        reason: 'The register records an end date that has not arrived.',
      };
    case 'CURRENT_PER_REGISTER_SILENCE':
      return {
        included: true,
        currency,
        reason:
          'The register records an appointment and no resignation. That is the register ' +
          'stating current service, and it is never reported as confirmed.',
      };
    case 'FORMER':
      return {
        included: false,
        currency,
        reason:
          'The register records a resignation that has passed. Former directorships are ' +
          'searched only under an approved historical scope (FR-02).',
      };
    case 'UNKNOWN':
      return {
        included: false,
        currency,
        reason:
          'The appointment dates do not establish that this directorship is current. An ' +
          'unknown end date never proves current status (FR-02).',
      };
  }
}

/**
 * Does this scope need an approved historical entitlement?
 *
 * A one-line function so the check has one name and one place, rather than being an `if` in
 * whichever service happens to run first.
 */
export function requiresApprovedHistoricalScope(scope: AssociationScope): boolean {
  return scope === 'INCLUDE_FORMER';
}

/**
 * How a currency state reads to a reviewer.
 *
 * Written out rather than derived from the enum name, because the difference between "confirmed
 * current" and "the register has not said otherwise" is exactly the difference a reviewer needs
 * to understand, and a prettified enum name would not convey it.
 */
export function describeCurrency(currency: CurrencyState): string {
  switch (currency) {
    case 'CURRENT_CONFIRMED':
      return 'Current — the register records an end date that has not been reached.';
    case 'CURRENT_PER_REGISTER_SILENCE':
      return 'Current according to the register, which records no resignation. Not confirmed.';
    case 'FORMER':
      return 'Former — the register records a resignation that has passed.';
    case 'UNKNOWN':
      return 'Not established. The recorded dates cannot show whether this is current.';
  }
}
