/**
 * C4 — the statistics the D12 decision is recorded with.
 *
 * **A mean latency is the wrong number and this module refuses to be the place it comes from.**
 * Screening latency is a tail problem: the reviewer who waits is the one on the slow request,
 * and a distribution with a 12 ms mean and a 900 ms p99 is a bad experience that averages well.
 * So every figure reported is a quantile, and the sample count and the spread travel with it.
 *
 * Pure, so the summary logic is unit-tested rather than eyeballed in benchmark output — a
 * percentile function that is quietly off by one index produces plausible numbers, which is the
 * worst kind of wrong for a measurement that closes a decision.
 */

export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * Nearest-rank quantile on the sorted sample.
 *
 * Nearest-rank rather than interpolated: an interpolated p99 reports a latency that no request
 * actually experienced. For a decision about whether a real request is fast enough, the honest
 * answer is a real observation.
 */
export function quantile(sortedAscending: readonly number[], q: number): number {
  if (sortedAscending.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil(q * sortedAscending.length);
  const index = Math.min(Math.max(rank, 1), sortedAscending.length) - 1;
  return sortedAscending[index] ?? Number.NaN;
}

export function summarise(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return {
      count: 0,
      min: Number.NaN,
      p50: Number.NaN,
      p90: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: total / sorted.length,
  };
}

/**
 * Whether two latency distributions are far enough apart to decide anything.
 *
 * The C4 brief says an unconvincing measurement leaves D12 open, so "unconvincing" needs a
 * definition rather than a feeling. This is a deliberately blunt one: the distributions are
 * treated as distinguishable only if the p95 figures differ by more than `marginRatio` — a
 * difference smaller than that, on a single developer machine sharing a CPU with seven
 * containers, is machine noise wearing a decision's clothes.
 */
export function isDecisive(
  a: LatencySummary,
  b: LatencySummary,
  marginRatio = 0.25,
): { readonly decisive: boolean; readonly ratio: number } {
  const slower = Math.max(a.p95, b.p95);
  const faster = Math.min(a.p95, b.p95);
  if (!Number.isFinite(slower) || !Number.isFinite(faster) || faster === 0) {
    return { decisive: false, ratio: Number.NaN };
  }
  const ratio = slower / faster;
  return { decisive: ratio - 1 > marginRatio, ratio };
}

export interface RecallResult {
  readonly attempted: number;
  readonly found: number;
  readonly recall: number;
}

/**
 * Recall over a set of retrieval outcomes.
 *
 * `attempted === 0` yields a recall of `NaN`, never 1. A class with no queries in it has not
 * demonstrated perfect recall; it has demonstrated nothing, and a 100% that means "untested" is
 * the single most dangerous number this file could produce.
 */
export function recallOf(outcomes: readonly boolean[]): RecallResult {
  const attempted = outcomes.length;
  const found = outcomes.filter(Boolean).length;
  return { attempted, found, recall: attempted === 0 ? Number.NaN : found / attempted };
}
