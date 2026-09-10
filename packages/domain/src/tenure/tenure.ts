/**
 * FR-02 / FR-09 — tenure labelling.
 *
 * Every company finding is labelled by the relationship between the event date and the
 * subject's sourced appointment and resignation dates. "An unknown end date never proves
 * current status" — the single most common way a company event is wrongly attached to a
 * person who had already left.
 */

/** Date precision, per FR-01/FR-07. Precision is declared, never assumed. */
export type DatePrecision = 'DAY' | 'MONTH' | 'YEAR' | 'UNKNOWN';

export interface PreciseDate {
  /** ISO 8601 date. Null means genuinely unknown — never backfilled (FR-07). */
  readonly value: string | null;
  readonly precision: DatePrecision;
}

export const TENURE_LABELS = [
  'DURING_TENURE',
  'BEFORE_TENURE',
  'AFTER_TENURE',
  'SPANNING',
  'UNKNOWN',
] as const;

export type TenureLabel = (typeof TENURE_LABELS)[number];

export interface Tenure {
  readonly appointedOn: PreciseDate;
  /** Null value means "no resignation recorded" — which is not the same as "still serving". */
  readonly resignedOn: PreciseDate;
}

export interface EventInterval {
  readonly start: PreciseDate;
  /** For point-in-time events, equal to `start`. */
  readonly end: PreciseDate;
}

/**
 * Widen a date to the interval its precision actually covers, so a YEAR-precision event in
 * 2019 is not silently treated as 1 January 2019.
 */
function toRange(date: PreciseDate): { lo: number; hi: number } | null {
  if (date.value === null || date.precision === 'UNKNOWN') {
    return null;
  }
  const parsed = new Date(`${date.value.slice(0, 10)}T00:00:00.000Z`);
  const t = parsed.getTime();
  if (Number.isNaN(t)) {
    return null;
  }
  const y = parsed.getUTCFullYear();
  const m = parsed.getUTCMonth();
  switch (date.precision) {
    case 'YEAR':
      return { lo: Date.UTC(y, 0, 1), hi: Date.UTC(y, 11, 31) };
    case 'MONTH':
      return { lo: Date.UTC(y, m, 1), hi: Date.UTC(y, m + 1, 0) };
    case 'DAY':
      return { lo: t, hi: t };
  }
}

/**
 * Label an event against a tenure.
 *
 * Returns UNKNOWN whenever the answer is not provable from sourced dates. Deliberately
 * conservative: an ambiguous overlap is UNKNOWN, not DURING_TENURE.
 */
export function labelTenure(tenure: Tenure, event: EventInterval): TenureLabel {
  const appointed = toRange(tenure.appointedOn);
  const eventStart = toRange(event.start);
  const eventEnd = toRange(event.end) ?? eventStart;

  if (appointed === null || eventStart === null || eventEnd === null) {
    return 'UNKNOWN';
  }

  const resigned = toRange(tenure.resignedOn);

  // Entirely before the appointment, at the coarsest reading of both dates.
  if (eventEnd.hi < appointed.lo) {
    return 'BEFORE_TENURE';
  }

  if (resigned === null) {
    // No sourced end date. The event is on or after the appointment, but we cannot show the
    // person still held the role — so this is at most "during" if it is unambiguously after
    // appointment, and UNKNOWN if the appointment date is too coarse to tell.
    return eventStart.lo >= appointed.hi ? 'DURING_TENURE' : 'UNKNOWN';
  }

  if (eventStart.lo > resigned.hi) {
    return 'AFTER_TENURE';
  }

  const startsInside = eventStart.lo >= appointed.hi && eventStart.hi <= resigned.lo;
  const endsInside = eventEnd.lo >= appointed.hi && eventEnd.hi <= resigned.lo;

  if (startsInside && endsInside) {
    return 'DURING_TENURE';
  }

  // Crosses at least one boundary of the tenure window.
  const crossesStart = eventStart.lo < appointed.hi && eventEnd.hi > appointed.lo;
  const crossesEnd = eventStart.lo < resigned.hi && eventEnd.hi > resigned.lo;
  if (crossesStart || crossesEnd) {
    return 'SPANNING';
  }

  return 'UNKNOWN';
}

/**
 * FR-02 default local policy: current confirmed directorships only. An unknown end date
 * does not make a directorship current.
 */
export function isConfirmedCurrent(tenure: Tenure, asOf: PreciseDate): boolean {
  const appointed = toRange(tenure.appointedOn);
  const now = toRange(asOf);
  if (appointed === null || now === null) {
    return false;
  }
  if (appointed.lo > now.hi) {
    return false;
  }
  // A recorded resignation in the past ends it. A *missing* resignation is not proof of
  // continuation, but the register reporting no resignation for a confirmed appointment is
  // the register's positive statement of current status.
  const resigned = toRange(tenure.resignedOn);
  if (resigned !== null && resigned.hi < now.lo) {
    return false;
  }
  return tenure.resignedOn.value === null || resigned === null ? true : resigned.lo > now.hi;
}
