/**
 * FR-01 / section 6.1 — search creation and the three result dimensions.
 */

import { z } from 'zod';

import { REGIONAL_PSEUDO_CODES } from '../admin/admin.js';
import { createSubjectSchema } from '../subjects/subject.js';

/**
 * An ISO 3166-1 alpha-2 country code, as a search scope may name one.
 *
 * Deliberately a separate declaration from `countryCodeSchema` in `../admin/admin.js` rather
 * than an import: that one is the admin surface's, and the two happen to agree today but answer
 * to different requirements — FR-05 for source permissions there, the coverage statement here.
 * The shared thing worth sharing is the list of regional pseudo-codes, so that is what is
 * imported.
 */
const searchCountryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'Must be an ISO 3166-1 alpha-2 country code.')
  .transform((value) => value.toUpperCase())
  .refine((value) => !REGIONAL_PSEUDO_CODES.includes(value), {
    message:
      'Regional groupings cannot be searched as a jurisdiction. Name each country explicitly ' +
      '(FR-05) — coverage, rights and source permissions are all recorded per country.',
  });

export const createSearchSchema = z
  .object({
    /**
     * Either an existing service-owned subject, or an identity snapshot to create one from.
     * Zquence sends an explicit permitted snapshot, or first creates a subject (section 4.1).
     */
    subjectRef: z
      .object({
        subjectId: z.string().min(1),
        /** Pinning the version means a refresh cannot silently re-scope a historical run. */
        version: z.number().int().positive(),
      })
      .strict()
      .optional(),

    subjectSnapshot: createSubjectSchema.optional(),

    externalCaseRef: z.string().max(200).optional(),

    /**
     * The scope the caller is asking for. What was actually searched is reported back in the
     * coverage statement, which may be narrower.
     */
    requestedScope: z
      .object({
        /**
         * Each jurisdiction as an ISO 3166-1 alpha-2 country code.
         *
         * This was `z.string().length(2)`, which accepted any two characters — `EU`, `ZZ` and
         * `99` were all taken, answered `202`, consumed a job, and surfaced as a run that
         * `FAILED` on polling rather than as a request that was wrong when it was made. The
         * admin side has validated this properly all along (`countryCodeSchema`); the caller's
         * own entry point did not, which is the wrong way round.
         *
         * Regional groupings are refused by name. `EU` is not a jurisdiction the way `CR` is:
         * coverage, rights and source permissions are all per country (FR-05), so a scope
         * naming a region cannot be honestly reported against.
         */
        jurisdictions: z.array(searchCountryCodeSchema).min(1).max(50),
        languages: z.array(z.string().max(35)).min(1).max(30),
        /** Omit to use every category enabled for the tenant in that jurisdiction. */
        categories: z.array(z.string()).max(30).optional(),
        /** Historical directorships require an approved historical scope (FR-02). */
        includeFormerDirectorships: z.boolean().default(false),
        /** Earliest event date to search for. Null means the source archive horizon. */
        fromDate: z.string().date().nullable().default(null),
      })
      .strict(),

    /** `sandbox` cannot run live searches or reach live evidence (FR-15). */
    environment: z.enum(['sandbox', 'live']).default('sandbox'),
  })
  .strict()
  .refine((v) => (v.subjectRef === undefined) !== (v.subjectSnapshot === undefined), {
    message: 'Provide exactly one of subjectRef or subjectSnapshot.',
  });

export type CreateSearchInput = z.infer<typeof createSearchSchema>;

/**
 * Section 6.2 — three independent dimensions.
 *
 * They are separate fields, not one status, because "the job finished", "we found nothing"
 * and "we searched everything we said we would" are three different facts. Collapsing them is
 * how a screening product reports a clean result for a run in which every source was blocked.
 */
export const executionStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
]);

/**
 * What the run found.
 *
 * `CONFIRMED_MATCHES_FOUND` and `AMBIGUOUS_MATCHES_FOUND` are separate values because collapsing
 * them is how a run holding a real `AMBIGUOUS` finding came to report `NO_MATCHES_FOUND` — the
 * finding was in `/findings`, and the summary said there was nothing to look at.
 *
 * **`NO_MATCHES_FOUND` now means zero findings of any band and zero unresolved leads**, and
 * nothing else may produce it.
 *
 * `POTENTIAL_MATCHES` is kept so a run completed before this change still parses. It is never
 * newly produced. A client should treat it as "findings exist"; `findingCounts` says which kind.
 */
export const findingsStateSchema = z.enum([
  'CONFIRMED_MATCHES_FOUND',
  'AMBIGUOUS_MATCHES_FOUND',
  'NO_MATCHES_FOUND',
  'UNRESOLVED',
  'NOT_EVALUATED',
  /** Legacy, readable only. See the note above. */
  'POTENTIAL_MATCHES',
]);

/**
 * Findings by band, as counts.
 *
 * Published so a client never has to infer "is there anything to look at?" from a state name it
 * may not recognise, and so a new state value added later cannot silently hide a finding from an
 * older client: `total > 0` is true regardless of what the state is called.
 *
 * Not a score (I9). A tally of how many documents fell in each band is the same arithmetic a
 * reviewer does by looking at the list, and it is never combined into a person-level figure.
 */
export const findingCountsSchema = z
  .object({
    /** `CORROBORATED` or `SUPPORTED`. */
    confirmed: z.number().int().nonnegative(),
    /** `AMBIGUOUS` or `COMPANY_CONTEXT` — real findings that do not clear FR-11's bar. */
    ambiguous: z.number().int().nonnegative(),
    /** `CONTRADICTED` or `LEAD_ONLY`. Returned from `/findings`, so counted here. */
    other: z.number().int().nonnegative(),
    /** Every band. The only figure that may be called a no-match when it is zero. */
    total: z.number().int().nonnegative(),
    /** Candidates rejected before becoming findings, each with its reason (FR-06). */
    unresolvedLeads: z.number().int().nonnegative(),
  })
  .strict();

export type FindingCounts = z.infer<typeof findingCountsSchema>;

export const coverageStateSchema = z.enum(['WITHIN_DECLARED_SCOPE', 'INCOMPLETE', 'UNKNOWN']);

export const searchSummarySchema = z
  .object({
    searchId: z.string(),
    tenantId: z.string(),
    subjectId: z.string(),
    subjectVersion: z.number().int().positive(),
    environment: z.enum(['sandbox', 'live']),

    execution: executionStateSchema,
    findings: findingsStateSchema,
    coverage: coverageStateSchema,
    /**
     * The counts `findings` was derived from.
     *
     * Optional on the wire so a run stored before this field existed reads back without being
     * retro-fitted with numbers nobody recorded. Present on every run this service completes.
     */
    findingCounts: findingCountsSchema.optional(),

    /**
     * Every version needed to explain this result later. A historical search must be able to
     * say why it was permitted and how it was scoped at the time, even after the tenant's
     * configuration has changed (section 6.3).
     */
    pinnedVersions: z
      .object({
        taxonomyVersion: z.number().int(),
        policyVersion: z.number().int(),
        entitlementVersion: z.number().int(),
        bandingRulesVersion: z.string(),
      })
      .strict(),

    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),

    /** Set when this run was created by refreshing an earlier one (FR-13). */
    refreshOfSearchId: z.string().nullable(),

    /** Never a fabricated percentage (FR-14). Stage counts and the rung reached, or nothing. */
    progress: z
      .object({
        stagesCompleted: z.number().int().nonnegative(),
        stagesTotal: z.number().int().nonnegative(),
        cascadeRungReached: z.number().int().min(0).max(7).nullable(),
        warnings: z.array(z.string()),
      })
      .strict(),

    /**
     * The revision a state-changing action must quote (FR-12, matrix row FI-13).
     *
     * Exposed rather than kept internal because an optimistic-concurrency scheme the client
     * cannot see is one the client cannot participate in: without the current revision, a
     * reviewer has nothing to put in `If-Match` and the only available behaviour is to
     * overwrite whatever is there. It is also returned as the `ETag` of a single search.
     */
    revision: z.number().int().positive(),
  })
  .strict();

export type SearchSummary = z.infer<typeof searchSummarySchema>;

/**
 * FR-12 — cancelling a run in flight.
 *
 * The reason is required and is not decoration: a cancelled run is a permanent part of the
 * audit trail, and "why did this screening stop?" is a question a regulator asks about the
 * run that was abandoned rather than the ones that finished.
 */
export const cancelSearchSchema = z
  .object({
    reason: z.string().min(1).max(500),
  })
  .strict();

export type CancelSearchInput = z.infer<typeof cancelSearchSchema>;

export const searchAcceptedSchema = z
  .object({
    searchId: z.string(),
    statusUrl: z.string(),
    execution: executionStateSchema,
  })
  .strict();
