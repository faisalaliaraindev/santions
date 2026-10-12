/**
 * FR-01 — the name-frequency prior.
 *
 * "Compute and store a name-frequency prior for the subject name in its relevant population at
 * intake. This value is an input to FR-08 identity grading and must be visible to reviewers."
 *
 * The prior is what stops a common name from reaching a confident identity grade on weak
 * evidence (test T71). It is stored on the subject version rather than recomputed at match
 * time, so a historical search can explain the penalty it applied even after the population
 * data changes.
 *
 * **Honesty constraint:** a name with no measured distribution returns `null`, not a guessed
 * decile. A fabricated prior would be worse than none — it would look like evidence.
 */

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import type { NormalisedName } from '@adverse-search/domain';

export interface NameFrequencyPrior {
  readonly decile: number;
  readonly population: string;
  readonly sourceRef: string;
}

/**
 * A measured name distribution for one population. Populated from published national name
 * statistics; empty until a source is loaded.
 */
interface NameFrequencyRecord {
  /** Case-folded, diacritic-stripped surname or full-name key. */
  readonly nameKey: string;
  /** ISO 3166-1 alpha-2, or a broader population label where that is what was measured. */
  readonly population: string;
  readonly decile: number;
  readonly sourceRef: string;
}

@Injectable()
export class NameFrequencyService {
  private readonly profiles: Collection<NameFrequencyRecord>;

  constructor(db: Db) {
    this.profiles = db.collection<NameFrequencyRecord>('nameFrequencyProfiles');
  }

  async ensureIndexes(): Promise<void> {
    await this.profiles.createIndex({ nameKey: 1, population: 1 }, { unique: true });
  }

  /**
   * Look up the prior for a name in its relevant population.
   *
   * Returns null when no distribution has been loaded for that population, or when the name is
   * not in it. Both are honest "we do not know" answers, and Axis A treats a null prior as
   * simply applying no frequency penalty rather than as evidence of rarity.
   */
  async lookup(input: {
    readonly fullName: string;
    readonly normalised: NormalisedName;
    readonly countryContext: readonly string[];
  }): Promise<NameFrequencyPrior | null> {
    const populations = input.countryContext.length > 0 ? input.countryContext : [];
    if (populations.length === 0) {
      // No country context means no relevant population, so no meaningful prior.
      return null;
    }

    // Match on the whole folded name first, then on the last core token, which is the closest
    // thing to a surname that survives not splitting names into given/family.
    const coreTokens = input.normalised.tokens
      .filter((t) => t.kind === 'CORE')
      .map((t) => t.folded);
    const candidateKeys = [input.normalised.folded, coreTokens.at(-1)].filter(
      (k): k is string => k !== undefined && k !== '',
    );

    const record = await this.profiles.findOne({
      nameKey: { $in: candidateKeys },
      population: { $in: [...populations] },
    });

    if (record === null) {
      return null;
    }

    return {
      decile: record.decile,
      population: record.population,
      sourceRef: record.sourceRef,
    };
  }
}
