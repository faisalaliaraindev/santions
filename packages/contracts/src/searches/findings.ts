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

import { FINDING_CATEGORIES } from '@erly/adverse-domain';

import { findingCountsSchema } from './search.js';
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
    /**
     * How a metasearch layer found this document, when one did (FR-09).
     *
     * Absent for everything else, and the absence is the point: an SEC litigation release is not
     * "discovered by" anything, and a field present on every finding would read as though it
     * were. `publisher` and `url` above remain the evidence; these two are the channel that led
     * to it, and a reviewer must be able to tell them apart.
     */
    discoverySource: z.string().optional(),
    /**
     * Every engine that surfaced this article, sorted.
     *
     * A list because a merged metasearch result is one article several engines returned. Three
     * engines here is **one** document contributing **one** thing to `axes.independenceCount` —
     * the engines are channels, not sources, and clustering never sees them. Recording them is
     * provenance; counting them would be the independence inflation FR-10 exists to prevent.
     */
    discoveryEngines: z.array(z.string()).optional(),
    /** Present for records produced from a locally indexed publisher snapshot. */
    sourceRecordId: z.string().optional(),
    sourceSnapshotVersion: z.string().optional(),
    parserVersion: z.string().optional(),
    rawEvidenceHash: z.string().optional(),
    /**
     * Set when the source this document came from has been suspended **since** the run produced
     * it (T36, decision D-031).
     *
     * The result is not retro-actively deleted — deleting it would destroy an accurate record of
     * what was found and when — but a later read must show that the source has since been
     * suspended, or a reviewer re-reading a six-month-old report is relying on a source this
     * service has stopped using without being told.
     */
    sourceSuspendedSince: z.string().nullable().optional(),
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

    /**
     * What kind of adverse signal this is, from a **closed** list.
     *
     * The seventeen FR-03 conduct categories plus the three designation categories — a sanctions
     * listing, a debarment, a regulator's warning list. One enum rather than two fields, because
     * an integrator's question ("what is adverse about this person?") is one question, and a
     * caller wanting only designations filters on those three values.
     *
     * It was `z.string()` until 2026-09-21, which is how `SANCTIONS_DESIGNATION` reached the API
     * from the indexed-source path without ever appearing in a schema: a value no generated
     * client could switch on and no consumer could have known to expect. A free string in a
     * contract is not a permissive contract, it is an absent one.
     *
     * Null when the document reports no categorisable conduct.
     */
    category: z.enum(FINDING_CATEGORIES).nullable(),
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
    /**
     * Where it stopped.
     *
     * `RELEVANCE` is before a socket opens — FR-06's filter decided the candidate was not worth
     * a request. It is a separate value from `FETCH` on purpose: a reviewer reading "rejected at
     * FETCH" about something that was never fetched has been told something untrue about what
     * the service did.
     */
    stage: z.enum(['RELEVANCE', 'FETCH', 'EXTRACTION', 'CLASSIFICATION']),
    /**
     * The host this candidate would have been fetched from.
     *
     * Carried separately from `publisher`, which is the publisher's *name* as discovery reported
     * it. A reviewer asking "which publishers is this deployment not approved to contact?" needs
     * the domain, because the domain is what an approval is written against.
     */
    publisherDomain: z.string(),
    /**
     * Did a request actually leave for this candidate?
     *
     * `false` for everything refused before the socket — an unapproved publisher, a relevance
     * rejection, a closed breaker. `true` once a fetch was attempted, whatever it returned. The
     * field exists so "rejected at FETCH" can be read correctly: it distinguishes *we decided
     * not to ask* from *we asked and it did not work out*.
     */
    fetchAttempted: z.boolean(),
    /**
     * The upstream discovery engines that surfaced this candidate, when it came from a
     * metasearch service. Empty for a lead a publisher's own feed produced.
     */
    discoveredByEngines: z.array(z.string()).default([]),
  })
  .strict();

/**
 * What each live discovery connector put on the wire for this run (**D-060**).
 *
 * # Why a response carries request counts at all
 *
 * The FR-05 ladder now holds two shapes of source, and the difference between them is a
 * statement about **how many requests a run makes**:
 *
 * - a `FIXED_FEED` — the SEC's lists — is polled whole and matched locally, so its cost is one
 *   request per poll floor *however large the query plan is*;
 * - a `QUERY_FEED` — GDELT — takes the planned query as a parameter, so its cost is one request
 *   per planned query, bounded by the source's budget.
 *
 * Neither claim can be checked against a result that says `SUCCEEDED` and lists source ids, and
 * "the architecture behaves as designed" is exactly the thing a reviewer or an auditor has to be
 * able to check rather than believe. So the counts are reported.
 *
 * # What it deliberately does not contain
 *
 * **No query text and no URLs.** A planned query is the subject's name plus a conduct term, and
 * a query-feed URL contains it verbatim. `endpointDigest` counts stand in for both: they answer
 * "were these distinct network operations?" without moving personal data into an audit field.
 *
 * # Null versus empty
 *
 * `null` means this run cannot say — no request log was held by the process that ran it. An
 * empty `sources` list means no **live** discovery connector made an attempt, which is what a
 * mock-mode run looks like. They are different facts and are never collapsed: reporting zero
 * requests for a run that was not measured would be reporting a cheap search that never happened.
 */
export const liveDiscoverySourceStatSchema = z
  .object({
    sourceId: z.string(),
    sourceName: z.string(),
    /** What the approved source version records. Not inferred from behaviour. */
    endpointKind: z.enum(['FIXED_FEED', 'QUERY_FEED']),
    /** The hosts addressed, so a reader can see that more than one publisher was attempted. */
    hosts: z.array(z.string()),
    /** Planned queries this connector was asked to serve. */
    queriesOffered: z.number().int().nonnegative(),
    /** Of those, how many opened a socket. What the publisher's own log would show. */
    requestsIssued: z.number().int().nonnegative(),
    /** Offered minus issued: served from the fixed-feed poll cache inside the poll floor. */
    servedWithoutRequest: z.number().int().nonnegative(),
    /**
     * Distinct endpoints actually requested.
     *
     * The cache-collapse guard. Many offered queries against **one** distinct endpoint is
     * correct for a fixed feed and is a defect for a query feed.
     */
    distinctEndpoints: z.number().int().nonnegative(),
    /** FR-04 families offered to this connector. */
    families: z.array(z.string()),
    /** FR-04 families that produced a real outbound request. */
    familiesRequested: z.array(z.string()),
  })
  .strict();

export const liveDiscoverySchema = z
  .object({
    sources: z.array(liveDiscoverySourceStatSchema),
    totalRequestsIssued: z.number().int().nonnegative(),
  })
  .strict();

export type LiveDiscoverySummary = z.infer<typeof liveDiscoverySchema>;

/**
 * What one upstream search engine did for this run.
 *
 * # Why per engine rather than per source
 *
 * `liveDiscoverySourceStatSchema` above counts requests per **source**, and the metasearch layer
 * is one source. It would report "searxng-adverse-media: 8 queries, 8 requests" and be entirely
 * correct and entirely useless, because the failures that matter inside this source are per
 * engine: Google blocked on a CAPTCHA while Bing and DuckDuckGo answered is the shape the whole
 * failure-isolation claim rests on, and one number per source cannot express it.
 *
 * # Every configured engine appears, including the ones that were off
 *
 * An engine a tenant has switched off is here with `attempted: false` and
 * `outcome: DISABLED_BY_POLICY`, carrying the decision id. It is never omitted. An absent engine
 * would leave "what happened to Google?" unanswerable, which is the first question anybody asks
 * of an adverse-media result.
 *
 * # What is NOT in here
 *
 * No query text, no URLs, no credentials. A planned query is the subject's name plus a conduct
 * term. What is here is counts, engine names, durations and the instance's own failure
 * sentences, none of which names the person searched.
 */
export const searxngEngineStatSchema = z
  .object({
    /** Our name for the engine. `GOOGLE_NEWS`, `BING_NEWS`, and so on. */
    engine: z.string(),
    /** What the instance calls it, so a report can be matched against its `/config`. */
    searxngEngineName: z.string(),
    /** False for `DISABLED_BY_POLICY` and `NOT_CONFIGURED` — nothing was put on the wire. */
    attempted: z.boolean(),
    /**
     * The run-level outcome: the **worst** this engine had across the run's queries.
     *
     * An engine that answered nine queries and was rate-limited on the tenth reads
     * `RATE_LIMITED`, because that is the fact that changes what a reader should do. Its nine
     * queries' results are unaffected — this describes the engine's reliability, not what was
     * kept. `ZERO_RESULTS` is **not** a failure: it is a working engine reporting it has nothing.
     */
    outcome: z.enum([
      'RETURNED_RESULTS',
      'ZERO_RESULTS',
      'TIMEOUT',
      'RATE_LIMITED',
      'CAPTCHA',
      'ACCESS_DENIED',
      'CONNECTION_ERROR',
      'DISABLED_BY_POLICY',
      'NOT_CONFIGURED',
      'INTERNAL_ERROR',
    ]),
    queriesAttempted: z.number().int().nonnegative(),
    queriesReturnedResults: z.number().int().nonnegative(),
    queriesFailed: z.number().int().nonnegative(),
    /** Total wall time across this engine's own requests. */
    durationMs: z.number().int().nonnegative(),
    /**
     * Results this engine returned, counted per engine.
     *
     * Deliberately NOT summable into a document count: one article returned by three engines
     * counts once for each. The run's candidate count is `uniqueCandidateUrls` below.
     */
    resultsReturned: z.number().int().nonnegative(),
    /**
     * Canonical URLs **only this engine** found.
     *
     * The number that answers "was this engine worth querying?", which `resultsReturned` does
     * not: an engine that returned forty articles every other engine also returned added nothing.
     */
    uniqueResultsContributed: z.number().int().nonnegative(),
    /** The instance's own sentences, or the decision id for a policy skip. Deduplicated. */
    failureReasons: z.array(z.string()),
    /** The platform's reading of this engine's upstream terms. Never set by a tenant. */
    governanceStatus: z.string(),
    decisionId: z.string(),
    /**
     * **LOCAL DIAGNOSTIC ONLY.** Present, and true, only on an engine a local development
     * diagnostic ran for this one search (`X-Local-Discovery-Diagnostic`). `governanceStatus`
     * still carries the unchanged reading, and no tenant setting was changed. Absent on every
     * normal run.
     */
    diagnosticOverride: z.boolean().optional(),
    /** True alongside `diagnosticOverride`: the enablement applied to this search only. */
    diagnosticOnly: z.boolean().optional(),
    /** True alongside `diagnosticOverride`: the engine was executable for this search. */
    effectiveEnabled: z.boolean().optional(),
  })
  .strict();

export const searxngDiscoverySchema = z
  .object({
    /**
     * The source-level outcome, derived from the engine rows rather than asserted.
     *
     * `COMPLETED` covers "every engine answered with results" and "every engine answered with
     * nothing" alike — a zero result is a working source reporting a fact. `PARTIAL` is some
     * engines failing while others answered, and the results of the ones that answered are kept.
     * `FAILED` is every attempted engine failing. `REFUSED` is nothing being attempted at all,
     * which is not a failure: nothing was asked.
     */
    sourceOutcome: z.enum(['COMPLETED', 'PARTIAL', 'FAILED', 'REFUSED']),
    /** Engines the connector integrates. Never filtered by permission. */
    enginesConfigured: z.number().int().nonnegative(),
    /** Of those, the ones this tenant has switched on. */
    enginesPermitted: z.number().int().nonnegative(),
    /** Of those, the ones a request was actually made for. */
    enginesAttempted: z.number().int().nonnegative(),
    enginesReturnedResults: z.number().int().nonnegative(),
    enginesFailed: z.number().int().nonnegative(),
    perEngine: z.array(searxngEngineStatSchema),
    queriesIssued: z.number().int().nonnegative(),
    /** Candidates across every query and engine, before deduplication. */
    totalRawResults: z.number().int().nonnegative(),
    /** Distinct canonical URLs. This is the candidate count. */
    uniqueCandidateUrls: z.number().int().nonnegative(),
    /**
     * `totalRawResults - uniqueCandidateUrls`: how much of the multi-engine yield was one story.
     *
     * Stated rather than left to be subtracted, because it is the number that proves the merge
     * happened. Four engines returning one Reuters article is one candidate and three collapsed
     * duplicates — not four findings.
     */
    duplicatesCollapsed: z.number().int().nonnegative(),
    /**
     * What the pipeline did with the candidates.
     *
     * Null when the run did not reach those stages. Null and zero are different facts and are
     * kept apart: zero fetched articles from forty candidates means every one was refused at the
     * fetch gate, which is a coverage statement; null means nobody counted.
     */
    articlesFetched: z.number().int().nonnegative().nullable(),
    findingsGenerated: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type SearxngDiscoverySummaryDto = z.infer<typeof searxngDiscoverySchema>;

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
     * The counts behind `findingsState`, so a client can act on this page without interpreting
     * a state name — and so a source that failed can never make a finding that succeeded
     * invisible. `findingCounts.total` and `findings.length` describe the same set.
     */
    findingCounts: findingCountsSchema,
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
          /**
           * The FR-06 class behind a failure — `RATE_LIMITED`, `HARD_BLOCK`, and so on.
           *
           * `detail` is the sentence a reviewer reads; this is the same fact for a program, so a
           * client deciding whether re-running the search could help does not have to
           * pattern-match English. Null when the outcome is not a failure, or when nothing
           * classified it.
           */
          failureClass: z.string().nullable().optional(),
          /**
           * For a locally indexed source: which snapshot answered, how fresh it is, and how many
           * rows it holds.
           *
           * These are what let a caller tell the four outcomes apart without reading prose:
           * searched and current, searched but stale (`freshness: 'STALE'`, outcome `PARTIAL`),
           * no snapshot at all (`snapshotVersion: null`, outcome `FAILED`), and a refresh that
           * failed while the last-known-good snapshot kept answering. Absent for a query-time
           * source, which has no snapshot behind it.
           */
          snapshotVersion: z.string().nullable().optional(),
          freshness: z.enum(['CURRENT', 'STALE', 'UNAVAILABLE']).nullable().optional(),
          snapshotRowCount: z.number().int().nonnegative().nullable().optional(),
        })
        .strict(),
    ),
    /** Languages searched without a measured recall figure (FR-03, T80). */
    unmeasuredLanguages: z.array(z.string()),
    /**
     * Sources that have been suspended since this run produced its results (T36, D-031).
     *
     * Surfaced here as well as on each document deliberately. The per-document note answers "can
     * I rely on this finding?"; this list answers "has anything about this whole report changed?",
     * which is the question a reviewer re-opening an old result actually asks, and which they
     * would otherwise have to reconstruct by reading every finding.
     */
    sinceSuspendedSources: z.array(z.object({ sourceId: z.string(), note: z.string() }).strict()),
    /** MOCK for the whole run when no live source was contacted. */
    mode: z.enum(['MOCK', 'LIVE']),
    /**
     * Request counts per live discovery source. Null when this run was not measured.
     *
     * Optional on the wire so an older stored run — one completed before this field existed —
     * reads back without being retro-fitted with a count nobody recorded.
     */
    liveDiscovery: liveDiscoverySchema.nullable().optional(),
    /**
     * Per-engine diagnostics for the rung-5 metasearch layer. Null when this run was not measured.
     *
     * Optional on the wire so a run stored before this field existed reads back without being
     * retro-fitted with diagnostics nobody recorded.
     */
    searxngDiscovery: searxngDiscoverySchema.nullable().optional(),
  })
  .strict();

export type FindingsPage = z.infer<typeof findingsPageSchema>;
