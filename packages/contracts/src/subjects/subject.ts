/**
 * FR-01 — subject and search input.
 *
 * The design rule that shapes this whole file: **no Western first-name/last-name splitting.**
 * A subject has a full name as written, plus aliases with their origin. Splitting a name into
 * given/family destroys patronymic chains, mononyms, and every naming system where the family
 * name comes first — and it does so silently, at intake, before any matching can compensate.
 *
 * Unicode and original scripts are preserved alongside derived normalised forms. The original
 * is what a reviewer sees; the derived forms are what the matcher uses.
 */

import { z } from 'zod';

/** Date precision is declared, never inferred. A missing date stays missing (FR-07). */
export const datePrecisionSchema = z.enum(['DAY', 'MONTH', 'YEAR', 'UNKNOWN']);

export const preciseDateSchema = z
  .object({
    /** ISO 8601 date, or null. Null is never backfilled with "today". */
    value: z.string().date().nullable(),
    precision: datePrecisionSchema,
  })
  .strict()
  .refine((d) => (d.value === null) === (d.precision === 'UNKNOWN'), {
    message: 'A null date must declare UNKNOWN precision, and vice versa.',
  });

/** Where an alias came from. A self-declared alias and a court-recorded one differ in weight. */
export const aliasOriginSchema = z.enum([
  'SELF_DECLARED',
  'CUSTOMER_RECORD',
  'OFFICIAL_DOCUMENT',
  'PUBLIC_REGISTER',
  'MAIDEN_NAME',
  'MARRIED_NAME',
  'TRANSLITERATION',
  'UNKNOWN',
]);

export const aliasSchema = z
  .object({
    /** The alias exactly as written, in its original script. */
    name: z.string().min(1).max(500),
    origin: aliasOriginSchema,
    /** BCP-47 tag for the language this form belongs to, when known. */
    language: z.string().max(35).optional(),
  })
  .strict();

export const companyIdentifierSchema = z
  .object({
    /** Registration number as issued. Not normalised — registries differ. */
    registrationNumber: z.string().min(1).max(100),
    /** ISO 3166-1 alpha-2. "EU", "MENA" and "SEA" are never valid (FR-05). */
    jurisdiction: z.string().length(2).toUpperCase(),
    name: z.string().min(1).max(500).optional(),
  })
  .strict();

/**
 * A screening purpose is required (FR-01). Purpose limitation is a data-protection control
 * (SEC-05), not paperwork: it decides what may be retained and for how long.
 */
export const screeningPurposeSchema = z.enum([
  'CUSTOMER_ONBOARDING',
  'PERIODIC_REVIEW',
  'ENHANCED_DUE_DILIGENCE',
  'TRANSACTION_MONITORING_ESCALATION',
  'SUPPLIER_DUE_DILIGENCE',
  'EMPLOYEE_SCREENING',
]);

export const createSubjectSchema = z
  .object({
    /**
     * The full name as written, in its original script. Not split into parts.
     * `normaliseName` in the domain package derives every comparison form from this.
     */
    fullName: z.string().min(1).max(500),

    aliases: z.array(aliasSchema).max(50).default([]),

    /**
     * Optional, and partial dates are fully supported. Sparse identity may be searched — it
     * simply stays unresolved rather than being invented (FR-01).
     */
    dateOfBirth: preciseDateSchema.optional(),

    /** ISO 3166-1 alpha-2 codes giving identity context, not a search scope. */
    countryContext: z.array(z.string().length(2).toUpperCase()).max(20).default([]),

    /**
     * Companies the client believes are associated. These are **candidate** associations
     * until independently verified, and are labelled as supplied-and-reviewed (FR-01).
     */
    knownCompanies: z.array(companyIdentifierSchema).max(50).default([]),

    /**
     * Recorded so an integrator can correlate. Explicitly **not** a database lookup
     * instruction and **not** an authorisation credential (section 4.1).
     */
    externalSubjectRef: z.string().max(200).optional(),
    externalCaseRef: z.string().max(200).optional(),

    purpose: screeningPurposeSchema,
  })
  .strict(); // Unknown fields are rejected, not ignored (section 3.1).

export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;

/**
 * The name-frequency prior, computed at intake (FR-01) and visible to reviewers.
 *
 * It is stored on the subject version rather than computed at match time so that a historical
 * search can explain the penalty it applied, even if the population data has since changed.
 */
export const nameFrequencyPriorSchema = z
  .object({
    decile: z.number().int().min(1).max(10),
    population: z.string().min(1),
    sourceRef: z.string().min(1),
  })
  .strict();

export const subjectVersionSchema = z
  .object({
    subjectId: z.string(),
    subjectVersionId: z.string(),
    version: z.number().int().positive(),
    tenantId: z.string(),

    fullName: z.string(),
    /** Derived comparison forms. Present alongside the original, never replacing it. */
    normalised: z
      .object({
        folded: z.string(),
        sortedCoreKey: z.string(),
        phoneticKeys: z.array(z.string()),
        scripts: z.array(z.string()),
      })
      .strict(),

    aliases: z.array(aliasSchema),
    dateOfBirth: preciseDateSchema.nullable(),
    countryContext: z.array(z.string()),
    knownCompanies: z.array(
      companyIdentifierSchema.extend({
        /** Supplied companies are candidates until verified (FR-01). */
        verificationStatus: z.enum([
          'SUPPLIED_UNVERIFIED',
          'SUPPLIED_REVIEWED',
          'REGISTRY_VERIFIED',
        ]),
      }),
    ),

    externalSubjectRef: z.string().nullable(),
    externalCaseRef: z.string().nullable(),
    purpose: screeningPurposeSchema,

    /** Null when the population has no measured distribution for this name. */
    nameFrequencyPrior: nameFrequencyPriorSchema.nullable(),

    createdAt: z.string().datetime(),
    /** Data updates create a new revision; a historical search keeps the one it ran on. */
    supersededAt: z.string().datetime().nullable(),
  })
  .strict();

export type SubjectVersion = z.infer<typeof subjectVersionSchema>;
