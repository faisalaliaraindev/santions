import type { SourceCoverageOutcome } from '@erly/adverse-domain';

/**
 * A source the request's `sources` filter left out.
 *
 * `SKIPPED`, never absent: `aggregateRun` reads a skip as a coverage gap, so a single-source test
 * run is `INCOMPLETE` by construction and cannot be mistaken for a full screening that came back
 * clean. Shared by the discovery ladder and the indexed sources so both say it the same way.
 */
export function excludedBySourceFilter(
  sourceId: string,
  sourceName: string,
  cascadeRung: number,
): SourceCoverageOutcome {
  return {
    sourceId,
    sourceName,
    cascadeRung,
    outcome: 'SKIPPED',
    detail:
      'Not asked: this request restricted the run to named sources (`sources`) and did not ' +
      'name this one. This is not evidence that nothing exists here.',
    queriesAffected: 0,
    truncation: null,
  };
}
