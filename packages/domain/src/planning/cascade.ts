/**
 * The FR-05 discovery cascade — the ladder, as a pure decision.
 *
 * FR-05 tabulates eight rungs and what each does **on failure**. This file is that table as data,
 * plus the three questions a caller has to answer while walking it: may I try this rung, must I
 * stop here, and what does the whole walk mean for coverage.
 *
 * ```
 * 0  Local index of polled feeds and cached prior runs   Always available
 * 1  Primary sources matching the subject or a company   Record unreachable; coverage incomplete
 * 2  Google News RSS per language and edition            Cool the identity, retry once, descend
 * 3  GDELT DOC 2.0 across the requested window           Quota exhausted; descend
 * 4  Bing News RSS                                       Descend
 * 5  Self-hosted SearXNG over the approved engine mix    Descend
 * 6  Direct site search on approved high-authority domains  Record and stop
 * 7  Stop and emit coverage state                        Coverage incomplete, naming every gap
 * ```
 *
 * # The ambiguity in that table, and how it is read here
 *
 * The table says what happens **on failure**. It does not say what happens on success, and the
 * two readings lead to different products:
 *
 * - **First hit wins** — stop at the first rung that returns candidates. Cheapest, politest.
 * - **Walk the whole ladder** — every rung contributes, failures are recorded, rung 7 terminates.
 *
 * **This implementation walks the whole ladder, and the reason is not preference — it is axis D.**
 * FR-11 grants `CORROBORATED` on one Tier 1 source *or two independent Tier 2–3 sources*. A
 * cascade that stopped at the first rung returning anything would make the second reading
 * structurally unreachable: a story found at rung 2 would end the walk, rungs 3–6 would never be
 * asked, and no second independent source could ever be found. The banding engine would then have
 * a rule it could never satisfy, and every well-reported allegation would band one level lower
 * than the evidence deserves.
 *
 * Two smaller signals point the same way. "Reaching rung 7 **with no candidates**" implies rung 7
 * is reached routinely, with or without them. And FR-10 clustering exists precisely because the
 * same story is expected from several rungs — which only happens if several rungs are asked.
 *
 * The cost of this reading is real and is bounded elsewhere: per-source budgets, both breakers,
 * and the planner's query cap. See `docs/decisions.md` **D-045**.
 *
 * # What is a gap, and what is not
 *
 * The distinction this file exists to keep:
 *
 * - A rung whose source **answered and had nothing** is not a gap. The ladder worked.
 * - A rung with **no source configured**, or whose source was refused, failed, or is behind an
 *   open breaker, **is** a gap — and is named, with the queries it cost.
 *
 * Collapsing those two is how "we did not look" becomes "there is nothing there".
 *
 * Pure: no clock, no I/O. The caller supplies what happened and this decides what it means.
 */

import type { SourceCoverageOutcome } from '../coverage/result-state.js';

/** A rung of the FR-05 ladder. Seven sources and a terminus. */
export type CascadeRung = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const CASCADE_RUNGS: readonly CascadeRung[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** The terminus. Not a source — the rung at which the walk stops and coverage is emitted. */
export const TERMINAL_RUNG: CascadeRung = 7;

/**
 * What FR-05's "On failure" column says for a rung.
 *
 * Named rather than free text so a caller branches on a value the table fixed, and so adding a
 * rung is a compile error at every site that decides what to do about one.
 */
export type RungFailurePolicy =
  /** Rung 0. A local index cannot be unreachable; if it is empty, it is empty. */
  | 'ALWAYS_AVAILABLE'
  /** Rung 1. Record the source unreachable; coverage is incomplete for that source. */
  | 'RECORD_INCOMPLETE'
  /** Rung 2. Cool the egress identity, retry once, then descend. */
  | 'COOL_RETRY_DESCEND'
  /** Rungs 3–5. Descend; the failure is recorded as a gap. */
  | 'DESCEND'
  /** Rung 6. Record and **stop** — the ladder ends here rather than continuing. */
  | 'RECORD_AND_STOP'
  /** Rung 7. The terminus itself. */
  | 'TERMINUS';

export interface CascadeRungSpec {
  readonly rung: CascadeRung;
  readonly label: string;
  readonly onFailure: RungFailurePolicy;
  /** Whether a failure here is retried once before descending (rung 2 only). */
  readonly retryOnce: boolean;
  /** Whether a failure here ends the walk rather than descending (rung 6 only). */
  readonly stopsCascade: boolean;
}

const SPECS: Readonly<Record<CascadeRung, CascadeRungSpec>> = {
  0: {
    rung: 0,
    label: 'Local index of polled publisher feeds and cached prior runs',
    onFailure: 'ALWAYS_AVAILABLE',
    retryOnce: false,
    stopsCascade: false,
  },
  1: {
    rung: 1,
    label: 'Primary sources matching the subject or an eligible company',
    onFailure: 'RECORD_INCOMPLETE',
    retryOnce: false,
    stopsCascade: false,
  },
  2: {
    rung: 2,
    label: 'Google News RSS per language and edition',
    onFailure: 'COOL_RETRY_DESCEND',
    retryOnce: true,
    stopsCascade: false,
  },
  3: {
    rung: 3,
    label: 'GDELT DOC 2.0 across the requested window',
    onFailure: 'DESCEND',
    retryOnce: false,
    stopsCascade: false,
  },
  4: {
    rung: 4,
    label: 'Bing News RSS',
    onFailure: 'DESCEND',
    retryOnce: false,
    stopsCascade: false,
  },
  5: {
    rung: 5,
    label: 'Self-hosted SearXNG over the approved engine mix',
    onFailure: 'DESCEND',
    retryOnce: false,
    stopsCascade: false,
  },
  6: {
    rung: 6,
    label: 'Direct site search on approved high-authority domains',
    onFailure: 'RECORD_AND_STOP',
    retryOnce: false,
    stopsCascade: true,
  },
  7: {
    rung: 7,
    label: 'Stop and emit coverage state',
    onFailure: 'TERMINUS',
    retryOnce: false,
    stopsCascade: true,
  },
};

/** The table's row for a rung. Total over `CascadeRung`, so there is no undefined case. */
export function rungSpec(rung: CascadeRung): CascadeRungSpec {
  return SPECS[rung];
}

/** What happened when one source at one rung was asked one query. */
export type RungOutcome =
  /** The source answered and returned candidates. */
  | 'FOUND'
  /** The source answered and had nothing. **Not a gap** — the ladder worked. */
  | 'EMPTY'
  /** The source was asked and did not answer. A gap. */
  | 'FAILED'
  /** Health refused it: kill switch, licence, budget, or an open breaker. A gap. */
  | 'REFUSED'
  /** Nothing is configured to answer at this rung at all. A gap, and a different one. */
  | 'NO_SOURCE';

export interface RungAttempt {
  readonly rung: CascadeRung;
  /** `null` only for `NO_SOURCE`, where there was no source to name. */
  readonly sourceId: string | null;
  readonly sourceName: string;
  readonly outcome: RungOutcome;
  /** Candidates this attempt contributed, before deduplication. */
  readonly candidates: number;
  /** A sentence a reviewer reads. Required for anything that is not `FOUND` or `EMPTY`. */
  readonly detail: string | null;
  /** How many planned queries this attempt covered — what a gap here actually cost. */
  readonly queriesAffected: number;
}

/**
 * Does this outcome leave a hole in what the run claims to have searched?
 *
 * `EMPTY` is deliberately not a gap and `NO_SOURCE` deliberately is. A source that answered
 * "nothing" has been consulted; a rung with nothing behind it has not, and a run that treated the
 * second as the first would report full coverage of a ladder it never climbed.
 */
export function isGap(outcome: RungOutcome): boolean {
  return outcome === 'FAILED' || outcome === 'REFUSED' || outcome === 'NO_SOURCE';
}

/**
 * The next rung to attempt, or null when the walk is over.
 *
 * `stoppedBy` is the rung whose failure ended the walk early — rung 6's "record and stop". Any
 * other rung descends, however it failed, because FR-05's column says so for each of them.
 */
export function nextRung(input: {
  readonly current: CascadeRung;
  readonly failed: boolean;
}): CascadeRung | null {
  const spec = rungSpec(input.current);
  if (input.current >= TERMINAL_RUNG) {
    return null;
  }
  if (input.failed && spec.stopsCascade) {
    return null;
  }
  return (input.current + 1) as CascadeRung;
}

export interface CascadeSummary {
  /**
   * The highest rung actually reached.
   *
   * Null when nothing was attempted at all — which is different from reaching rung 0 and finding
   * it empty, and the difference belongs in a coverage statement.
   */
  readonly rungReached: CascadeRung | null;
  /** Candidates contributed across every rung, before deduplication. */
  readonly candidates: number;
  /** True when every rung attempted either found something or answered with nothing. */
  readonly complete: boolean;
  /** The rungs that left a hole, in ladder order. */
  readonly gaps: readonly RungAttempt[];
  /** True when the walk ended early because rung 6 failed. */
  readonly stoppedEarly: boolean;
}

/** What the whole walk means. */
export function summariseCascade(attempts: readonly RungAttempt[]): CascadeSummary {
  if (attempts.length === 0) {
    return { rungReached: null, candidates: 0, complete: false, gaps: [], stoppedEarly: false };
  }

  const gaps = attempts.filter((attempt) => isGap(attempt.outcome));
  const reached = attempts.reduce<CascadeRung>(
    (highest, attempt) => (attempt.rung > highest ? attempt.rung : highest),
    0,
  );
  const stoppedEarly = attempts.some(
    (attempt) => rungSpec(attempt.rung).stopsCascade && attempt.outcome === 'FAILED',
  );

  return {
    rungReached: reached,
    candidates: attempts.reduce((total, attempt) => total + attempt.candidates, 0),
    // Complete means every rung attempted was answered. It does **not** mean every rung exists:
    // a ladder with nothing at rung 3 reports `NO_SOURCE` there, which is a gap, which is
    // incomplete. Saying otherwise would let a one-source deployment claim full coverage.
    complete: gaps.length === 0,
    gaps,
    stoppedEarly,
  };
}

/**
 * Turn the gaps into the run's coverage vocabulary (§6.2).
 *
 * Every gap becomes a named outcome. A rung that simply had nothing to say produces none — it is
 * not a gap and reporting it as one would make every honest empty answer look like a failure.
 *
 * The outcome mapping is the same distinction `accessCoverageOutcome` draws for source health:
 * `SKIPPED` when **we** chose not to ask or had nobody to ask, `FAILED` when we asked and were
 * not answered.
 */
export function cascadeCoverageOutcomes(
  attempts: readonly RungAttempt[],
): readonly SourceCoverageOutcome[] {
  return attempts
    .filter((attempt) => isGap(attempt.outcome))
    .map((attempt) => ({
      sourceId: attempt.sourceId ?? `cascade-rung-${String(attempt.rung)}`,
      sourceName: attempt.sourceName,
      cascadeRung: attempt.rung,
      outcome: attempt.outcome === 'FAILED' ? ('FAILED' as const) : ('SKIPPED' as const),
      detail:
        attempt.detail ??
        (attempt.outcome === 'NO_SOURCE'
          ? `No approved source answers at rung ${String(attempt.rung)} ` +
            `(${rungSpec(attempt.rung).label}). This rung was not searched.`
          : `Rung ${String(attempt.rung)} did not answer.`),
      queriesAffected: attempt.queriesAffected,
      truncation: null,
    }));
}

/**
 * The line describing one attempt, for the per-rung log FR-05 requires.
 *
 * "Each rung is logged" is a requirement, not a nicety: without it, a run that quietly skipped
 * four rungs is indistinguishable from one that climbed them and found nothing.
 */
export function describeAttempt(attempt: RungAttempt): string {
  const spec = rungSpec(attempt.rung);
  const head = `rung ${String(attempt.rung)} (${spec.label})`;
  switch (attempt.outcome) {
    case 'FOUND':
      return `${head}: ${String(attempt.candidates)} candidate(s) from ${attempt.sourceName}.`;
    case 'EMPTY':
      return `${head}: ${attempt.sourceName} answered with nothing. Not a gap.`;
    case 'FAILED':
      return `${head}: ${attempt.sourceName} did not answer — ${attempt.detail ?? 'no detail'}.`;
    case 'REFUSED':
      return `${head}: refused before asking — ${attempt.detail ?? 'no detail'}.`;
    case 'NO_SOURCE':
      return `${head}: no approved source answers here. Not searched.`;
  }
}
