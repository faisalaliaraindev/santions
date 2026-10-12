/**
 * FR-02 / FR-04 — the one-hop traversal bounds, and what happens when one binds.
 *
 * "Use one-hop traversal with configurable bounds."
 *
 * # The rule this file exists to enforce
 *
 * **A silently truncated graph is a narrower search reported as a complete one.** That is the
 * whole reason a bound is not simply a `.slice()`. When a bound binds, three things must survive
 * to the reviewer: that it bound, which one, and by how much. A graph that quietly returns the
 * first twenty-five of four hundred officers and reports itself complete is worse than one that
 * fails outright, because nobody goes looking for what is missing.
 *
 * So every bound produces a `BoundApplication` record, and the record is what the coverage
 * statement is built from. `TRUNCATED_BY_PLAN` in FR-06 is the same idea one layer up, and this
 * deliberately mirrors it.
 *
 * # Why the bounds are configuration and not constants
 *
 * They live on the tenant's **policy version**, which is versioned, four-eyes approved (D1) and
 * pinned onto the run (`pinVersions`). Three consequences follow, and all three matter:
 *
 * - a customer who screens shell-company networks can raise them without a deployment;
 * - raising them is an approved change with an audit entry, not an environment variable;
 * - a historical search explains its own truncation under **the bounds it actually ran with**,
 *   rather than under whatever is configured on the day somebody reads the report.
 *
 * The last one is why the resolved bounds are copied onto the snapshot rather than re-read.
 */

/** The three bounds FR-02 names. Each is enforced at a different point in the traversal. */
export const GRAPH_BOUND_KINDS = [
  /** Officers the register may return for the subject's name before we stop considering more. */
  'MAX_OFFICER_CANDIDATES',
  /** Companies one officer may contribute. A director of 300 shells is a real case. */
  'MAX_COMPANIES_PER_OFFICER',
  /** Total edges in one snapshot, across every officer. The backstop on the other two. */
  'MAX_EDGES_PER_SNAPSHOT',
] as const;
export type GraphBoundKind = (typeof GRAPH_BOUND_KINDS)[number];

export interface GraphBounds {
  readonly maxOfficerCandidates: number;
  readonly maxCompaniesPerOfficer: number;
  readonly maxEdgesPerSnapshot: number;
}

/**
 * The defaults, used when a policy version declares none.
 *
 * Chosen to be generous enough that binding is unusual and small enough that a pathological
 * name cannot produce an unbounded traversal. They are **not** a measurement — no workload has
 * been run against a real register — and that is stated here rather than implied by the
 * specificity of the numbers.
 */
export const DEFAULT_GRAPH_BOUNDS: GraphBounds = {
  maxOfficerCandidates: 25,
  maxCompaniesPerOfficer: 50,
  maxEdgesPerSnapshot: 500,
};

/** Hard ceilings. A policy may narrow the traversal; it may not remove the bound. */
export const GRAPH_BOUND_CEILINGS: GraphBounds = {
  maxOfficerCandidates: 200,
  maxCompaniesPerOfficer: 500,
  maxEdgesPerSnapshot: 5000,
};

/**
 * One bound, binding once.
 *
 * `available` is null when the source does not say how many there were. That is a different
 * fact from a known total and leads a reviewer somewhere different — "more than 25, we do not
 * know how many" is a reason to narrow the search; "25 of 312" is a reason to raise the bound.
 */
export interface BoundApplication {
  readonly bound: GraphBoundKind;
  readonly limit: number;
  readonly available: number | null;
  /** What it applied to — a subject name, an officer reference. Never empty. */
  readonly appliedTo: string;
}

/** How a bound reads to a reviewer. Written out, because the enum name is not a sentence. */
export function describeBound(application: BoundApplication): string {
  const total =
    application.available === null
      ? 'the register did not say how many exist'
      : `${String(application.available)} exist`;

  switch (application.bound) {
    case 'MAX_OFFICER_CANDIDATES':
      return (
        `Officer candidates for ${application.appliedTo} were capped at ` +
        `${String(application.limit)}; ${total}. Officers beyond the cap were not considered.`
      );
    case 'MAX_COMPANIES_PER_OFFICER':
      return (
        `Companies for officer ${application.appliedTo} were capped at ` +
        `${String(application.limit)}; ${total}. Further directorships were not retrieved.`
      );
    case 'MAX_EDGES_PER_SNAPSHOT':
      return (
        `This association graph reached its limit of ${String(application.limit)} edges while ` +
        `processing ${application.appliedTo}. The graph is incomplete beyond that point.`
      );
  }
}

/**
 * Resolve the bounds a run will use, from whatever the policy version declares.
 *
 * Returns the bounds **and** the problems, rather than throwing. A policy with a nonsensical
 * bound must not stop a search: it falls back to the default for that field and says so, and the
 * message travels into the coverage statement. Throwing would take a screening run down over a
 * configuration typo, which is a worse failure than running with a documented default.
 */
export function resolveGraphBounds(declared: unknown): {
  readonly bounds: GraphBounds;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const source = isRecord(declared) ? declared : {};

  const read = (key: keyof GraphBounds): number => {
    const raw = source[key];
    if (raw === undefined || raw === null) {
      return DEFAULT_GRAPH_BOUNDS[key];
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      problems.push(
        `Policy bound ${key} is ${JSON.stringify(raw)}, which is not a positive whole number. ` +
          `Using the default of ${String(DEFAULT_GRAPH_BOUNDS[key])}.`,
      );
      return DEFAULT_GRAPH_BOUNDS[key];
    }
    if (raw > GRAPH_BOUND_CEILINGS[key]) {
      problems.push(
        `Policy bound ${key} is ${String(raw)}, above the ceiling of ` +
          `${String(GRAPH_BOUND_CEILINGS[key])}. Using the ceiling. A bound that can be raised ` +
          `without limit is not a bound.`,
      );
      return GRAPH_BOUND_CEILINGS[key];
    }
    return raw;
  };

  return {
    bounds: {
      maxOfficerCandidates: read('maxOfficerCandidates'),
      maxCompaniesPerOfficer: read('maxCompaniesPerOfficer'),
      maxEdgesPerSnapshot: read('maxEdgesPerSnapshot'),
    },
    problems,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
