/**
 * FR-01 — deriving name-frequency deciles from a measured population.
 *
 * Pure, and separated from the loader that will use it, because the arithmetic is the part
 * that can be wrong in a way nobody notices: a decile boundary computed by rank rather than by
 * population mass makes every surname in a long tail look equally rare, and the T71 penalty
 * then never fires for the names it exists for.
 *
 * # The constraint this respects
 *
 * D0 found that Costa Rica's TSE *padrón electoral* can supply this, under an aggregate-only
 * condition: **derive the counts, discard the roll, and name the use in the SEC-05 approval.**
 * This function takes counts — a surname and how many people carry it — and never sees a
 * person. A loader that passed rows of individuals through here would be doing something this
 * signature cannot express.
 *
 * # Why deciles by population mass
 *
 * Decile 10 must mean "a name carried by a large share of the population", not "in the top ten
 * per cent of distinct surnames". In any real name distribution the distinct-surname ranking is
 * dominated by the tail: tens of thousands of surnames carried by one or two people each. Rank
 * deciles would put a moderately common name in the same band as a unique one, and the penalty
 * that stops a common name reaching a confident identity grade would be applied to the wrong
 * names entirely.
 *
 * So the boundaries are drawn on cumulative population: decile 10 holds the most common names
 * accounting for the first tenth of people, and so on down.
 */

export interface NameCount {
  /** Case-folded, diacritic-stripped. The loader folds; this function does not guess. */
  readonly nameKey: string;
  /** How many people in the measured population carry it. */
  readonly count: number;
}

export interface NameDecile {
  readonly nameKey: string;
  /** 1 is the rarest decile, 10 the most common. Matches `NameFrequencyPrior`. */
  readonly decile: number;
  readonly count: number;
}

/**
 * Assign a decile to every name in a measured distribution.
 *
 * Throws on an empty input rather than returning an empty result: an empty distribution is a
 * loader bug, and silently producing no rows would leave the service with no prior while
 * reporting that one had been loaded — which is worse than not loading it, because the
 * coverage statement would stop saying the prior is missing.
 */
export function assignDeciles(counts: readonly NameCount[]): readonly NameDecile[] {
  if (counts.length === 0) {
    throw new Error(
      'Refusing to derive deciles from an empty distribution. An empty result would be ' +
        'indistinguishable from a loaded one, and the coverage statement would stop reporting ' +
        'the prior as missing.',
    );
  }
  for (const entry of counts) {
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(
        `Name "${entry.nameKey}" has a count of ${String(entry.count)}. A distribution with a ` +
          `non-positive or fractional count is not a measurement.`,
      );
    }
  }

  // Most common first, ties broken by name so the output is deterministic. A distribution
  // whose deciles depend on input order is not reproducible, and the prior it produces cannot
  // be re-derived to check a historical search.
  const sorted = [...counts].toSorted(
    (a, b) => b.count - a.count || a.nameKey.localeCompare(b.nameKey),
  );

  const population = sorted.reduce((total, entry) => total + entry.count, 0);
  const perDecile = population / 10;

  const result: NameDecile[] = [];
  let cumulative = 0;

  for (const entry of sorted) {
    // Placed by where its mass *starts* — that is, by how much of the population is carried by
    // names at least as common as this one.
    //
    // The obvious alternative, the midpoint of the name's own mass, is wrong for exactly the
    // names this exists to catch. A surname carried by 45% of a population has a midpoint at
    // the 22nd percentile and would land in decile 8, so the single most common name in the
    // country would not be flagged as top-decile. Using the start is also monotonic: a rarer
    // name can never receive a higher decile than a more common one.
    const index = Math.min(9, Math.floor(cumulative / perDecile));
    result.push({ nameKey: entry.nameKey, decile: 10 - index, count: entry.count });
    cumulative += entry.count;
  }

  return result;
}

/**
 * The statement that goes in a coverage report when no distribution has been loaded.
 *
 * A named function rather than a string literal at the call site, because this sentence is the
 * honest disclosure for a real gap and it must read the same everywhere it appears.
 */
export function describeMissingNameFrequency(population: string): string {
  return (
    `No name-frequency distribution has been loaded for ${population}, so no top-decile ` +
    `penalty is applied to common names in this population. Identity grading is therefore ` +
    `more permissive for a common name here than it would be with the distribution loaded ` +
    `(FR-08, test T71).`
  );
}
