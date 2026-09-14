/**
 * FR-02 — the association graph as it is served to a reviewer.
 *
 * `GET /v1/searches/{searchId}/associations` returns the **frozen** snapshot the run was pinned
 * to, not a fresh look at the register. A registry correction next month must not rewrite what
 * a historical search explained.
 *
 * Two shapes in here carry the weight, and both exist to keep a distinction that a flatter
 * response would lose.
 *
 * **`edges` versus `unresolvedCandidates`.** An edge belongs to an officer the graph could say
 * something about; an unresolved candidate is a person of the same name the graph could not
 * attribute. Both are returned, because hiding the second would let a reviewer believe the
 * register held only one person by that name (T14). Neither is a finding.
 *
 * **`attachesCompany`.** The one boolean that says whether this edge may anchor a company
 * query. It is not derivable from `resolution` alone — an edge can be resolved and still out of
 * scope — so it is stated rather than left to each consumer to recompute, differently.
 */

import { z } from 'zod';

import { preciseDateSchema } from '../subjects/subject.js';

export const resolutionStatusSchema = z.enum([
  /** The register record is attributed to the subject. Its companies attach. */
  'RESOLVED',
  /** A near match. Shown to a reviewer; attaches nothing and anchors nothing. */
  'CANDIDATE_FOR_REVIEW',
  /** A name match with no corroboration. The expected result of a name-only search. */
  'UNRESOLVED',
  /** The register contradicts the subject on a strong identifier. Excluded. */
  'CONTRADICTED',
]);

export const currencyStateSchema = z.enum([
  'CURRENT_CONFIRMED',
  /** An appointment with no resignation recorded. Never reported as confirmed. */
  'CURRENT_PER_REGISTER_SILENCE',
  'FORMER',
  'UNKNOWN',
]);

export const tenureLabelSchema = z.enum([
  'DURING_TENURE',
  'BEFORE_TENURE',
  'AFTER_TENURE',
  'SPANNING',
  'UNKNOWN',
]);

/**
 * Association coverage.
 *
 * `UNKNOWN` is not a worse `INCOMPLETE`: it means no approved register covers the jurisdiction,
 * so nothing was asked. Neither value ever means "no associations exist".
 */
export const associationCoverageSchema = z.enum(['COMPLETE', 'INCOMPLETE', 'UNKNOWN']);

export const identityFactorSchema = z
  .object({
    kind: z.string(),
    strength: z.enum(['STRONG', 'MODERATE', 'WEAK']),
    direction: z.enum(['CORROBORATING', 'ABSENT', 'CONTRADICTING']),
    detail: z.string(),
  })
  .strict();

export const associationEdgeSchema = z
  .object({
    assertionId: z.string(),
    officerRef: z.string(),
    officerName: z.string(),
    companyRef: z.string(),
    companyName: z.string(),
    jurisdiction: z.string(),
    role: z.string(),
    /** Each carries its own declared precision. A missing date stays null (FR-07). */
    appointedOn: preciseDateSchema,
    resignedOn: preciseDateSchema,
    /** When the register was read. FR-02 requires it stored; a stale read is a weaker claim. */
    observedAt: z.string(),
    resolution: resolutionStatusSchema,
    identityGrade: z.enum(['CORROBORATED', 'PARTIAL', 'WEAK', 'CONTRADICTED']),
    nameMatch: z.string(),
    /** The factors the grade was computed from, shown verbatim to the reviewer. */
    identityFactors: z.array(identityFactorSchema),
    resolutionRationale: z.array(z.string()),
    currency: currencyStateSchema,
    inScope: z.boolean(),
    /** Why an edge was left out of scope. An omission with no reason is a gap. */
    scopeReason: z.string(),
    attachesCompany: z.boolean(),
    sourceId: z.string(),
    parserVersion: z.string(),
    mode: z.enum(['MOCK', 'LIVE']),
  })
  .strict();

export const associationCompanySchema = z
  .object({
    companyRef: z.string(),
    jurisdiction: z.string(),
    name: z.string(),
    status: z.string(),
    incorporatedOn: preciseDateSchema,
    observedAt: z.string(),
    sourceId: z.string(),
  })
  .strict();

export const unresolvedCandidateSchema = z
  .object({
    officerRef: z.string(),
    officerName: z.string(),
    jurisdiction: z.string(),
    resolution: resolutionStatusSchema,
    identityGrade: z.enum(['CORROBORATED', 'PARTIAL', 'WEAK', 'CONTRADICTED']),
    nameMatch: z.string(),
    resolutionRationale: z.array(z.string()),
  })
  .strict();

export const associationGraphSchema = z
  .object({
    searchId: z.string(),
    snapshotId: z.string(),
    /** `PENDING` until the worker has built it. Not an error, and not an empty graph. */
    status: z.enum(['PENDING', 'BUILT']),
    scope: z.enum(['CURRENT_ONLY', 'INCLUDE_FORMER']),
    coverage: z
      .object({
        outcome: associationCoverageSchema,
        detail: z.string().nullable(),
        sourceId: z.string().nullable(),
        /** Every bound that bound, named. A silently truncated graph is a narrower search. */
        boundsApplied: z.array(z.string()),
      })
      .strict(),
    edges: z.array(associationEdgeSchema),
    companies: z.array(associationCompanySchema),
    unresolvedCandidates: z.array(unresolvedCandidateSchema),
    /** Set when this snapshot replaced an earlier one. The earlier one is never mutated. */
    refreshOfSnapshotId: z.string().nullable(),
    builtAt: z.string().nullable(),
  })
  .strict();

export type AssociationGraph = z.infer<typeof associationGraphSchema>;
export type AssociationEdge = z.infer<typeof associationEdgeSchema>;
