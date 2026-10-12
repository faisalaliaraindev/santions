/**
 * FR-04 — query planning. The eight families, plan bounding and the declared drop order.
 *
 * The anti-pattern this replaces: searching only "name + fraud", "name + bribery". That is a
 * confirmation-bias engine — it cannot find an article describing conduct in words the
 * taxonomy did not anticipate, and it produces a false clean whenever the reporting uses a
 * register the term list does not cover. Queries are anchored on the entity; adverse terms
 * narrow a second pass and never define the first.
 */

export const QUERY_FAMILIES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const;
export type QueryFamily = (typeof QUERY_FAMILIES)[number];

export interface QueryFamilyDefinition {
  readonly family: QueryFamily;
  readonly name: string;
  readonly content: string;
  /** F1 and F4 are never dropped by plan truncation (FR-04, T78). */
  readonly neverDropped: boolean;
  /** F8 runs as a second pass after classification and again on every refresh. */
  readonly secondPass: boolean;
}

export const QUERY_FAMILY_DEFINITIONS: readonly QueryFamilyDefinition[] = [
  {
    family: 'F1',
    name: 'Bare identity',
    content: 'Exact name plus minimal disambiguating context.',
    neverDropped: true,
    secondPass: false,
  },
  {
    family: 'F2',
    name: 'Identity plus role',
    content: 'Name plus job title, company name or office held.',
    neverDropped: false,
    secondPass: false,
  },
  {
    family: 'F3',
    name: 'Identity plus category',
    content: 'Name plus taxonomy conduct terms, per enabled category and language, top-N bounded.',
    neverDropped: false,
    secondPass: false,
  },
  {
    family: 'F4',
    name: 'Identity plus procedural terms',
    content: 'Name plus charged, indicted, convicted, acquitted, fined, disqualified, settled.',
    neverDropped: true,
    secondPass: false,
  },
  {
    family: 'F5',
    name: 'Identity plus authority',
    content: 'Name plus named regulators, prosecutors and courts for jurisdictions in scope.',
    neverDropped: false,
    secondPass: false,
  },
  {
    family: 'F6',
    name: 'Company-anchored',
    content: 'Company name and registration number plus category and procedural terms.',
    neverDropped: false,
    secondPass: false,
  },
  {
    family: 'F7',
    name: 'Alias and script variants',
    content: 'Transliterations, name-order permutations, maiden/married and patronymic forms.',
    neverDropped: false,
    secondPass: false,
  },
  {
    family: 'F8',
    name: 'Outcome follow-up',
    content: 'Per event at stage 3+: appeal, overturned, acquitted, dropped, dismissed, quashed.',
    neverDropped: true,
    secondPass: true,
  },
];

/**
 * Declared drop priority, applied in order when the plan cap binds. Never random.
 *
 * Rationale for the order: F7 alias permutations multiply fastest and mostly duplicate F1
 * recall for Latin-script names; F6 company queries are second-order to the person; F3
 * category terms are the most numerous and the most redundant with F1; F5 authority terms
 * are jurisdiction-specific and narrow; F2 is a small family that materially disambiguates
 * common names, so it is dropped last.
 */
export const DROP_PRIORITY: readonly QueryFamily[] = ['F7', 'F6', 'F3', 'F5', 'F2'];

/** Families that plan truncation must never touch. */
export const UNDROPPABLE: readonly QueryFamily[] = ['F1', 'F4', 'F8'];

export interface PlannedQuery {
  readonly queryId: string;
  readonly family: QueryFamily;
  readonly query: string;
  readonly language: string;
  readonly jurisdiction: string;
  /** Set for F6 and company-anchored F2. */
  readonly companyId: string | null;
  /** Set for F8, linking the outcome query back to the event it follows up. */
  readonly followsEventId: string | null;
}

export type TruncationReason = 'TRUNCATED_BY_PLAN' | 'TRUNCATED_BY_QUOTA';

export interface BoundedPlan {
  readonly kept: readonly PlannedQuery[];
  readonly dropped: readonly PlannedQuery[];
  /** Families that lost at least one query, recorded on the run (FR-04). */
  readonly droppedFamilies: readonly QueryFamily[];
  readonly truncation: TruncationReason | null;
  readonly cap: number;
}

/**
 * Bound a plan to the tenant cap by dropping in declared priority order.
 *
 * Throws if the undroppable families alone exceed the cap: silently discarding F1 or F4 to
 * fit a cap would turn a truncated plan into an unreported one, which FR-04 forbids. The
 * caller must raise the cap or reduce the alias/language scope.
 */
export function boundPlan(queries: readonly PlannedQuery[], cap: number): BoundedPlan {
  if (queries.length <= cap) {
    return { kept: queries, dropped: [], droppedFamilies: [], truncation: null, cap };
  }

  const undroppable = new Set<QueryFamily>(UNDROPPABLE);
  const protectedQueries = queries.filter((q) => undroppable.has(q.family));

  if (protectedQueries.length > cap) {
    throw new Error(
      `Query plan cap of ${String(cap)} is below the ${String(protectedQueries.length)} undroppable ` +
        `F1/F4/F8 queries. Raise the cap or narrow the language and alias scope; F1 and F4 are never dropped.`,
    );
  }

  const droppable = queries.filter((q) => !undroppable.has(q.family));
  // Drop from the lowest-priority family first, and within a family from the end of the list
  // (the planner emits terms in rank order, so later entries are lower-ranked terms).
  const dropped: PlannedQuery[] = [];
  let budget = queries.length - cap;

  for (const family of DROP_PRIORITY) {
    if (budget <= 0) {
      break;
    }
    const inFamily = droppable.filter((q) => q.family === family);
    const take = Math.min(budget, inFamily.length);
    dropped.push(...inFamily.slice(inFamily.length - take));
    budget -= take;
  }

  const droppedIds = new Set(dropped.map((q) => q.queryId));
  const kept = queries.filter((q) => !droppedIds.has(q.queryId));
  const droppedFamilies = [...new Set(dropped.map((q) => q.family))].sort();

  return { kept, dropped, droppedFamilies, truncation: 'TRUNCATED_BY_PLAN', cap };
}

/** FR-04: F1 is always generated. Negative-keyword-only search is prohibited. */
export function assertPlanIsEntityAnchored(queries: readonly PlannedQuery[]): void {
  if (!queries.some((q) => q.family === 'F1')) {
    throw new Error(
      'Query plan contains no F1 (bare identity) query. Negative-keyword-only search is prohibited (FR-04).',
    );
  }
}
