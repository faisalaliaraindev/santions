/**
 * FR-01 / section 6.1 — search creation and the three result dimensions.
 */

import { z } from 'zod';

import { createSubjectSchema } from '../subjects/subject.js';

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
        jurisdictions: z.array(z.string().length(2).toUpperCase()).min(1).max(50),
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

export const findingsStateSchema = z.enum([
  'POTENTIAL_MATCHES',
  'NO_MATCHES_FOUND',
  'UNRESOLVED',
  'NOT_EVALUATED',
]);

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
  })
  .strict();

export type SearchSummary = z.infer<typeof searchSummarySchema>;

export const searchAcceptedSchema = z
  .object({
    searchId: z.string(),
    statusUrl: z.string(),
    execution: executionStateSchema,
  })
  .strict();
