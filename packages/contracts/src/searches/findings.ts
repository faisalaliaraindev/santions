/**
 * FR-11 / FR-13 — a finding, as a reviewer receives it.
 *
 * This is the contract the control panel will generate its client from, so everything a
 * reviewer needs to *judge* a finding has to be here — not only what it concluded, but what it
 * concluded it from. A finding that arrives as a band and a headline cannot be reviewed; it can
 * only be believed.
 *
 * Four rules are carried in the shape rather than in prose.
 *
 * **1. The band never arrives alone.** `axes` and `rationale` ride with it. FR-08 requires the
 * four contributing values be retained verbatim next to the band, and FR-13 requires the
 * reviewer see why. A response that returned `band` and nothing else would be a score.
 *
 * **2. There is no numeric risk score, anywhere.** Invariant I9. A band is a statement about
 * how well evidence supports a connection; a number invites arithmetic on it, and arithmetic on
 * a band is how "two weak leads" becomes "one medium risk".
 *
 * **3. Every claim points back into the document.** Spans are offsets into the normalised text,
 * and the document id resolves to stored evidence. A quotation with no span cannot be checked.
 *
 * **4. An inference is labelled as one.** When attribution rests on a role or a company
 * association rather than the document naming the person, `attribution.isInference` is true and
 * `attribution.statement` is the sentence that must be shown (FR-11, axis B).
 */

import { z } from 'zod';

import { preciseDateSchema } from '../subjects/subject.js';

export const evidenceBandSchema = z.enum([
  'CORROBORATED',
  'SUPPORTED',
  'AMBIGUOUS',
  /** About a company the subject is associated with, not about the subject. */
  'COMPANY_CONTEXT',
  'CONTRADICTED',
  /** A lead, not a finding. Headlines and snippets never rise above this (FR-06). */
  'LEAD_ONLY',
]);

export const identityGradeSchema = z.enum(['CORROBORATED', 'PARTIAL', 'WEAK', 'CONTRADICTED']);
export const attributionGradeSchema = z.enum([
  'DIRECT_PERSONAL',
  'ROLE_INFERRED',
  'COMPANY_ONLY',
  'NO_ATTRIBUTION',
]);

/** The document a finding came from, with the provenance needed to go and read it. */
export const findingDocumentSchema = z
  .object({
    documentId: z.string(),
    documentVersion: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
    publisher: z.string(),
    sourceId: z.string(),
    /** 1 is the highest authority for the reported act — never confidence in identity. */
    authorityTier: z.number().int().min(1).max(5),
    language: z.string().nullable(),
    /** FR-07's four dates, each with declared precision. A missing one stays null. */
    eventDate: preciseDateSchema,
    publicationDate: preciseDateSchema,
    updateDate: preciseDateSchema,
    retrievalDate: preciseDateSchema,
    /** Which rung of the FR-05 cascade reached it. */
    cascadeRung: z.number().int().min(0).max(7),
    /** `MOCK` means fixture data. It is never servable as a live result (T55). */
    mode: z.enum(['MOCK', 'LIVE']),
  })
  .strict();

export const textSpanSchema = z.object({ start: z.number().int(), end: z.number().int() }).strict();

export const findingSchema = z
  .object({
    findingId: z.string(),
    searchId: z.string(),

    /** FR-11. Read it together with `axes` and `rationale`, never alone. */
    band: evidenceBandSchema,
    /** The four axis values that produced the band, retained verbatim (FR-08). */
    axes: z
      .object({
        identity: identityGradeSchema,
        attribution: attributionGradeSchema,
        stage: z.string(),
        partyRole: z.string(),
        authorityTier: z.number().int().min(1).max(5),
        /** Independent sources behind the event. Syndicated copies do not count (FR-10). */
        independenceCount: z.number().int().nonnegative(),
      })
      .strict(),
    /** Every rule that fired, in order. Rendered verbatim in the evidence detail view. */
    rationale: z.array(z.string()),

    /** Null when the document reports no categorisable conduct. */
    category: z.string().nullable(),
    proceduralStage: z.string(),
    partyRole: z.string(),
    /** The body that made the statement. Null when the text names none. */
    namingAuthority: z.string().nullable(),

    attribution: z
      .object({
        grade: attributionGradeSchema,
        /** True when the grade rests on an inference, which must be displayed as one. */
        isInference: z.boolean(),
        /** Shown verbatim beside the finding when `isInference` is true. */
        statement: z.string().nullable(),
        /** Set when the finding reaches the subject through a company. */
        companyRef: z.string().nullable(),
        companyName: z.string().nullable(),
        /** How the event sits against the subject's tenure at that company (FR-09). */
        tenureLabel: z.string().nullable(),
      })
      .strict(),

    document: findingDocumentSchema,
    /** Offsets into the normalised text. A claim with no span cannot be checked. */
    subjectMentionSpans: z.array(textSpanSchema),
    conductSpan: textSpanSchema.nullable(),
    stageSpan: textSpanSchema.nullable(),

    /** The identity factors axis A weighed, shown so a reviewer can disagree with them. */
    identityFactors: z.array(
      z
        .object({
          kind: z.string(),
          strength: z.enum(['STRONG', 'MODERATE', 'WEAK']),
          direction: z.enum(['CORROBORATING', 'ABSENT', 'CONTRADICTING']),
          detail: z.string(),
        })
        .strict(),
    ),

    /** Which planned query surfaced it, so the plan and the result can be read together. */
    queryId: z.string(),
    queryFamily: z.string(),

    extractorVersion: z.string(),
    /** Null for a rule-based extraction, which must say so rather than name a model (FR-07). */
    modelId: z.string().nullable(),
    promptVersion: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;

/**
 * A lead that was found and **not** promoted to a finding, with the reason.
 *
 * Returned rather than discarded because FR-06 requires a rejected candidate to be stored with
 * its rejection reason and visible in the coverage view. A pipeline that silently drops what it
 * decided against is one whose decisions nobody can audit.
 */
export const rejectedLeadSchema = z
  .object({
    leadId: z.string(),
    url: z.string(),
    title: z.string(),
    publisher: z.string(),
    cascadeRung: z.number().int().min(0).max(7),
    queryId: z.string(),
    /** Why it did not become a finding, in a reviewer's words. */
    reason: z.string(),
    stage: z.enum(['FETCH', 'EXTRACTION', 'CLASSIFICATION']),
  })
  .strict();

export const findingsPageSchema = z
  .object({
    searchId: z.string(),
    /**
     * The three result dimensions, repeated here so this response stands on its own. A client
     * that reads findings without reading coverage is a client that reports a clean result for
     * a run in which every source was blocked.
     */
    execution: z.string(),
    findingsState: z.string(),
    coverage: z.string(),
    /**
     * The FR-13 statement shown when nothing was found. Never "no results": it names what was
     * searched, what was not, and what that does and does not mean.
     */
    noMatchStatement: z
      .object({
        headline: z.string(),
        limitations: z.array(z.string()),
        disclaimer: z.string(),
      })
      .strict()
      .nullable(),
    findings: z.array(findingSchema),
    rejectedLeads: z.array(rejectedLeadSchema),
    /** Every source that contributed or failed, with its reason. */
    sourceOutcomes: z.array(
      z
        .object({
          sourceId: z.string(),
          sourceName: z.string(),
          cascadeRung: z.number().int(),
          outcome: z.string(),
          detail: z.string().nullable(),
          truncation: z.string().nullable(),
        })
        .strict(),
    ),
    /** Languages searched without a measured recall figure (FR-03, T80). */
    unmeasuredLanguages: z.array(z.string()),
    /** MOCK for the whole run when no live source was contacted. */
    mode: z.enum(['MOCK', 'LIVE']),
  })
  .strict();

export type FindingsPage = z.infer<typeof findingsPageSchema>;
