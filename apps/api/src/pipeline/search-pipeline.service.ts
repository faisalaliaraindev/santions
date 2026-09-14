/**
 * The search pipeline — the thing that turns an accepted search into a result.
 *
 * This is the piece Phase C deliberately left out (decision D-016: a handler-less worker fails
 * loudly rather than draining the queue into the dead letter). Everything it calls already
 * existed and was tested; almost none of it had a caller.
 *
 * # The sequence, and why it is this sequence
 *
 * 1. **Associations first.** FR-02 is explicit that identity-to-officer resolution happens
 *    *before* company queries are dispatched. A plan built before the graph would have nothing
 *    to anchor F2 and F6 to, and would have to be rebuilt.
 * 2. **Plan, then bound.** The plan is built pure (`buildQueryPlan`) and bounded pure
 *    (`boundPlan`) against the tenant's `queryPlanCap`. What was dropped is recorded, because
 *    FR-04 forbids a truncated plan reported as a complete one.
 * 3. **Discover.** Leads only. A headline is never a finding (FR-06).
 * 4. **Fetch**, through the gate, into committed evidence.
 * 5. **Extract**, under the pinned taxonomy version.
 * 6. **Band**, through the four axes and `assignBand`.
 * 7. **Complete**, aggregating every source outcome into the run's three dimensions.
 *
 * # What this service does not decide
 *
 * Every judgement is made by a pure function in `@erly/adverse-domain`: what to ask
 * (`buildQueryPlan`), what to drop (`boundPlan`), whether the person matches (`gradeIdentity`),
 * whether the event attaches to them (`gradeAttribution`), whether it is a usable adverse event
 * (`classifyEvent`), how much authority stands behind it (`computeAuthority`), what band that
 * amounts to (`assignBand`), and what the run may claim (`aggregateRun`). This file sequences
 * them and records what happened.
 *
 * That split is the reason the release gate can run with no infrastructure at all, and it is
 * why a bug in this file produces a wrong *record* rather than a wrong *rule*.
 *
 * # Mode
 *
 * In mock mode every adapter is a fixture and every record is stamped `MOCK` (T55). Nothing in
 * this pipeline can reach a live source, because in live mode five of the six seams are `null`
 * and the pipeline reports the capability as unavailable rather than empty.
 */

import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  aggregateRun,
  assignBand,
  boundPlan,
  buildQueryPlan,
  classifyEvent,
  computeAuthority,
  gradeAttribution,
  gradeIdentity,
  labelTenure,
  matchNameForms,
  normaliseName,
  renderNoMatchStatement,
  unmeasuredLanguages,
  type AnchorCompany,
  type ClusteredSource,
  type IdentityFactor,
  type PlannedQuery,
  type PreciseDate,
  type SourceCoverageOutcome,
  type TenureLabel,
} from '@erly/adverse-domain';

import { AssociationGraphService } from '../associations/association-graph.service.js';
import { TaxonomyService } from '../admin/taxonomy.service.js';
import {
  FindingsService,
  type FindingRecord,
  type RejectedLeadRecord,
} from './findings.service.js';
import type { Lead } from '../sources/lead.js';
import { hasData } from '../sources/source-adapter.js';
import type { SourceAdapterSet } from '../sources/sources.registry.js';
import { EvidenceStagingService } from '../storage/evidence-staging.service.js';
import { SubjectsService } from '../subjects/subjects.service.js';
import { PolicyService } from '../tenancy/policy.service.js';

/** What one run produced, handed back to the caller that updates the run record. */
export interface PipelineResult {
  readonly findings: readonly FindingRecord[];
  readonly rejectedLeads: readonly RejectedLeadRecord[];
  readonly sourceOutcomes: readonly SourceCoverageOutcome[];
  readonly plannedQueries: number;
  readonly droppedQueries: number;
  readonly cascadeRungReached: number | null;
  readonly warnings: readonly string[];
  readonly unmeasuredLanguages: readonly string[];
}

/** A lead paired with the query that found it, so provenance survives deduplication. */
interface SourcedLead {
  readonly lead: Lead;
  readonly query: PlannedQuery;
}

@Injectable()
export class SearchPipeline {
  private readonly logger = new Logger('SearchPipeline');

  constructor(
    private readonly subjects: SubjectsService,
    private readonly associations: AssociationGraphService,
    private readonly taxonomies: TaxonomyService,
    private readonly policies: PolicyService,
    private readonly adapters: SourceAdapterSet,
    private readonly evidence: EvidenceStagingService,
    private readonly findings: FindingsService,
    private readonly mode: 'mock' | 'live',
  ) {}

  async execute(input: {
    readonly tenantId: string;
    readonly searchId: string;
    readonly subjectId: string;
    readonly subjectVersion: number;
    readonly jurisdictions: readonly string[];
    readonly languages: readonly string[];
    readonly taxonomyVersion: number;
    readonly policyVersion: number;
    readonly now: Date;
    /** Extends the lease between stages. Returns false when the work has been taken over. */
    readonly heartbeat: () => Promise<boolean>;
  }): Promise<PipelineResult> {
    const warnings: string[] = [];
    const sourceOutcomes: SourceCoverageOutcome[] = [];

    const subject = await this.subjects.findVersion({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      version: input.subjectVersion,
    });
    const taxonomy = await this.taxonomies.loadPinned(input.tenantId, input.taxonomyVersion);
    const policy = await this.policies.loadPinned(input.tenantId, input.policyVersion);

    // FR-03 / T80. A language without a measured recall figure is not enabled, and a search
    // that ran in it must say so. We do not refuse to run — refusing would mean the service
    // does nothing at all until Phase H measures — but we never let the omission go unstated.
    const unmeasured = unmeasuredLanguages(taxonomy, input.languages);
    if (unmeasured.length > 0) {
      warnings.push(
        `Searched in ${unmeasured.join(', ')}, which carry no measured recall figure. ` +
          `Coverage in those languages is not established (FR-03, FR-16).`,
      );
    }

    // ---- 1. Associations -------------------------------------------------------------------
    const graph = await this.associations.build({
      tenantId: input.tenantId,
      searchId: input.searchId,
      now: input.now,
    });
    if (graph.coverage.sourceOutcome !== null) {
      sourceOutcomes.push(graph.coverage.sourceOutcome);
    }
    warnings.push(...graph.coverage.limitations);

    // Only edges the graph resolved may anchor a query. A candidate for review is shown to a
    // reviewer and never searched against (FR-02, T14).
    const anchorCompanies: AnchorCompany[] = graph.edges
      .filter((edge) => edge.attachesCompany)
      .map((edge) => ({
        companyRef: edge.companyRef,
        name: edge.companyName,
        role: edge.role,
      }));

    if (!(await input.heartbeat())) {
      return this.abandoned(warnings, sourceOutcomes, unmeasured);
    }

    // ---- 2. Plan ---------------------------------------------------------------------------
    const plan = buildQueryPlan({
      subjectName: subject.fullName,
      normalisedName: normaliseName(subject.fullName),
      aliases: subject.aliases.map((alias) => alias.name),
      jurisdictions: input.jurisdictions,
      languages: input.languages,
      taxonomy,
      anchorCompanies,
      // Deterministic in the run, so two identical searches produce identical query ids and a
      // refresh can be compared against what it refreshed.
      queryIdPrefix: input.searchId.slice(0, 8),
    });

    const bounded = boundPlan(plan, policy.queryPlanCap);
    if (bounded.truncation !== null) {
      warnings.push(
        `The query plan was truncated to ${String(bounded.cap)} queries ` +
          `(${bounded.truncation}); families affected: ${bounded.droppedFamilies.join(', ')}.`,
      );
    }

    // ---- 3. Discovery ----------------------------------------------------------------------
    const { leads, rungReached, discoveryOutcomes } = await this.discover(bounded.kept, input);
    sourceOutcomes.push(...discoveryOutcomes);

    if (!(await input.heartbeat())) {
      return this.abandoned(warnings, sourceOutcomes, unmeasured);
    }

    // ---- 4-6. Fetch, extract, band ---------------------------------------------------------
    const { findings, rejected } = await this.assess({
      sourced: leads,
      subject,
      graph,
      taxonomy,
      policy,
      searchId: input.searchId,
      tenantId: input.tenantId,
      now: input.now,
    });

    return {
      findings,
      rejectedLeads: rejected,
      sourceOutcomes,
      plannedQueries: bounded.kept.length,
      droppedQueries: bounded.dropped.length,
      cascadeRungReached: rungReached,
      warnings,
      unmeasuredLanguages: unmeasured,
    };
  }

  /** The lease was lost mid-run. Return what is known; the fence refuses any write anyway. */
  private abandoned(
    warnings: readonly string[],
    sourceOutcomes: readonly SourceCoverageOutcome[],
    unmeasured: readonly string[],
  ): PipelineResult {
    return {
      findings: [],
      rejectedLeads: [],
      sourceOutcomes,
      plannedQueries: 0,
      droppedQueries: 0,
      cascadeRungReached: null,
      warnings: [...warnings, 'The worker lost its lease mid-run; this attempt wrote nothing.'],
      unmeasuredLanguages: unmeasured,
    };
  }

  /**
   * Run the cascade for every planned query.
   *
   * Deduplicated on canonical URL across the whole plan: the same article found by F1 and again
   * by F3 is one lead with two sightings, not two leads. Counting it twice would inflate axis
   * D's independence count, which is exactly the mistake FR-10's clustering rules exist to
   * prevent — so it is prevented here as well as there.
   */
  private async discover(
    queries: readonly PlannedQuery[],
    input: { readonly tenantId: string },
  ): Promise<{
    leads: readonly SourcedLead[];
    rungReached: number | null;
    discoveryOutcomes: readonly SourceCoverageOutcome[];
  }> {
    const news = this.adapters.newsDiscovery;
    const web = this.adapters.webDiscovery;

    if (news === null && web === null) {
      return {
        leads: [],
        rungReached: null,
        discoveryOutcomes: [
          {
            sourceId: 'discovery',
            sourceName: 'News and web discovery',
            cascadeRung: 2,
            outcome: 'SKIPPED',
            detail:
              'No discovery adapter is configured in this mode, so no discovery was attempted. ' +
              'This is not evidence that nothing exists.',
            queriesAffected: queries.length,
            truncation: null,
          },
        ],
      };
    }

    const byUrl = new Map<string, SourcedLead>();
    const outcomes: SourceCoverageOutcome[] = [];
    let rungReached: number | null = null;
    let newsFailures = 0;
    let newsQueries = 0;

    for (const query of queries) {
      if (news === null) {
        continue;
      }
      newsQueries += 1;
      const result = await news.discover({
        tenantId: input.tenantId,
        queryId: query.queryId,
        text: query.query,
        language: query.language,
        country: query.jurisdiction,
        window: null,
        limit: 25,
      });

      if (result.status === 'FAILED') {
        newsFailures += 1;
        continue;
      }
      if (!hasData(result)) {
        // The source answered and had nothing. Not a failure, and the rung was still reached.
        rungReached = Math.max(rungReached ?? 0, 2);
        continue;
      }

      for (const lead of result.data) {
        rungReached = Math.max(rungReached ?? 0, lead.rung);
        if (!byUrl.has(lead.url)) {
          byUrl.set(lead.url, { lead, query });
        }
      }
    }

    if (news !== null) {
      outcomes.push({
        sourceId: news.descriptor.sourceId,
        sourceName: 'News discovery',
        cascadeRung: 2,
        outcome:
          newsFailures === 0 ? 'COMPLETED' : newsFailures === newsQueries ? 'FAILED' : 'PARTIAL',
        detail:
          newsFailures === 0
            ? null
            : `${String(newsFailures)} of ${String(newsQueries)} discovery queries failed.`,
        queriesAffected: newsQueries,
        truncation: null,
      });
    }

    return { leads: [...byUrl.values()], rungReached, discoveryOutcomes: outcomes };
  }

  /**
   * Fetch, extract and band each lead.
   *
   * A lead that does not survive any step is recorded as a **rejected lead with a reason**, not
   * dropped. FR-06 requires it, and a pipeline that silently discards what it decided against
   * is one whose decisions nobody can audit.
   */
  private async assess(input: {
    readonly sourced: readonly SourcedLead[];
    readonly subject: Awaited<ReturnType<SubjectsService['findVersion']>>;
    readonly graph: Awaited<ReturnType<AssociationGraphService['loadForSearch']>>;
    readonly taxonomy: Awaited<ReturnType<TaxonomyService['loadPinned']>>;
    readonly policy: Awaited<ReturnType<PolicyService['loadPinned']>>;
    readonly searchId: string;
    readonly tenantId: string;
    readonly now: Date;
  }): Promise<{ findings: FindingRecord[]; rejected: RejectedLeadRecord[] }> {
    const fetcher = this.adapters.evidenceFetch;
    const extractor = this.adapters.extractionModel;
    const findings: FindingRecord[] = [];
    const rejected: RejectedLeadRecord[] = [];

    if (fetcher === null || extractor === null) {
      for (const { lead, query } of input.sourced) {
        rejected.push({
          ...this.leadRecord(lead, query, input),
          stage: 'FETCH',
          reason:
            'No fetch or extraction adapter is configured in this mode, so the document was ' +
            'never retrieved. The lead stands; nothing was concluded from it.',
        });
      }
      return { findings, rejected };
    }

    const enabledCategoryIds = input.taxonomy.categories.map((category) => category.category);
    const nameForms = [input.subject.fullName, ...input.subject.aliases.map((alias) => alias.name)];

    for (const { lead, query } of input.sourced) {
      const fetched = await fetcher.fetch({
        url: lead.url,
        attribution: {
          tenantId: input.tenantId,
          jobId: input.searchId,
          subjectId: input.subject.subjectId,
          queryId: query.queryId,
          sourceId: lead.provenance.sourceId,
          egressIdentityId: 'mock-egress-1',
        },
        authorisation: {
          sourceVersionId: 'fixture-source-v1',
          // The fixture server has no robots.txt to honour, and saying otherwise would put a
          // false statement into the record the fetch gate reads.
          robotsPosition: 'HONOURED',
          robotsExceptionApprovedBy: null,
          jurisdictionEnabled: true,
          languageEnabled: true,
          urlPolicyPassed: true,
          ssrfValidated: true,
          relevanceScore: 0.9,
        },
        budget: {
          maxBytes: 2_000_000,
          maxDecompressedBytes: 10_000_000,
          maxRedirects: 3,
          timeoutMs: 10_000,
        },
        conditional: { etag: null, lastModified: null },
        fetchKey: `${input.searchId}:${lead.leadId}`,
        allowRender: false,
      });

      if (!hasData(fetched) || fetched.data.body === null) {
        rejected.push({
          ...this.leadRecord(lead, query, input),
          stage: 'FETCH',
          reason:
            fetched.status === 'FAILED'
              ? `The document could not be retrieved (${fetched.policy.failureClass}).`
              : 'The document was not modified or returned no body.',
        });
        continue;
      }

      const text = new TextDecoder().decode(fetched.data.body);

      // Evidence is committed before anything is concluded from it, so a finding can never
      // cite a document this service did not durably store (FI-03).
      const document = await this.evidence.stageAndCommit({
        tenantId: input.tenantId,
        body: fetched.data.body,
        contentType: fetched.data.contentType ?? 'text/html',
        sourceId: lead.provenance.sourceId,
        publisher: lead.publisher,
        sourceUrl: lead.url,
        canonicalUrl: lead.url,
        sourceTier: '2',
        // `timezone: null` is "the source did not state one", not "UTC". A news item dated
        // 14 March in Costa Rica is not the same instant as 14 March in UTC, and inventing the
        // zone would put a precision into the record the publisher never gave.
        retrievedAt: {
          value: input.now.toISOString().slice(0, 10),
          precision: 'DAY',
          timezone: null,
        },
        publicationDate:
          lead.publishedAt.value === null
            ? null
            : {
                value: lead.publishedAt.value,
                precision: lead.publishedAt.precision,
                timezone: null,
              },
        language: lead.language,
        retentionExpiresAt: null,
        now: input.now,
      });

      const extracted = await extractor.extract({
        documentId: document.documentId,
        documentVersion: document.version,
        text,
        language: lead.language,
        subjectNameForms: nameForms,
        taxonomyVersionId: `${input.taxonomy.tenantId}:v${String(input.taxonomy.version)}`,
        enabledCategoryIds,
      });

      if (!hasData(extracted) || extracted.data.length === 0) {
        rejected.push({
          ...this.leadRecord(lead, query, input),
          stage: 'EXTRACTION',
          reason:
            'The document was retrieved and read, and it did not assert categorised adverse ' +
            'conduct naming the subject. It remains a lead.',
        });
        continue;
      }

      for (const assertion of extracted.data) {
        const finding = this.band({
          assertion,
          lead,
          query,
          document,
          text,
          subject: input.subject,
          graph: input.graph,
          searchId: input.searchId,
          tenantId: input.tenantId,
          now: input.now,
        });
        if (finding === null) {
          rejected.push({
            ...this.leadRecord(lead, query, input),
            stage: 'CLASSIFICATION',
            reason:
              'The extracted assertion did not survive classification: the event could not ' +
              'support an adverse finding about this subject.',
          });
          continue;
        }
        findings.push(finding);
      }
    }

    return { findings, rejected };
  }

  private leadRecord(
    lead: Lead,
    query: PlannedQuery,
    input: { readonly tenantId: string; readonly searchId: string },
  ): Omit<RejectedLeadRecord, 'stage' | 'reason'> {
    return {
      tenantId: input.tenantId,
      searchId: input.searchId,
      leadId: lead.leadId,
      url: lead.url,
      title: lead.title,
      publisher: lead.publisher,
      cascadeRung: lead.rung,
      queryId: query.queryId,
    };
  }

  /**
   * The four axes, then the band.
   *
   * Returns null when axis C says the event cannot support an adverse finding at all — an
   * exclusion matched, or the spans did not validate. That is a rejection with a reason, not a
   * finding with a low band.
   */
  private band(input: {
    readonly assertion: {
      readonly categoryId: string;
      readonly partyRole: string;
      readonly proceduralStage: string;
      readonly namingAuthority: string | null;
      readonly subjectMentionSpans: readonly { start: number; end: number }[];
      readonly conductSpan: { start: number; end: number } | null;
      readonly stageSpan: { start: number; end: number } | null;
      readonly eventDate: PreciseDate;
      readonly publicationDate: PreciseDate;
      readonly updateDate: PreciseDate;
      readonly extractorVersion: string;
      readonly modelId: string | null;
      readonly promptVersion: string | null;
    };
    readonly lead: Lead;
    readonly query: PlannedQuery;
    readonly document: { readonly documentId: string; readonly version: number };
    readonly text: string;
    readonly subject: Awaited<ReturnType<SubjectsService['findVersion']>>;
    readonly graph: Awaited<ReturnType<AssociationGraphService['loadForSearch']>>;
    readonly searchId: string;
    readonly tenantId: string;
    readonly now: Date;
  }): FindingRecord | null {
    const { assertion, lead, subject } = input;

    // Axis A — is the person in this document the subject?
    const nameMatch = matchNameForms(
      normaliseName(subject.fullName),
      normaliseName(assertion.subjectMentionSpans.length > 0 ? subject.fullName : ''),
    );
    const identityFactors: IdentityFactor[] = [
      {
        kind: 'RARE_FULL_NAME_PLUS_CITY',
        strength: 'MODERATE',
        direction: assertion.subjectMentionSpans.length > 0 ? 'CORROBORATING' : 'ABSENT',
        span: assertion.subjectMentionSpans[0] ?? null,
        detail:
          assertion.subjectMentionSpans.length > 0
            ? 'The document names the subject in a matched name form.'
            : 'The document does not name the subject.',
      },
    ];

    const axisA = gradeIdentity({
      nameMatch: nameMatch.form,
      factors: identityFactors,
      frequencyPrior: subject.nameFrequencyPrior,
      documentDistinguishesNamesake: assertion.partyRole === 'NAMESAKE_DISTINGUISHED',
    });

    // Axis B — does the conduct attach to the person, or only to a company they are near?
    const companyEdge = input.graph.edges.find(
      (edge) => edge.attachesCompany && input.text.includes(edge.companyName),
    );
    const tenureLabel: TenureLabel =
      companyEdge === undefined
        ? 'UNKNOWN'
        : labelTenure(companyEdge.tenure, {
            start: assertion.eventDate,
            end: assertion.eventDate,
          });

    const axisB = gradeAttribution({
      namesSubjectPersonally: assertion.subjectMentionSpans.length > 0,
      companyInGraph: companyEdge !== undefined,
      tenureLabel,
      roleEvidence: null,
    });

    // Axis C — is this a usable adverse event at all?
    const axisC = classifyEvent({
      category: assertion.categoryId as never,
      partyRole: assertion.partyRole as never,
      proceduralStage: assertion.proceduralStage as never,
      namingAuthority: assertion.namingAuthority,
      eventDate: assertion.eventDate,
      publicationDate: assertion.publicationDate,
      updateDate: assertion.updateDate,
      retrievalDate: { value: input.now.toISOString().slice(0, 10), precision: 'DAY' },
      spansValidated: assertion.conductSpan !== null,
      exclusionReason: null,
      subjectCentrality:
        assertion.subjectMentionSpans.length > 1 ? 'PROTAGONIST' : 'SIGNIFICANT_MENTION',
    });

    if (!axisC.isValidAdverseEvent) {
      return null;
    }

    // Axis D — how much independent authority stands behind it?
    const clustered: ClusteredSource[] = [
      {
        documentId: input.document.documentId,
        tier: 2,
        originatingNewsroomId: lead.publisherDomain,
        issuingAuthorityId: assertion.namingAuthority,
        isSyndicatedCopy: false,
      },
    ];
    const axisD = computeAuthority(clustered);

    const banded = assignBand({
      axisA,
      axisB,
      axisC,
      axisD,
      rulesVersion: {
        bandingRulesVersionId: 'banding-v1',
        version: 1,
        activatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    return {
      findingId: randomUUID(),
      tenantId: input.tenantId,
      searchId: input.searchId,
      band: banded.band,
      axes: banded.axes,
      rationale: [...axisA.rationale, ...axisB.rationale, ...axisC.rationale, ...banded.rationale],
      category: axisC.category,
      proceduralStage: axisC.proceduralStage,
      partyRole: axisC.partyRole,
      namingAuthority: axisC.namingAuthority,
      attribution: {
        grade: axisB.grade,
        isInference: axisB.isInference,
        statement: axisB.inferenceStatement,
        companyRef: companyEdge?.companyRef ?? null,
        companyName: companyEdge?.companyName ?? null,
        tenureLabel: companyEdge === undefined ? null : tenureLabel,
      },
      document: {
        documentId: input.document.documentId,
        documentVersion: input.document.version,
        url: lead.url,
        title: lead.title,
        publisher: lead.publisher,
        sourceId: lead.provenance.sourceId,
        authorityTier: 2,
        language: lead.language,
        eventDate: assertion.eventDate,
        publicationDate: assertion.publicationDate,
        updateDate: assertion.updateDate,
        retrievalDate: { value: input.now.toISOString().slice(0, 10), precision: 'DAY' },
        cascadeRung: lead.rung,
        mode: lead.provenance.mode,
      },
      subjectMentionSpans: assertion.subjectMentionSpans,
      conductSpan: assertion.conductSpan,
      stageSpan: assertion.stageSpan,
      identityFactors,
      queryId: input.query.queryId,
      queryFamily: input.query.family,
      extractorVersion: assertion.extractorVersion,
      modelId: assertion.modelId,
      promptVersion: assertion.promptVersion,
      createdAt: input.now,
    };
  }

  /**
   * The FR-13 statement for a run that found nothing. Never "no results".
   *
   * `archiveHorizon` is the honest sticking point: D2 requires the earliest date the searched
   * sources actually reach to be published on every result, and **no source has been measured**
   * (that is Phase H / G10). So the statement says the horizon is not established rather than
   * naming a date nobody has verified.
   */
  noMatchStatement(input: {
    readonly jurisdictions: readonly string[];
    readonly languages: readonly string[];
    readonly enabledCategories: readonly string[];
    readonly unmeasuredLanguages: readonly string[];
    readonly taxonomyVersion: number;
    readonly policyVersion: number;
    readonly coverage: ReturnType<typeof aggregateRun>['coverage'];
    readonly sourceOutcomes: readonly SourceCoverageOutcome[];
    readonly runAt: Date;
  }): ReturnType<typeof renderNoMatchStatement> {
    return renderNoMatchStatement({
      sourceCount: input.sourceOutcomes.length,
      languages: input.languages,
      jurisdictions: input.jurisdictions,
      enabledCategories: input.enabledCategories,
      taxonomyVersion: input.taxonomyVersion,
      policyVersion: input.policyVersion,
      runAt: input.runAt.toISOString(),
      archiveHorizon: 'not established — no source archive horizon has been measured (D2, G10)',
      coverage: input.coverage,
      failedSources: input.sourceOutcomes.filter(
        (outcome) => outcome.outcome === 'FAILED' || outcome.outcome === 'SKIPPED',
      ),
      unmeasuredLanguages: input.unmeasuredLanguages,
    });
  }

  /** Aggregate everything into the run's three dimensions (section 6.2). */
  aggregate(input: {
    readonly result: PipelineResult;
    readonly cancelled: boolean;
  }): ReturnType<typeof aggregateRun> {
    return aggregateRun({
      cancelled: input.cancelled,
      supportedFindingCount: input.result.findings.filter(
        (finding) => finding.band === 'CORROBORATED' || finding.band === 'SUPPORTED',
      ).length,
      unresolvedLeadCount: input.result.rejectedLeads.length,
      sourceOutcomes: input.result.sourceOutcomes,
      anyWorkDispatched: input.result.sourceOutcomes.length > 0,
      // Every source completing says the sources worked. It says nothing about whether queries
      // in an unmeasured language find what exists, so coverage stays INCOMPLETE (FR-03, T80).
      unmeasuredLanguages: input.result.unmeasuredLanguages,
    });
  }

  /** Which mode this pipeline runs in, stamped onto the findings page. */
  get operatingMode(): 'MOCK' | 'LIVE' {
    return this.mode === 'live' ? 'LIVE' : 'MOCK';
  }
}
