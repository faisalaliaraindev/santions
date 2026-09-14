/**
 * FR-04 — turning a subject and its frozen graph into a bounded, entity-anchored query plan.
 *
 * `query-families.ts` already defines the eight families, the drop priority and `boundPlan`.
 * What was missing was the thing that *builds* the queries, and it is pure for the same reason
 * the rest of this package is: what a search asked is part of what a search has to explain, and
 * a plan assembled inside an I/O service is a plan nobody can re-derive from the record.
 *
 * # The rule that shapes every template here
 *
 * **Every query is anchored to an entity.** `assertPlanIsEntityAnchored` enforces it and this
 * builder never produces anything that would fail it: there is no family that searches a bare
 * category term, a bare place, or a bare date range. An unanchored query returns the internet,
 * and whatever it returns gets attached to a named human being.
 *
 * # What is deliberately not built
 *
 * - **F3 produces nothing when the taxonomy's lexicon is empty**, which it is today. A category
 *   query needs category *terms*, and inventing them here would put words in front of a source
 *   that no reviewer approved through the taxonomy lifecycle (FR-03). An empty lexicon means no
 *   F3 queries and a coverage statement that says so — not a guess at what "fraud" is in Spanish.
 * - **F6 and company-anchored F2 use only companies the graph resolved.** A candidate for review
 *   never anchors a query (FR-02, T14). That is the whole point of `attachesCompany`.
 * - **F8 is a second pass** and is not built here: it follows an event that classification has
 *   not produced yet.
 */

import type { NormalisedName } from '../identity/name-forms.js';
import type { AdverseCategory } from '../taxonomy/categories.js';
import {
  enabledCategories,
  type CountryCode,
  type LanguageTag,
  type TaxonomyVersion,
} from '../taxonomy/types.js';

import type { PlannedQuery, QueryFamily } from './query-families.js';

/** A company the graph resolved well enough to anchor a query on. */
export interface AnchorCompany {
  readonly companyRef: string;
  readonly name: string;
  /** The office held, as the register printed it. Used by F2, not by F6. */
  readonly role: string;
}

export interface PlanInput {
  readonly subjectName: string;
  readonly normalisedName: NormalisedName;
  /** Alias forms as written. Each produces its own F1, because a search is per name form. */
  readonly aliases: readonly string[];
  readonly jurisdictions: readonly CountryCode[];
  readonly languages: readonly LanguageTag[];
  readonly taxonomy: TaxonomyVersion;
  /**
   * Companies that may anchor a query. **Only** those the graph resolved — a candidate for
   * review is shown to a reviewer and never searched against.
   */
  readonly anchorCompanies: readonly AnchorCompany[];
  /** Stable per run, so two identical searches produce identical query ids. */
  readonly queryIdPrefix: string;
}

/** Quote a name so a source treats it as a phrase rather than a bag of words. */
function phrase(value: string): string {
  return `"${value}"`;
}

/**
 * Build the plan, before bounding.
 *
 * Deterministic: the same subject, graph and taxonomy produce the same queries in the same
 * order with the same ids. A plan whose ids move between runs cannot be compared across a
 * refresh, and FR-04's `followsEventId` would point at nothing.
 */
export function buildQueryPlan(input: PlanInput): readonly PlannedQuery[] {
  const queries: PlannedQuery[] = [];
  let sequence = 0;

  const add = (
    family: QueryFamily,
    query: string,
    language: LanguageTag,
    jurisdiction: CountryCode,
    companyId: string | null,
  ): void => {
    sequence += 1;
    queries.push({
      queryId: `${input.queryIdPrefix}-${String(sequence).padStart(4, '0')}`,
      family,
      query,
      language,
      jurisdiction,
      companyId,
      followsEventId: null,
    });
  };

  const nameForms = [input.subjectName, ...input.aliases];

  for (const jurisdiction of input.jurisdictions) {
    for (const language of input.languages) {
      // F1 — bare identity. Never dropped, and the reason the plan is never empty: a search
      // that asked nothing is a search that cannot report coverage of anything.
      for (const form of nameForms) {
        add('F1', phrase(form), language, jurisdiction, null);
      }

      // F2 — identity plus role, company or office held. Anchored on a resolved company.
      for (const company of input.anchorCompanies) {
        add(
          'F2',
          `${phrase(input.subjectName)} ${phrase(company.name)}`,
          language,
          jurisdiction,
          company.companyRef,
        );
      }

      // F3 — identity plus category terms, per enabled category and language, bounded to the
      // top terms. Produces nothing while the lexicon is empty; see the file header.
      for (const category of enabledCategories(input.taxonomy, jurisdiction)) {
        for (const term of topTermsFor(input.taxonomy, category, language, 3)) {
          add('F3', `${phrase(input.subjectName)} ${term}`, language, jurisdiction, null);
        }
      }

      // F4 — identity plus jurisdiction context. Never dropped.
      add('F4', `${phrase(input.subjectName)} ${jurisdiction}`, language, jurisdiction, null);

      // F6 — company-anchored, for each resolved company. The company is the entity here, and
      // the finding it produces is company-level until attribution says otherwise (axis B).
      for (const company of input.anchorCompanies) {
        add('F6', phrase(company.name), language, jurisdiction, company.companyRef);
      }
    }
  }

  return queries;
}

/**
 * The top-N conduct terms for a category in a language, in the taxonomy's declared rank order.
 *
 * **Conduct and procedural terms only.** An authority name is not a search term for a person:
 * `"Ana Solís" Fiscalía` finds every article that mentions the prosecutor, which is most of
 * them, and dilutes the plan without improving recall.
 *
 * Sorted by `rank` before slicing, because FR-04 says the top-N are kept and the taxonomy is
 * what declares which those are. Slicing the array as stored would make the plan depend on
 * insertion order.
 */
function topTermsFor(
  taxonomy: TaxonomyVersion,
  category: AdverseCategory,
  language: LanguageTag,
  limit: number,
): readonly string[] {
  return taxonomy.lexicon
    .filter(
      (term) =>
        term.category === category &&
        term.language === language &&
        (term.kind === 'CONDUCT' || term.kind === 'PROCEDURAL'),
    )
    .toSorted((a, b) => a.rank - b.rank || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((term) => term.term);
}
