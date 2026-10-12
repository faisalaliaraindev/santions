/**
 * Section 6.2 — the three independent result dimensions, and the FR-13 no-match statement.
 *
 * These are separate on purpose. "The job finished" and "we found nothing" and "we searched
 * everything we said we would" are three different facts, and collapsing them is how a
 * screening product reports a clean result for a run in which every source was blocked.
 */

import type { FailureClass } from '../reliability/failure-classification.js';

export const EXECUTION_STATES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/**
 * What the run found, as a statement a reviewer can act on without re-reading the finding list.
 *
 * `POTENTIAL_MATCHES` used to carry two facts at once — "evidence supports a connection" and
 * "something turned up that we could not resolve" — while everything that was neither fell
 * through to `NO_MATCHES_FOUND`. That second half is the defect this enum was widened to fix: a
 * run holding a real `AMBIGUOUS` finding reported `NO_MATCHES_FOUND`, because the count behind
 * the state only ever counted `CORROBORATED` and `SUPPORTED`. The finding was in `/findings` the
 * whole time; the summary denied it existed, and a client that reads the summary — which is what
 * a summary is for — was told the opposite of the evidence.
 *
 * So the three answers are now named separately:
 *
 * - `CONFIRMED_MATCHES_FOUND` — at least one `CORROBORATED` or `SUPPORTED` finding. It is **not**
 *   a statement that the subject did anything; it is a statement that the evidence supports the
 *   connection well enough to clear FR-11's bar. `REVIEW_DISCLAIMER` still applies.
 * - `AMBIGUOUS_MATCHES_FOUND` — findings exist, and none of them clears that bar. A reviewer has
 *   material to look at. This is the state that must never be reported as no match.
 * - `NO_MATCHES_FOUND` — **zero findings of any band and zero unresolved leads.** Nothing else
 *   may produce it. `assertNoMatchIsHonest` enforces that in one place.
 *
 * `UNRESOLVED` and `NOT_EVALUATED` keep their meanings: leads that never became findings, and a
 * run that could not evaluate anything at all.
 *
 * `POTENTIAL_MATCHES` remains in the enum **for reading stored runs only**. `aggregateRun` never
 * produces it. Dropping it would make every run completed before this change fail to parse, which
 * would destroy an accurate record of what was reported at the time.
 */
export const FINDINGS_STATES = [
  'CONFIRMED_MATCHES_FOUND',
  'AMBIGUOUS_MATCHES_FOUND',
  'NO_MATCHES_FOUND',
  'UNRESOLVED',
  'NOT_EVALUATED',
  /** Legacy. Readable on a stored run; never newly produced. See the note above. */
  'POTENTIAL_MATCHES',
] as const;
export type FindingsState = (typeof FINDINGS_STATES)[number];

/** States that assert findings exist. A client may show the list without checking anything else. */
export const FINDINGS_STATES_WITH_FINDINGS: readonly FindingsState[] = [
  'CONFIRMED_MATCHES_FOUND',
  'AMBIGUOUS_MATCHES_FOUND',
  'POTENTIAL_MATCHES',
];

/**
 * WITHIN_DECLARED_SCOPE means a finite declared plan completed. It never means worldwide
 * reporting was exhausted.
 */
export const COVERAGE_STATES = ['WITHIN_DECLARED_SCOPE', 'INCOMPLETE', 'UNKNOWN'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export interface SourceCoverageOutcome {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly cascadeRung: number;
  readonly outcome: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'SKIPPED' | 'SUSPENDED';
  /** e.g. "GDELT quota exhausted", "metasearch rate-limited". Shown in the coverage line. */
  readonly detail: string | null;
  readonly queriesAffected: number;
  readonly truncation: 'TRUNCATED_BY_PLAN' | 'TRUNCATED_BY_QUOTA' | null;
  /**
   * The FR-06 class of the failure, when this outcome is one — `RATE_LIMITED`, `HARD_BLOCK`,
   * `TRANSIENT_NETWORK` and so on.
   *
   * `detail` is a sentence for a person; this is the same fact for a program. A client deciding
   * whether to re-run a search needs "the publisher rate-limited us" to be distinguishable from
   * "the publisher refused us permanently", and reading that out of English prose is how a
   * client ends up retrying a hard block forever.
   *
   * Null when the outcome is not a failure, or when nothing classified it — an adapter that
   * threw, for instance, where inventing a class would be a guess dressed as a record.
   */
  readonly failureClass?: FailureClass | null | undefined;
  /**
   * For a locally indexed source: the snapshot this outcome was produced from, and how old it is.
   *
   * Structured rather than only in `detail`, for the same reason `failureClass` is: `detail` is a
   * sentence for a person, and a client deciding whether an answer is good enough needs to read
   * "this came from a snapshot that is STALE" without parsing English. It is also what makes the
   * difference between the four outcomes this milestone must distinguish legible to a program —
   * searched and current, searched but stale, no snapshot at all, and refresh failed.
   *
   * Absent for a query-time source, which has no snapshot behind it and for which inventing one
   * would be a statement about data that does not exist.
   */
  readonly snapshotVersion?: string | null | undefined;
  readonly freshness?: 'CURRENT' | 'STALE' | 'UNAVAILABLE' | null | undefined;
  /** Rows in that snapshot. Null for a query-time source. */
  readonly snapshotRowCount?: number | null | undefined;
}

/**
 * Findings by band, as counts.
 *
 * Published alongside `findings` so a client never has to infer "is there anything to look at?"
 * from a state name it may not recognise. These are **counts of findings**, not a score: I9
 * forbids a composite person-level figure, and a tally of how many documents fell in each band
 * is not one — it is the same arithmetic a reviewer does by looking at the list.
 */
export interface FindingCounts {
  /** `CORROBORATED` or `SUPPORTED`. */
  readonly confirmed: number;
  /** `AMBIGUOUS` or `COMPANY_CONTEXT` — real findings that do not clear FR-11's bar. */
  readonly ambiguous: number;
  /** `CONTRADICTED` or `LEAD_ONLY`. Still returned from `/findings`, so still counted. */
  readonly other: number;
  /** Every band. `total === 0` is the only thing that may be called a no-match. */
  readonly total: number;
  /** Candidates rejected before becoming findings, with their reasons (FR-06). */
  readonly unresolvedLeads: number;
}

export interface RunAggregateInput {
  readonly cancelled: boolean;
  /** `CORROBORATED` or `SUPPORTED`. Drives `CONFIRMED_MATCHES_FOUND`. */
  readonly supportedFindingCount: number;
  /**
   * `AMBIGUOUS` or `COMPANY_CONTEXT`.
   *
   * Optional only so an existing caller compiles. **Absent means zero, and a caller that has
   * ambiguous findings and does not pass them will be reported as having none** — which is the
   * bug this field exists to fix, so every caller in this repository passes it.
   */
  readonly ambiguousFindingCount?: number | undefined;
  /** `CONTRADICTED` or `LEAD_ONLY`. A finding that is returned is a finding that is counted. */
  readonly otherFindingCount?: number | undefined;
  readonly unresolvedLeadCount: number;
  readonly sourceOutcomes: readonly SourceCoverageOutcome[];
  /** True when the planned work was dispatched at all. */
  readonly anyWorkDispatched: boolean;
  /**
   * Languages the run searched in that carry **no measured recall figure** (FR-03, FR-16, T80).
   *
   * These make coverage `INCOMPLETE` even when every source succeeded, and that is the whole
   * point. `WITHIN_DECLARED_SCOPE` claims the run searched everything it said it would — but a
   * language whose recall has never been measured is a language we cannot say we covered. Every
   * source completing tells us the *sources* worked; it says nothing about whether the queries
   * in that language find what exists.
   *
   * Optional so an existing caller compiles, and absent means "none", which is the honest
   * reading of a caller that has not considered the question rather than a claim that all
   * languages are measured.
   */
  readonly unmeasuredLanguages?: readonly string[] | undefined;
}

export interface RunAggregate {
  readonly execution: ExecutionState;
  readonly findings: FindingsState;
  readonly coverage: CoverageState;
  readonly failedSources: readonly SourceCoverageOutcome[];
  /** The counts the state was derived from, so a client never has to re-derive them. */
  readonly findingCounts: FindingCounts;
}

/**
 * Aggregate the three dimensions.
 *
 * Precedence, per section 6.2:
 *  - findings may coexist with unresolved leads;
 *  - incomplete requested work yields partial coverage;
 *  - all work failed means FAILED / NOT_EVALUATED, never NO_MATCHES_FOUND;
 *  - cancellation never retroactively claims completion.
 *
 * # One source failing never discards another source's result
 *
 * Everything here is computed from the **whole** `sourceOutcomes` list plus the findings that
 * survived, and nothing in it is gated on the absence of a failure. A run in which one source
 * rate-limited and another returned a finding is `PARTIAL` / `INCOMPLETE` with the finding
 * intact — `PARTIAL` is the word for "some of it worked", and a screening product that answered
 * `FAILED` there would be throwing away a real hit because an unrelated publisher was busy.
 *
 * The rule in one line: **a failure narrows what the run may claim; it never subtracts from what
 * the run found.**
 */
export function aggregateRun(input: RunAggregateInput): RunAggregate {
  const confirmed = input.supportedFindingCount;
  const ambiguous = input.ambiguousFindingCount ?? 0;
  const other = input.otherFindingCount ?? 0;
  const findingCounts: FindingCounts = {
    confirmed,
    ambiguous,
    other,
    total: confirmed + ambiguous + other,
    unresolvedLeads: input.unresolvedLeadCount,
  };

  const failedSources = input.sourceOutcomes.filter(
    (s) => s.outcome === 'FAILED' || s.outcome === 'SUSPENDED' || s.outcome === 'PARTIAL',
  );
  /**
   * Did anything actually answer?
   *
   * **A finding is itself proof that something did** — a finding of *any* band. This condition
   * used to read `supportedFindingCount > 0`, which meant a run whose only result was an
   * `AMBIGUOUS` finding counted as a run where nothing answered, and was reported `FAILED` /
   * `NOT_EVALUATED` while holding that finding in `/findings`. Bands measure how well evidence
   * supports a connection; they say nothing about whether a source responded, and using one as
   * a proxy for the other is how the summary came to contradict the evidence.
   *
   * `sourceOutcomes` is not a census either. It began life as a list of *gaps*, so a walk in
   * which every rung either answered emptily or had no source produced no `COMPLETED` at all.
   * Both halves of the condition are therefore load-bearing.
   *
   * T47 is unaffected: it requires that a run where **every** source failed is reported as a
   * failure rather than a clean result, and a run holding a finding is not one where every
   * source failed.
   */
  const anySucceeded =
    input.sourceOutcomes.some((s) => s.outcome === 'COMPLETED' || s.outcome === 'PARTIAL') ||
    findingCounts.total > 0 ||
    input.unresolvedLeadCount > 0;
  const anyTruncated = input.sourceOutcomes.some((s) => s.truncation !== null);
  const anySkipped = input.sourceOutcomes.some((s) => s.outcome === 'SKIPPED');
  // An unmeasured language narrows coverage even when every source succeeded. See the field.
  const anyUnmeasuredLanguage = (input.unmeasuredLanguages ?? []).length > 0;

  const coverage: CoverageState = !input.anyWorkDispatched
    ? 'UNKNOWN'
    : failedSources.length > 0 || anyTruncated || anySkipped || anyUnmeasuredLanguage
      ? 'INCOMPLETE'
      : 'WITHIN_DECLARED_SCOPE';

  if (input.cancelled) {
    return {
      execution: 'CANCELLED',
      // A cancelled run still reports what it found before it was stopped — deleting that would
      // be the same discard in a different costume — but a cancelled run that found nothing has
      // established **nothing**, and must never say `NO_MATCHES_FOUND`. It was stopped; it did
      // not finish looking. `NOT_EVALUATED` is the honest word for a plan that was abandoned
      // part-way, and it is the one difference between this branch and the completed one.
      findings: findingCounts.total > 0 ? describeFindings(findingCounts) : 'NOT_EVALUATED',
      coverage: input.anyWorkDispatched ? 'INCOMPLETE' : 'UNKNOWN',
      failedSources,
      findingCounts,
    };
  }

  if (!input.anyWorkDispatched || !anySucceeded) {
    // Every source failed. This is a failure, not a clean result (T47).
    return {
      execution: 'FAILED',
      findings: 'NOT_EVALUATED',
      coverage: input.anyWorkDispatched ? 'INCOMPLETE' : 'UNKNOWN',
      failedSources,
      findingCounts,
    };
  }

  // Some sources worked and some did not. `PARTIAL` is exactly that statement, and it is what
  // keeps the succeeding sources' findings on the result instead of failing the whole run.
  const execution: ExecutionState =
    failedSources.length > 0 || anyTruncated || anySkipped ? 'PARTIAL' : 'SUCCEEDED';

  return {
    execution,
    findings: describeFindings(findingCounts),
    coverage,
    failedSources,
    findingCounts,
  };
}

/**
 * The findings state implied by the counts, and the only place that mapping is written.
 *
 * Read it as a ladder of honesty rather than of severity: say the strongest thing the evidence
 * supports, and never say "nothing" while holding something.
 */
export function describeFindings(counts: FindingCounts): FindingsState {
  if (counts.confirmed > 0) {
    return 'CONFIRMED_MATCHES_FOUND';
  }
  if (counts.ambiguous > 0) {
    return 'AMBIGUOUS_MATCHES_FOUND';
  }
  if (counts.other > 0 || counts.unresolvedLeads > 0) {
    // Material exists and none of it resolved. `UNRESOLVED` already meant this for leads; a
    // `CONTRADICTED` or `LEAD_ONLY` finding is the same statement with a document attached.
    return 'UNRESOLVED';
  }
  return 'NO_MATCHES_FOUND';
}

/**
 * The one condition under which a run may say it found nothing.
 *
 * Exported and asserted rather than left as a comment because this is the claim that does
 * damage: a screening product reporting "no matches" over a finding it is simultaneously
 * returning is worse than one that reports an error, because nobody goes and looks.
 *
 * Returns the violation as a sentence, or `null` when the pair is honest.
 */
export function assertNoMatchIsHonest(input: {
  readonly findings: FindingsState;
  readonly counts: FindingCounts;
}): string | null {
  if (input.findings !== 'NO_MATCHES_FOUND') {
    return null;
  }
  if (input.counts.total > 0) {
    return (
      `NO_MATCHES_FOUND reported alongside ${String(input.counts.total)} finding(s) ` +
      `(confirmed ${String(input.counts.confirmed)}, ambiguous ${String(input.counts.ambiguous)}, ` +
      `other ${String(input.counts.other)}). The findings are the evidence; the state is wrong.`
    );
  }
  if (input.counts.unresolvedLeads > 0) {
    return (
      `NO_MATCHES_FOUND reported alongside ${String(input.counts.unresolvedLeads)} unresolved ` +
      `lead(s). A candidate that was looked at and rejected is not the same as nothing found.`
    );
  }
  return null;
}

export interface NoMatchStatementInput {
  readonly sourceCount: number;
  readonly languages: readonly string[];
  readonly jurisdictions: readonly string[];
  readonly enabledCategories: readonly string[];
  readonly taxonomyVersion: number;
  readonly policyVersion: number;
  /** ISO 8601 UTC timestamp of the run. */
  readonly runAt: string;
  /** Earliest date the searched sources actually reach. Published on every result (D2). */
  readonly archiveHorizon: string;
  readonly coverage: CoverageState;
  readonly failedSources: readonly SourceCoverageOutcome[];
  /** Languages requested that carry no measured recall figure (T80). */
  readonly unmeasuredLanguages: readonly string[];
  /**
   * Languages whose term list has not been reviewed by a reader of that language (D-010, D6).
   *
   * Distinct from `unmeasuredLanguages`, and both can be true at once. Unmeasured means *we have
   * not checked how much this finds*. Unreviewed means *we are not sure we asked the right
   * question* — a wrong term does not fail, it returns nothing, so a category searched with an
   * unreviewed list can report no findings because the query was wrong rather than because
   * nothing exists.
   *
   * Optional so an existing caller compiles; absent means "none declared", which is the honest
   * reading of a caller that has not considered it rather than a claim that every list is
   * reviewed.
   */
  readonly unreviewedTermLanguages?: readonly string[] | undefined;
}

export interface NoMatchStatement {
  readonly headline: string;
  readonly lines: readonly string[];
}

/**
 * FR-13 — the qualified no-match statement.
 *
 * The words "clear", "clean" and "no adverse media" are never produced. What the service can
 * honestly say is that it did not find matches *in the sources and scope it searched*, and
 * it must say what that scope was.
 */
export function renderNoMatchStatement(input: NoMatchStatementInput): NoMatchStatement {
  const lines: string[] = [
    `Searched: ${String(input.sourceCount)} sources across ${String(input.languages.length)} language(s) and ${String(input.jurisdictions.length)} jurisdiction(s)`,
    `Languages: ${input.languages.join(', ') || 'none'}   Jurisdictions: ${input.jurisdictions.join(', ') || 'none'}`,
    `Categories: ${input.enabledCategories.join(', ') || 'none'}   Taxonomy v${String(input.taxonomyVersion)}   Policy v${String(input.policyVersion)}`,
    `Date: ${input.runAt}   Archive horizon: ${input.archiveHorizon}`,
  ];

  if (input.coverage === 'WITHIN_DECLARED_SCOPE') {
    lines.push('Coverage: WITHIN_DECLARED_SCOPE — the declared plan completed for every source');
  } else {
    const detail =
      input.failedSources.length > 0
        ? input.failedSources
            .map(
              (s) =>
                `${s.sourceName}: ${s.detail ?? s.outcome}${s.queriesAffected > 0 ? ` (${String(s.queriesAffected)} quer${s.queriesAffected === 1 ? 'y' : 'ies'} affected)` : ''}`,
            )
            .join('; ')
        : 'no source-level detail recorded';
    lines.push(`Coverage: ${input.coverage} — ${detail}`);
  }

  if (input.unmeasuredLanguages.length > 0) {
    lines.push(
      `Unmeasured languages: ${input.unmeasuredLanguages.join(', ')} — no measured recall figure exists for these; treat their coverage as unknown`,
    );
  }

  const unreviewed = input.unreviewedTermLanguages ?? [];
  if (unreviewed.length > 0) {
    lines.push(
      `Unreviewed term lists: ${unreviewed.join(', ')} — the search terms in these languages ` +
        `were authored by hand and have not been reviewed by a reader of the language. A wrong ` +
        `term returns nothing rather than failing, so an empty result here may mean the query ` +
        `was wrong rather than that nothing exists`,
    );
  }

  return { headline: 'No matches found in the sources and scope searched.', lines };
}

/** The standing display line required by FR-13 on every results surface. */
export const REVIEW_DISCLAIMER =
  'Potential matches requiring review. Reporting does not establish identity or wrongdoing and is not a final compliance decision.';
