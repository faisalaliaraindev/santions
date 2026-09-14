/**
 * FR-02 — what the association graph contributes to a run's coverage statement.
 *
 * # The distinction this file must not lose
 *
 * The graph has three outcomes and they are not degrees of the same thing:
 *
 * | Outcome      | Meaning                                                              |
 * | :----------- | :------------------------------------------------------------------- |
 * | `COMPLETE`   | The register answered and the answer was within bounds               |
 * | `INCOMPLETE` | We asked, and something failed or a bound bound                      |
 * | `UNKNOWN`    | **We never asked** — no approved register covers this jurisdiction   |
 *
 * `UNKNOWN` is the Costa Rica case today (D14), and reporting it as `INCOMPLETE` would put a
 * line in a coverage statement implying an attempt that never happened. None of the three ever
 * means "no associations exist": FR-02 closes by saying no result from a registry does not prove
 * that, and a bound or an outage proves it even less.
 *
 * # Mapping into the run
 *
 * The run's coverage is assembled by `aggregateRun` out of `SourceCoverageOutcome` values, whose
 * vocabulary is `COMPLETED` / `PARTIAL` / `FAILED` / `SKIPPED` / `SUSPENDED`. Both `INCOMPLETE`
 * and `UNKNOWN` make the *run* `INCOMPLETE`, and that is correct — in both cases the run covered
 * less than a reader might assume. What must not happen is the two becoming indistinguishable
 * once they get there, so they map to **different** outcomes with **different** details:
 *
 * - `UNKNOWN` → `SKIPPED`, detail "no approved register covers X, so none was asked";
 * - `INCOMPLETE` → `FAILED` when the register did not answer, `PARTIAL` when it answered and a
 *   bound bound. A bound that binds still produced real associations; an outage produced none.
 *
 * The run-level `UNKNOWN` is reserved for a run in which no work was dispatched at all, which is
 * a statement about the run rather than about this source.
 */

import type { SourceCoverageOutcome } from '../coverage/result-state.js';

import { describeBound, type BoundApplication } from './bounds.js';

export const ASSOCIATION_COVERAGE_STATES = ['COMPLETE', 'INCOMPLETE', 'UNKNOWN'] as const;
export type AssociationCoverage = (typeof ASSOCIATION_COVERAGE_STATES)[number];

export interface AssociationCoverageInput {
  /** Null when no register was asked, which is what makes the outcome `UNKNOWN`. */
  readonly sourceId: string | null;
  readonly sourceName: string;
  /** The jurisdiction the graph was asked about, for the "never asked" sentence. */
  readonly jurisdiction: string;
  /**
   * Did a register actually answer? False both when none exists and when one exists but the
   * call failed — `failure` is what separates those two.
   */
  readonly answered: boolean;
  /** The FR-06 failure class, when a register was asked and did not answer. */
  readonly failure: string | null;
  readonly boundsApplied: readonly BoundApplication[];
  /**
   * Problems reading the policy's declared bounds. Surfaced rather than swallowed: a run that
   * silently fell back to default bounds because of a typo is a run whose truncation nobody can
   * explain.
   */
  readonly policyProblems: readonly string[];
  /** Why no register was asked. Required when `sourceId` is null. */
  readonly notAskedReason: string | null;
}

export interface AssociationCoverageResult {
  readonly outcome: AssociationCoverage;
  /** Null only for `COMPLETE`. Every limitation carries its own reason. */
  readonly detail: string | null;
  /** Every bound and policy problem, rendered for a reviewer. */
  readonly limitations: readonly string[];
  /** What the run's own coverage aggregation consumes. */
  readonly sourceOutcome: SourceCoverageOutcome;
}

/**
 * Decide the association source's coverage, and the outcome the run aggregates.
 *
 * Pure. The caller has already done the asking; this says what the asking amounted to.
 */
export function summariseAssociationCoverage(
  input: AssociationCoverageInput,
): AssociationCoverageResult {
  const limitations = [...input.boundsApplied.map(describeBound), ...input.policyProblems];

  // Never asked. Not a failure of the register — there is no register.
  if (input.sourceId === null) {
    const detail =
      input.notAskedReason ??
      `No approved company register covers ${input.jurisdiction}, so none was asked. This is ` +
        `not evidence that the subject has no associations.`;
    return {
      outcome: 'UNKNOWN',
      detail,
      limitations,
      sourceOutcome: {
        sourceId: 'association-graph',
        sourceName: input.sourceName,
        // Rung 1 in the FR-05 cascade: primary sources matching the subject or an eligible
        // company. The graph is what makes a company eligible.
        cascadeRung: 1,
        outcome: 'SKIPPED',
        detail,
        queriesAffected: 1,
        truncation: null,
      },
    };
  }

  // Asked, and it did not answer.
  if (!input.answered) {
    const detail =
      `The company register did not answer (${input.failure ?? 'unclassified failure'}). ` +
      `Association coverage for this search is incomplete; no result from a registry does not ` +
      `prove no associations exist.`;
    return {
      outcome: 'INCOMPLETE',
      detail,
      limitations,
      sourceOutcome: {
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        cascadeRung: 1,
        outcome: 'FAILED',
        detail,
        queriesAffected: 1,
        truncation: null,
      },
    };
  }

  // Answered, but not in full.
  if (limitations.length > 0) {
    const detail = `The register answered, but the association graph is bounded: ${limitations.join(' ')}`;
    return {
      outcome: 'INCOMPLETE',
      detail,
      limitations,
      sourceOutcome: {
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        cascadeRung: 1,
        // PARTIAL, not FAILED: a bounded traversal still produced real associations, and
        // discarding the distinction would make a capped graph look like an outage.
        outcome: 'PARTIAL',
        detail,
        queriesAffected: 1,
        truncation: 'TRUNCATED_BY_PLAN',
      },
    };
  }

  return {
    outcome: 'COMPLETE',
    detail: null,
    limitations,
    sourceOutcome: {
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      cascadeRung: 1,
      outcome: 'COMPLETED',
      detail: null,
      queriesAffected: 1,
      truncation: null,
    },
  };
}
