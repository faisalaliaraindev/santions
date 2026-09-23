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
 * # Source health is checked at the point of use, not at plan time (D5, T36)
 *
 * Before each discovery query and before each fetch, the pipeline asks `SourceHealthService`
 * whether that source may be used **right now**. Asking once, at plan time, would mean a source
 * suspended for a rights violation kept being fetched for the length of every in-flight run —
 * minutes or hours during which an operator believes they have stopped it. Asking at the point
 * of use is what makes the kill switch effective mid-run.
 *
 * Every refusal becomes a `SourceCoverageOutcome` naming what stopped it. None of them is a
 * silent skip: a run that quietly consulted one fewer source reads to a reviewer as a clean
 * result from a search that was never made.
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
  assignClusters,
  fingerprintText,
  resolveIdentityEvidence,
  boundPlan,
  buildQueryPlan,
  classifyEvent,
  computeAuthority,
  gradeAttribution,
  gradeIdentity,
  labelTenure,
  normaliseName,
  renderNoMatchStatement,
  resolveEffectiveScope,
  unmeasuredLanguages,
  unreviewedLexiconNote,
  type AnchorCompany,
  type AssignableCandidate,
  type AuthorityTier,
  type AxisAResult,
  type AxisBResult,
  type AxisCResult,
  type ClusterCandidate,
  type ClusteredSource,
  type DocumentIdentityEvidence,
  type IdentityDate,
  type IdentityName,
  type SubjectIdentityEvidence,
  type PlannedQuery,
  type PreciseDate,
  type SourceCoverageOutcome,
  type TenureLabel,
  assessRelevance,
  cascadeCoverageOutcomes,
  mergeSourceCoverageOutcomes,
  type EvidenceBand,
  type RungAttempt,
  type TaxonomyVersion,
} from '@erly/adverse-domain';

import { AssociationGraphService } from '../associations/association-graph.service.js';
import {
  mapSpanToOriginal,
  normaliseDocument,
  NORMALISER_VERSION,
  type NormalisedDocument,
} from './normalise-document.js';
import { CascadeService } from './cascade.service.js';
import { LadderBuilder } from './ladder.builder.js';
import { TaxonomyService } from '../admin/taxonomy.service.js';
import {
  FindingsService,
  type FindingRecord,
  type RejectedLeadRecord,
} from './findings.service.js';
import {
  FetchGateService,
  isSourceLevelRefusal,
  type FetchGateDecision,
} from '../sources/fetch-gate.service.js';
import type { Lead } from '../sources/lead.js';
import { hasData } from '../sources/source-adapter.js';
import { SourceHealthService } from '../sources/source-health.service.js';
import { IndexedSourceSearchService } from '../sources/indexed/indexed-source-search.service.js';
import type { SourceAdapterSet } from '../sources/sources.registry.js';
import {
  type DiscoveryRequestLog,
  type DiscoveryRequestSummary,
} from '../sources/discovery-request-log.js';
import type {
  SearxngDiscoverySummary,
  SearxngEngineLog,
} from '../sources/searxng/engine-health.js';
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
  /**
   * What the live discovery connectors actually put on the wire (**D-060**).
   *
   * Null when this process holds no request log — a mock run, or a live one built without one.
   * Null and an empty list are different statements and are kept different: null is "this run
   * cannot tell you", empty is "no live connector made an attempt".
   */
  readonly liveDiscovery: DiscoveryRequestSummary | null;
  /**
   * What the rung-5 metasearch layer's upstream engines did (§15).
   *
   * Null when this run has nothing to say about engines — a mock run, a process holding no
   * engine log, or a run whose ladder never reached the connector. Null and an empty engine list
   * are different statements and are kept different, exactly as `liveDiscovery` keeps them: null
   * is "this run cannot tell you", and a summary with `enginesRequested: []` is "governance
   * permitted no engine, so none was asked".
   */
  readonly searxngDiscovery: SearxngDiscoverySummary | null;
}

/** A lead paired with the query that found it, so provenance survives deduplication. */
interface SourcedLead {
  readonly lead: Lead;
  readonly query: PlannedQuery;
}

/**
 * What `band` returns: the finding, plus everything the run-level clustering pass needs to
 * re-band it without re-deriving it.
 *
 * Axis D is the only axis that cannot be settled from one document — independence is a property
 * of the set of documents a run found about one event. So the first pass computes A, B and C
 * once and carries them here, and `clusterFindings` supplies the real Axis D and re-runs
 * `assignBand`. Recomputing A, B and C in the second pass would mean two places deciding the
 * same thing, which is the shape of defect this whole session exists to remove.
 */
interface BandedFinding {
  readonly finding: FindingRecord;
  readonly axisA: AxisAResult;
  readonly axisB: AxisBResult;
  readonly axisC: AxisCResult;
  readonly candidate: AssignableCandidate;
  readonly tier: AuthorityTier;
}

/**
 * `identityAttributes` kinds the extractor may use for a date of birth.
 *
 * Matched case-insensitively and permissively, because the port deliberately types `kind` as a
 * free string: D7 is open and the model that eventually fills this is not chosen yet. An
 * unrecognised kind is ignored rather than guessed at — a value this service cannot classify is
 * not evidence it may use.
 */
const DOCUMENT_DOB_KINDS = ['DATE_OF_BIRTH', 'DOB', 'BIRTH_DATE', 'BIRTH_YEAR', 'YEAR_OF_BIRTH'];
const DOCUMENT_COUNTRY_KINDS = ['COUNTRY', 'NATIONALITY', 'CITIZENSHIP'];
const DOCUMENT_COMPANY_KINDS = ['COMPANY', 'EMPLOYER', 'ORGANISATION', 'ORGANIZATION'];
const DOCUMENT_IDENTIFIER_KINDS = [
  'PASSPORT',
  'PASSPORT_NUMBER',
  'NATIONAL_ID',
  'GOVERNMENT_ID',
  'TAX_ID',
];

/**
 * The registry's `authorityTier` as the closed `AuthorityTier` union.
 *
 * The registry stores it as a plain number, so a value outside 1–5 is representable. It is
 * clamped to 5 — lead-only, the weakest thing a document can be — rather than to a default that
 * would let a misconfigured source support a finding. An out-of-range tier is a configuration
 * fault, and a configuration fault must not be resolved in the source's favour.
 */
function clampTier(tier: number): AuthorityTier {
  return tier === 1 || tier === 2 || tier === 3 || tier === 4 ? tier : 5;
}

function attributeKindMatches(kind: string, accepted: readonly string[]): boolean {
  const folded = kind
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/gu, '_');
  return accepted.includes(folded);
}

function identityAttributeValues(
  attributes: readonly { readonly kind: string; readonly value: string }[],
  accepted: readonly string[],
): readonly string[] {
  return attributes
    .filter((attribute) => attributeKindMatches(attribute.kind, accepted))
    .map((attribute) => attribute.value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Dates of birth the document **states**, with the precision it stated them at.
 *
 * A bare four-digit year is YEAR precision, a full ISO date is DAY. Anything else is dropped:
 * a value this service cannot parse is not turned into a date, because a misparsed date is
 * worse than a missing one — it can manufacture a contradiction and discard a real person.
 */
function identityAttributeDates(
  attributes: readonly { readonly kind: string; readonly value: string }[],
): readonly IdentityDate[] {
  const dates: IdentityDate[] = [];
  for (const value of identityAttributeValues(attributes, DOCUMENT_DOB_KINDS)) {
    if (/^\d{4}$/u.test(value)) {
      dates.push({ value: `${value}-01-01`, precision: 'YEAR' });
    } else if (/^\d{4}-\d{2}$/u.test(value)) {
      dates.push({ value: `${value}-01`, precision: 'MONTH' });
    } else if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      dates.push({ value, precision: 'DAY' });
    }
  }
  return dates;
}

function identityAttributeIdentifiers(
  attributes: readonly { readonly kind: string; readonly value: string }[],
): readonly { readonly type: string; readonly value: string }[] {
  return attributes
    .filter((attribute) => attributeKindMatches(attribute.kind, DOCUMENT_IDENTIFIER_KINDS))
    .map((attribute) => ({ type: attribute.kind, value: attribute.value.trim() }))
    .filter((identifier) => identifier.value.length > 0);
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
    private readonly sourceHealth: SourceHealthService,
    /**
     * The only thing that may construct a `FetchAuthorisation` (Phase E step 2).
     *
     * This pipeline used to build one inline, asserting that five FR-06 gates had passed without
     * running any of them. Every field is now derived, and a refusal is a recorded reason rather
     * than a fetch that proceeds on a false record.
     */
    private readonly fetchGate: FetchGateService,
    private readonly mode: 'mock' | 'live',
    /**
     * The FR-05 ladder: what is on it, and walking it (Phase E step 3, **D-045**).
     *
     * Two objects rather than one because they answer different questions and change for
     * different reasons. `LadderBuilder` reads the registry, so the ladder follows approvals
     * without a deployment. `CascadeService` walks whatever it is handed, so the walk is
     * testable against a ladder of stubs with no database at all.
     */
    private readonly ladder: LadderBuilder,
    private readonly cascade: CascadeService,
    /**
     * What the live discovery connectors put on the wire, for this run.
     *
     * Null in a process that has none, and the null is not padded into an empty summary: a run
     * that cannot say what it requested must say *that*, rather than report zero requests and
     * let a reader conclude the sources were cheap.
     */
    private readonly requestLog: DiscoveryRequestLog | null = null,
    /** Shared publisher snapshots queried locally once per subject, never once per plan query. */
    private readonly indexedSources: IndexedSourceSearchService | null = null,
    /**
     * Per-engine diagnostics for the rung-5 metasearch layer.
     *
     * Separate from `requestLog` rather than folded into it because they answer different
     * questions at different grains: the request log says what the instance cost, this says what
     * the engines did. One number per source cannot express "Google was suspended on CAPTCHA
     * while Bing and DuckDuckGo answered", which is the exact shape the failure-isolation claim
     * rests on.
     */
    private readonly engineLog: SearxngEngineLog | null = null,
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
    /** Local-diagnostic engines granted to this run. Empty or absent on every normal run. */
    readonly diagnosticEngines?: readonly string[] | undefined;
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

    const indexed =
      this.indexedSources === null
        ? {
            findings: [] as readonly FindingRecord[],
            sourceOutcomes: [] as readonly SourceCoverageOutcome[],
          }
        : await this.indexedSources.search({
            tenantId: input.tenantId,
            searchId: input.searchId,
            subject,
            now: input.now,
          });
    sourceOutcomes.push(...indexed.sourceOutcomes);

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

    // D6 / D-010. An unreviewed term list does not fail — it returns nothing — so a category
    // searched with one may report no findings because the query was wrong rather than because
    // nothing exists. The run says so rather than letting a reviewer assume otherwise.
    for (const language of input.languages) {
      const note = unreviewedLexiconNote(taxonomy.lexicon, language);
      if (note !== null) {
        warnings.push(note);
      }
    }

    // The D6 effective scope, resolved per jurisdiction. `buildQueryPlan` resolves the same
    // enablement itself; this is here for what the *coverage statement* needs — which enabled
    // categories have no term to search with, and which requested languages the taxonomy does
    // not declare at all. Both are silent narrowings if nobody reports them.
    for (const jurisdiction of input.jurisdictions) {
      const scope = resolveEffectiveScope({
        taxonomy,
        country: jurisdiction,
        requestedLanguages: input.languages,
      });
      if (scope.undeclaredLanguages.length > 0) {
        warnings.push(
          `The taxonomy declares no terms in ${scope.undeclaredLanguages.join(', ')}, so ` +
            `category queries were not built in ${scope.undeclaredLanguages.length === 1 ? 'it' : 'them'} for ${jurisdiction}.`,
        );
      }
      if (scope.categoriesWithoutTerms.length > 0) {
        warnings.push(
          `${String(scope.categoriesWithoutTerms.length)} enabled categor` +
            `${scope.categoriesWithoutTerms.length === 1 ? 'y has' : 'ies have'} no lexicon term ` +
            `in the searched languages for ${jurisdiction} (${scope.categoriesWithoutTerms.join(', ')}). ` +
            `They were searched only by the name-anchored query families, so an empty result for ` +
            `them is weaker evidence than for a category with terms.`,
        );
      }
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
    const { leads, rungReached, discoveryOutcomes } = await this.discover(bounded.kept, {
      ...input,
      // The loaded, pinned taxonomy rather than the version number the caller passed: a live
      // connector authorises against the taxonomy object, not against an integer.
      taxonomy,
    });
    sourceOutcomes.push(...discoveryOutcomes);

    if (!(await input.heartbeat())) {
      return this.abandoned(warnings, sourceOutcomes, unmeasured);
    }

    // ---- 4-6. Fetch, extract, band ---------------------------------------------------------
    const {
      findings: assessedFindings,
      rejected,
      accessOutcomes,
      warnings: assessWarnings,
    } = await this.assess({
      sourced: leads,
      subject,
      graph,
      taxonomy,
      policy,
      jurisdictions: input.jurisdictions,
      languages: input.languages,
      searchId: input.searchId,
      tenantId: input.tenantId,
      now: input.now,
    });
    sourceOutcomes.push(...accessOutcomes);
    // How the documents were read, and anything that limits what can be concluded from them:
    // a missing extractor, an undeclared encoding, a rule-based extraction (D-048).
    warnings.push(...assessWarnings);

    // Leads that never reached the publisher: filtered out before a socket opened, or refused at
    // the fetch gate. Everything else was fetched, so this is the complement rather than a second
    // counter that could disagree with the rejection records.
    const unfetchedLeadUrls = new Set(
      rejected
        .filter((lead) => lead.stage === 'RELEVANCE' || lead.stage === 'FETCH')
        .map((lead) => lead.url),
    );

    // ---- 7. Cluster (FR-10) ----------------------------------------------------------------
    // Indexed and discovered findings are clustered together, then Axis D is recomputed per
    // cluster and the discovery findings re-banded against it. Until this call existed, every
    // document was its own independent corroboration.
    const clustered = this.clusterFindings({
      indexed: indexed.findings,
      discovered: assessedFindings,
    });
    warnings.push(...clustered.warnings);

    return {
      findings: clustered.findings,
      rejectedLeads: rejected,
      sourceOutcomes,
      plannedQueries: bounded.kept.length,
      droppedQueries: bounded.dropped.length,
      cascadeRungReached: rungReached,
      warnings,
      unmeasuredLanguages: unmeasured,
      liveDiscovery: this.readRequestLog(input.searchId),
      // Read **after** the pipeline totals are attached, so the diagnostic reports what the run
      // actually did with the candidates rather than only what discovery produced. The connector
      // cannot supply either number: it makes leads and stops, and whether a lead became a
      // fetched article or a finding is decided several stages later.
      searxngDiscovery: this.readEngineLog(input.searchId, {
        // Documents that reached the fetch stage and produced evidence, counted from the leads
        // this metasearch layer contributed rather than from the run's total: an SEC feed's
        // documents are not this source's articles.
        articlesFetched: leads.filter(
          (sourced) =>
            sourced.lead.discovery !== undefined && !unfetchedLeadUrls.has(sourced.lead.url),
        ).length,
        findingsGenerated: clustered.findings.filter(
          (finding) => finding.document.discoverySource !== undefined,
        ).length,
      }),
    };
  }

  /**
   * Read this run's engine diagnostics and drop them.
   *
   * Read once, at the end, and forgotten immediately — the same lifecycle as the request log,
   * and for the same reason: the log is process-global, and a run that read its summary and left
   * the entries behind would be the leak the bounds in `SearxngEngineLog` exist to catch rather
   * than to rely on.
   */
  private readEngineLog(
    searchId: string,
    totals: { readonly articlesFetched: number; readonly findingsGenerated: number },
  ): SearxngDiscoverySummary | null {
    if (this.engineLog === null) {
      return null;
    }
    this.engineLog.recordPipelineTotals({ jobId: searchId, ...totals });
    const summary = this.engineLog.summaryFor(searchId);
    this.engineLog.forget(searchId);
    return summary;
  }

  /**
   * Read this run's request counts and drop them.
   *
   * Read **once**, at the end, and forgotten immediately: the log is a process-global map, and a
   * run that read its summary and left the entries behind would be the leak the bounds in
   * `DiscoveryRequestLog` exist to catch rather than to rely on.
   */
  private readRequestLog(searchId: string): DiscoveryRequestSummary | null {
    if (this.requestLog === null) {
      return null;
    }
    const summary = this.requestLog.summaryFor(searchId);
    this.requestLog.forget(searchId);
    return summary;
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
      // An abandoned run is not told what it cost. The entries are dropped by the next run's
      // eviction rather than reported against a result that wrote nothing.
      liveDiscovery: null,
      // An abandoned run is not told what it cost. Entries are dropped by the next run's eviction
      // rather than reported against a result that wrote nothing.
      searxngDiscovery: null,
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
    input: {
      readonly tenantId: string;
      readonly now: Date;
      readonly searchId: string;
      readonly subjectId: string;
      readonly jurisdictions: readonly string[];
      readonly languages: readonly string[];
      readonly taxonomy: TaxonomyVersion;
      readonly diagnosticEngines?: readonly string[] | undefined;
    },
  ): Promise<{
    leads: readonly SourcedLead[];
    rungReached: number | null;
    discoveryOutcomes: readonly SourceCoverageOutcome[];
  }> {
    // A ladder that cannot be built is a configuration or registry fault, and it must not take
    // the run's other stages down with it: `execute` has already recorded the association graph's
    // outcome by this point, and a throw here would discard it along with everything the run
    // could still say. Recorded as a skip with the reason, which is what every other
    // "we could not look" is recorded as.
    let ladder: Awaited<ReturnType<LadderBuilder['build']>>;
    try {
      ladder = await this.ladder.build();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`The discovery ladder could not be built: ${detail}`);
      return {
        leads: [],
        rungReached: null,
        discoveryOutcomes: [
          {
            sourceId: 'discovery',
            sourceName: 'Discovery cascade',
            cascadeRung: 0,
            outcome: 'SKIPPED',
            detail:
              `The FR-05 discovery ladder could not be assembled, so no source was asked: ` +
              `${detail} This is a fault in this service, not an answer from any publisher, and ` +
              `it is not evidence that nothing exists.`,
            queriesAffected: queries.length,
            truncation: null,
            failureClass: null,
          },
        ],
      };
    }

    if (ladder.length === 0) {
      // Nothing is approved at any rung. Reported once, plainly, rather than as eight identical
      // gaps — and never as an empty result, because nothing was searched.
      return {
        leads: [],
        rungReached: null,
        discoveryOutcomes: [
          {
            sourceId: 'discovery',
            sourceName: 'Discovery cascade',
            cascadeRung: 0,
            outcome: 'SKIPPED',
            detail:
              'No approved source sits on the FR-05 discovery ladder in this process, so no ' +
              'discovery was attempted. This is not evidence that nothing exists.',
            queriesAffected: queries.length,
            truncation: null,
          },
        ],
      };
    }

    const byUrl = new Map<string, SourcedLead>();
    const attempts: RungAttempt[] = [];
    let rungReached: number | null = null;

    for (const [index, query] of queries.entries()) {
      const walk = await this.cascade.walk({
        ladder,
        query: {
          tenantId: input.tenantId,
          run: {
            jobId: input.searchId,
            subjectId: input.subjectId,
            jurisdictions: input.jurisdictions,
            languages: input.languages,
            taxonomy: input.taxonomy,
            ...(input.diagnosticEngines === undefined || input.diagnosticEngines.length === 0
              ? {}
              : { diagnosticEngines: input.diagnosticEngines }),
          },
          queryId: query.queryId,
          family: query.family,
          text: query.query,
          language: query.language,
          country: query.jurisdiction,
          window: null,
          limit: 25,
        },
        // What a gap at this point costs: every query not yet run, this one included.
        queriesAffected: queries.length - index,
        now: input.now,
      });

      attempts.push(...walk.attempts);
      if (walk.rungReached !== null) {
        rungReached = Math.max(rungReached ?? 0, walk.rungReached);
      }

      // Deduplicated across every query and every rung, so one story found by three families at
      // two rungs is one lead. Counting it more than once is what would inflate axis D's
      // independence count — the mistake FR-10 clustering exists to prevent, prevented here too.
      for (const lead of walk.leads) {
        if (!byUrl.has(lead.url)) {
          byUrl.set(lead.url, { lead, query });
        }
      }
    }

    // **One outcome per source**, not one per query and not one per distinct kind of thing that
    // happened to it.
    //
    // This used to de-duplicate on `rung:sourceId:outcome`, which kept a source that answered
    // forty queries and was rate-limited on the forty-first as **two** entries — one `COMPLETED`,
    // one `FAILED`. Every consumer then had to decide which of the two described the source, and
    // the two available readings were "it worked" and "it failed", neither of which is true.
    // `mergeSourceCoverageOutcomes` gives the third: `PARTIAL`, carrying the failure's own words
    // and its FR-06 class, counted by `aggregateRun` as a source that answered *and* as a gap.
    //
    // That is what keeps this run's SEC finding and still reports the GDELT rate-limit.
    const discoveryOutcomes = mergeSourceCoverageOutcomes(cascadeCoverageOutcomes(attempts));

    return { leads: [...byUrl.values()], rungReached, discoveryOutcomes };
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
    /** The run's pinned scope. The fetch gate refuses a lead outside what the run asked for. */
    readonly jurisdictions: readonly string[];
    readonly languages: readonly string[];
    readonly searchId: string;
    readonly tenantId: string;
    readonly now: Date;
  }): Promise<{
    findings: BandedFinding[];
    rejected: RejectedLeadRecord[];
    accessOutcomes: SourceCoverageOutcome[];
    /** What a reader of the result has to be told about how these documents were read. */
    warnings: string[];
  }> {
    const fetcher = this.adapters.evidenceFetch;
    const extractor = this.adapters.extractionModel;
    const findings: BandedFinding[] = [];
    const rejected: RejectedLeadRecord[] = [];
    const accessOutcomes: SourceCoverageOutcome[] = [];
    /** Deduplicated: a normalisation problem is reported once per run, not once per document. */
    const warnings = new Set<string>();
    /** One coverage outcome per refused source, not one per lead it cost. */
    const refusedSources = new Set<string>();
    /** The same rule for gate refusals, keyed by source *and* refusal: two gaps, two lines. */
    const gateRefusedSources = new Set<string>();

    // A capability with no adapter is a **configuration fault**, and D-048 is explicit about
    // what that must look like: it belongs in the run's warnings and in the coverage statement
    // as an unsearched capability, and never as a finding count of zero. Before this, a live run
    // with no extractor discovered real leads, passed the gate, committed real evidence and then
    // reported a clean `NO_MATCHES_FOUND` — indistinguishable, to a reader, from "the source had
    // nothing on this person". The same rule the GDELT parser follows (D-046): "could not read
    // it" and "read it and it said nothing" are different facts and never merge.
    if (fetcher === null || extractor === null) {
      const missing = fetcher === null ? 'fetch' : 'extraction';
      const sentence =
        fetcher === null
          ? 'No evidence-fetch adapter is configured in this process, so no document was ' +
            'retrieved and nothing was read. This is a configuration fault, not a result: the ' +
            'leads below were never looked at.'
          : 'No extraction adapter is configured in this process, so no retrieved document was ' +
            'read. This is a configuration fault, not a result: nothing was concluded about ' +
            'this subject from any document, and an empty finding list here means the service ' +
            'was misconfigured rather than that the sources were silent.';

      warnings.add(sentence);
      for (const { lead, query } of input.sourced) {
        rejected.push({
          ...this.leadRecord(lead, query, input),
          // The stage names where it actually stopped. Saying FETCH when the fetcher exists and
          // the extractor does not would describe work the service did not do.
          stage: fetcher === null ? 'FETCH' : 'EXTRACTION',
          reason: sentence,
        });
      }
      accessOutcomes.push({
        // Not a registry source: the gap is a capability this process does not hold. Named as
        // such so a coverage reader is not sent looking for a publisher that is working fine.
        sourceId: `capability:${missing}`,
        sourceName: `${missing === 'fetch' ? 'Evidence fetch' : 'Extraction'} (capability)`,
        cascadeRung: 0,
        // SKIPPED: nothing was asked of any publisher. It makes coverage INCOMPLETE, which is
        // the honest reading of a run that could not read a single document.
        outcome: 'SKIPPED',
        detail: sentence,
        queriesAffected: input.sourced.length,
        truncation: null,
      });
      return { findings, rejected, accessOutcomes, warnings: [...warnings] };
    }

    // D-048's third decision: "rule-based" must not become permanent by default. A reader of a
    // result cannot see the adapter, so every run it took part in says what read the documents
    // and that its recall has never been measured. FR-03's rule by analogy: no figure exists, so
    // no figure is quoted.
    if (extractor.modelId === null) {
      warnings.add(
        `Extraction was rule-based (${extractor.descriptor.adapterId}): a keyword-and-span ` +
          `extractor, with no model involved — every assertion it produced carries a null model ` +
          `id. Its recall has never been measured against a labelled corpus, so no figure for ` +
          `what it finds can be quoted, and a category it has no term for returns nothing ` +
          `rather than failing (D-048, D7 open).`,
      );
    }

    const enabledCategoryIds = input.taxonomy.categories.map((category) => category.category);
    const nameForms = [input.subject.fullName, ...input.subject.aliases.map((alias) => alias.name)];

    // The pinned taxonomy's terms, in the run's languages. Read once: the relevance filter asks
    // whether an adverse term sits near the name, and rebuilding the list per lead would be the
    // same work a few hundred times.
    const taxonomyTerms = input.taxonomy.lexicon
      .filter((term) => input.languages.includes(term.language))
      .map((term) => term.term);

    /** Titles already accepted per domain, for the near-duplicate signal. */
    const acceptedTitles = new Map<string, string[]>();
    /** Canonical URLs already fetched in this run, for the aggregator-copy signal. */
    const fetchedOrigins = new Set<string>();

    for (const { lead, query } of input.sourced) {
      // D5 / T36, the second point of use. A lead discovered ten seconds ago from a source that
      // has since been suspended is **not** fetched, and the run says so rather than dropping
      // the lead silently.
      const leadSourceId = lead.provenance.sourceId;
      const access = await this.sourceHealth.checkAccess({
        sourceId: leadSourceId,
        now: input.now,
        queriesAffected: 1,
        // Asks whether this lead may be attempted at all; does not spend. The fetch adapter
        // makes one, two or three actual requests behind this call — robots.txt, the document,
        // a redirect hop — and spends once for each, because the budget counts requests put on
        // the wire. Spending here as well would drain it at a rate unrelated to the traffic the
        // publisher sees, and spending here *instead* would charge for requests that a robots
        // refusal means we never make.
        spend: false,
      });
      if (!access.decision.allowed) {
        if (!refusedSources.has(leadSourceId) && access.coverageOutcome !== null) {
          refusedSources.add(leadSourceId);
          accessOutcomes.push(access.coverageOutcome);
        }
        rejected.push({
          ...this.leadRecord(lead, query, input),
          stage: 'FETCH',
          reason: `The document was not retrieved. ${access.decision.detail}`,
        });
        continue;
      }

      // FR-06 relevance, **before** the gate and therefore before any socket opens. A candidate
      // refused here cost the publisher nothing, which is the whole point of filtering before
      // fetching rather than after (D-047).
      //
      // It never decides adversity: a candidate that names the subject and no adverse term at
      // all is still fetched. What it refuses is categorical — outside the window, the subject
      // mentioned nowhere, not an article, a copy of something already fetched.
      const relevance = assessRelevance({
        title: lead.title,
        snippet: lead.snippet,
        url: lead.url,
        subjectNameForms: nameForms,
        // What would separate this subject from a namesake: a birth year, a known company. Taken
        // from the subject record, never inferred — a guessed disambiguator would make a
        // namesake's article look like a confirmed match.
        disambiguators: [
          ...(input.subject.dateOfBirth?.value === undefined ||
          input.subject.dateOfBirth.value === null
            ? []
            : [input.subject.dateOfBirth.value.slice(0, 4)]),
          ...input.subject.knownCompanies
            .map((company) => company.name ?? '')
            .filter((n) => n !== ''),
        ],
        adverseTerms: taxonomyTerms,
        publisherTier: null,
        publishedOn: lead.publishedAt.value,
        window: null,
        acceptedTitlesFromDomain: acceptedTitles.get(lead.publisherDomain) ?? [],
        originAlreadyFetched: fetchedOrigins.has(lead.url),
      });
      if (relevance.decision === 'REJECT') {
        rejected.push({
          ...this.leadRecord(lead, query, input),
          // Not `FETCH`. Nothing was fetched, and telling a reviewer otherwise would describe
          // work the service did not do.
          stage: 'RELEVANCE',
          reason: relevance.detail,
        });
        continue;
      }

      // The FR-06 gate (Phase E step 2). Every field of the authorisation is derived here, by
      // the one component permitted to issue one. A refusal is recorded with its reason and,
      // when it is a property of the source rather than of this URL, as a coverage gap too —
      // because a source excluded in full is something a reviewer reading a narrow result has
      // to be told.
      const gate = await this.fetchGate.authorise({
        sourceId: leadSourceId,
        // The document is authorised against the publisher about to be contacted, not against
        // the source that named it. For a source that publishes its own pages the two resolve
        // to the same record; for a discovery service they are deliberately different, and that
        // difference is what stops one approval on our SearXNG record authorising the open web.
        publisherDomain: lead.publisherDomain,
        url: lead.url,
        jurisdiction: query.jurisdiction,
        language: lead.language,
        runJurisdictions: input.jurisdictions,
        runLanguages: input.languages,
        taxonomy: input.taxonomy,
        subjectNameForms: nameForms,
        leadTitle: lead.title,
        leadSnippet: lead.snippet,
        now: input.now,
      });
      // Recorded before the fetch so the next lead's near-duplicate and aggregator-copy signals
      // have something to compare against. A candidate that passed relevance and the gate is a
      // candidate this run has committed to, whatever the fetch then returns.
      acceptedTitles.set(lead.publisherDomain, [
        ...(acceptedTitles.get(lead.publisherDomain) ?? []),
        lead.title,
      ]);
      fetchedOrigins.add(lead.url);

      if (!gate.authorised) {
        this.recordGateRefusal({
          gate,
          lead,
          query,
          input,
          rejected,
          accessOutcomes,
          refusedSources: gateRefusedSources,
        });
        continue;
      }

      const fetched = await fetcher.fetch({
        url: lead.url,
        attribution: {
          tenantId: input.tenantId,
          jobId: input.searchId,
          subjectId: input.subject.subjectId,
          queryId: query.queryId,
          sourceId: lead.provenance.sourceId,
          egressIdentityId: gate.egressIdentity.identityId,
        },
        authorisation: gate.authorisation,
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

      if (fetched.status === 'FAILED') {
        await this.sourceHealth.recordFailure({
          sourceId: leadSourceId,
          signal: fetched.signal,
          now: input.now,
        });
      } else {
        await this.sourceHealth.recordSuccess({ sourceId: leadSourceId, now: input.now });
      }

      if (!hasData(fetched) || fetched.data.body === null) {
        rejected.push({
          ...this.leadRecord(lead, query, input),
          fetchAttempted: true,
          stage: 'FETCH',
          reason:
            fetched.status === 'FAILED'
              ? // The class alone read as "could not be retrieved (HARD_BLOCK)", which tells a
                // reviewer that something went wrong and nothing about what. The adapter knows
                // the sentence; `SourceOutcome.FAILED` now carries it here.
                `The document could not be retrieved (${fetched.policy.failureClass}): ` +
                fetched.detail
              : 'The document was not modified or returned no body.',
        });
        continue;
      }

      // F1 (phase-f.md §3.2). This used to be `new TextDecoder().decode(body)`, which had two
      // defects in one line: it handed **raw HTML** to something documented to receive normalised
      // text — so every span pointed into markup — and it ignored the declared charset, so a
      // Spanish page served as ISO-8859-1 decoded to mojibake and simply stopped matching the
      // subject's name. Spans now point into text a reader would recognise, the encoding comes
      // from what the publisher declared, and the offset map back to the original is held here,
      // which is exactly what `ExtractionInput.text` says the caller does with it.
      const normalised = normaliseDocument({
        body: fetched.data.body,
        contentType: fetched.data.contentType,
      });
      const text = normalised.text;
      for (const warning of normalised.warnings) {
        warnings.add(warning);
      }

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

      if (!normalised.normalisable || text.length === 0) {
        // Retrieved, stored, and unreadable by this service. Recorded as that, never as a
        // document that asserted nothing — the distinction is the whole of D-046 and D-048.
        rejected.push({
          ...this.leadRecord(lead, query, input),
          fetchAttempted: true,
          stage: 'EXTRACTION',
          reason:
            normalised.warnings[0] ??
            'The document was retrieved and stored, and no text could be recovered from it. ' +
              'It was not read.',
        });
        continue;
      }

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
          fetchAttempted: true,
          stage: 'EXTRACTION',
          reason:
            // "The extractor failed on this document" and "the extractor read it and it said
            // nothing about this person" are different facts about the run, and merging them is
            // how an unreadable document becomes a clean negative (D-046, D-048).
            extracted.status === 'FAILED'
              ? `The document was retrieved and stored, and extraction failed on it: ` +
                `${extracted.detail} Nothing was concluded from it.`
              : 'The document was retrieved and read, and it did not assert categorised adverse ' +
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
          normalised,
          // The real tier of the source version the gate authorised this fetch against. `gate`
          // is narrowed to the authorised variant here, so `sourceVersion` is non-null.
          authorityTier: clampTier(gate.sourceVersion.authorityTier),
          subject: input.subject,
          graph: input.graph,
          searchId: input.searchId,
          tenantId: input.tenantId,
          now: input.now,
        });
        if (finding === null) {
          rejected.push({
            ...this.leadRecord(lead, query, input),
            fetchAttempted: true,
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

    return { findings, rejected, accessOutcomes, warnings: [...warnings] };
  }

  /**
   * FR-10, in the runtime path at last.
   *
   * # What was wrong
   *
   * `decideClustering` and `computeAuthority` were both implemented and both correct. Nothing
   * called the first, and the second was called once per finding with a hardcoded one-element
   * array. So every document in a run was its own independent corroboration: ten sites carrying
   * one wire story were ten findings and an independence count of ten, which is exactly the
   * inflation invariant I6 forbids.
   *
   * # What this does
   *
   * One pass over every finding the run produced — indexed-source records **and** discovery
   * documents together, because a syndicated copy of an SEC press release is only recognisable
   * as a copy if the press release is in the same comparison.
   *
   *  - Copies (identical document, identical canonical URL, or matching text fingerprint) are
   *    **removed from the result** and reported as folded-in provenance. They do not appear
   *    twice and they do not raise independence.
   *  - Genuinely independent authority records — an SEC action, a DOJ prosecution, an FCA
   *    warning, an OFAC designation — are **never** removed, even when they describe one event.
   *    They cluster together and each contributes its own authority, which is what lets a
   *    subject named by four regulators band higher than one named by one.
   *  - Axis D is then recomputed per cluster, and discovery findings are re-banded against it.
   *
   * # Why indexed findings are re-counted but not re-banded
   *
   * `IndexedSourceSearchService` bands its own findings by a deliberately narrow rule that does
   * not consult Axis D at all, and caps at SUPPORTED. Re-running `assignBand` over them here
   * would mean this method deciding something that service already decided, from axis results it
   * never produced. So their `independenceCount` is corrected — that figure was a hardcoded `1`
   * and is now the real count — and their band is left to the service that owns it. The
   * correction is stated in the rationale rather than applied silently.
   */
  private clusterFindings(input: {
    readonly indexed: readonly FindingRecord[];
    readonly discovered: readonly BandedFinding[];
  }): { readonly findings: readonly FindingRecord[]; readonly warnings: readonly string[] } {
    const candidates: AssignableCandidate[] = [];
    const bandedByDocument = new Map<string, BandedFinding>();
    const indexedByDocument = new Map<string, FindingRecord>();

    // Indexed records first. The order is load-bearing: `assignClusters` recognises a copy
    // against the first member of a cluster, and an authority record is the right thing for a
    // press copy to be recognised against.
    for (const finding of input.indexed) {
      indexedByDocument.set(finding.document.documentId, finding);
      candidates.push({
        documentId: finding.document.documentId,
        subjectId: `${finding.tenantId}:${finding.searchId}`,
        companyId: finding.attribution.companyRef,
        category: finding.category as ClusterCandidate['category'],
        proceduralStage: finding.proceduralStage as ClusterCandidate['proceduralStage'],
        eventDate: finding.document.eventDate.value,
        canonicalUrl: finding.document.url,
        // Indexed records carry the publisher's own row identity and a hash of the raw evidence.
        // Two snapshots of one OFAC row are the same record, and that is what should collapse if
        // the same row is somehow returned twice.
        contentHash: finding.document.rawEvidenceHash ?? finding.document.documentId,
        nearDuplicateKey: null,
        originatingNewsroomId: finding.document.publisher,
        // Every indexed source in the registry publishes its own listings and releases. An OFAC
        // designation is not a copy of an SEC release about the same person.
        isIndependentAuthority: true,
        issuingAuthorityId: finding.namingAuthority ?? finding.document.publisher,
        // A structured listing row is not running text; fingerprinting a name and a programme
        // code would collide across unrelated people. No fingerprint, no syndication claim.
        nearDuplicateFingerprint: null,
      });
    }

    for (const banded of input.discovered) {
      bandedByDocument.set(banded.finding.document.documentId, banded);
      candidates.push(banded.candidate);
    }

    const assignment = assignClusters(candidates);
    const warnings: string[] = [];
    const findings: FindingRecord[] = [];
    let suppressed = 0;

    for (const cluster of assignment.clusters) {
      // Axis D over the whole cluster, copies included: `computeAuthority` is what excludes them
      // from the count, and it records why on `excludedFromCount` for the reviewer.
      const sources: ClusteredSource[] = cluster.members.map((member): ClusteredSource => {
        const banded = bandedByDocument.get(member.documentId);
        const indexed = indexedByDocument.get(member.documentId);
        const tier = banded?.tier ?? clampTier(indexed?.document.authorityTier ?? 5);
        return {
          documentId: member.documentId,
          tier,
          originatingNewsroomId:
            banded?.candidate.originatingNewsroomId ??
            indexed?.document.publisher ??
            member.documentId,
          issuingAuthorityId:
            banded?.candidate.issuingAuthorityId ??
            indexed?.namingAuthority ??
            indexed?.document.publisher ??
            null,
          isSyndicatedCopy: member.isSuppressedCopy,
        };
      });
      const axisD = computeAuthority(sources);

      const clusterNote =
        cluster.members.length === 1
          ? null
          : `FR-10 cluster ${cluster.clusterId}: ${String(cluster.members.length)} document(s) ` +
            `about this event. Independent corroboration counted: ` +
            `${String(axisD.independenceCount)} ` +
            `(${String(axisD.distinctTier1Authorities.length)} issuing ` +
            `${axisD.distinctTier1Authorities.length === 1 ? 'authority' : 'authorities'}, ` +
            `${String(axisD.distinctNewsrooms.length)} newsroom(s)). ` +
            `${String(axisD.excludedFromCount.length)} excluded as copies or non-independent ` +
            `tiers.`;

      for (const member of cluster.members) {
        if (member.isSuppressedCopy) {
          suppressed += 1;
          continue;
        }

        const indexed = indexedByDocument.get(member.documentId);
        if (indexed !== undefined) {
          findings.push({
            ...indexed,
            axes: { ...indexed.axes, independenceCount: axisD.independenceCount },
            rationale: [
              ...indexed.rationale,
              ...(clusterNote === null ? [] : [clusterNote]),
              ...(cluster.members.length > 1
                ? [
                    'This band was assigned from the publisher record alone and was not raised ' +
                      'by the corroboration above; the independence count is reported so a ' +
                      'reviewer can see what else the run found about the same event.',
                  ]
                : []),
            ],
          });
          continue;
        }

        const banded = bandedByDocument.get(member.documentId);
        /* c8 ignore next 3 -- every candidate came from one of the two maps */
        if (banded === undefined) {
          continue;
        }

        // Re-band against the real, run-level Axis D. The first pass computed it over this
        // document alone, which is a floor rather than an answer.
        const rebanded = assignBand({
          axisA: banded.axisA,
          axisB: banded.axisB,
          axisC: banded.axisC,
          axisD,
          rulesVersion: {
            bandingRulesVersionId: 'banding-v1',
            version: 1,
            activatedAt: '2026-01-01T00:00:00.000Z',
          },
        });

        findings.push({
          ...banded.finding,
          band: rebanded.band,
          // The tier stays the document's own. `rebanded.axes` reports the cluster's best tier,
          // which is a property of the event; a reviewer looking at this finding needs to know
          // what *this* source is.
          axes: { ...rebanded.axes, authorityTier: banded.tier },
          rationale: [
            ...banded.finding.rationale,
            ...(clusterNote === null ? [] : [clusterNote]),
            ...rebanded.rationale.filter((line) => !banded.finding.rationale.includes(line)),
          ],
        });
      }
    }

    if (suppressed > 0) {
      warnings.push(
        `${String(suppressed)} retrieved document(s) were recognised as copies of material ` +
          `already counted — the same document under another URL, or the same text republished ` +
          `elsewhere — and were folded into the finding they duplicate. They are retained as ` +
          `provenance and do not count as independent corroboration (FR-10, I6).`,
      );
    }

    return { findings, warnings };
  }

  /**
   * Record a fetch-gate refusal: always against the lead, and against coverage when it is the
   * source that was refused.
   *
   * The distinction is `isSourceLevelRefusal`, and it matters to a reviewer. "This URL was not
   * in the run's scope" is one lead going no further. "This source has no approved robots
   * position" means every lead from that source was excluded, which is a gap in what the run
   * covered and belongs in the coverage statement beside the sources that failed. Neither is
   * ever a silent skip (FR-06).
   */
  private recordGateRefusal(args: {
    readonly gate: Extract<FetchGateDecision, { authorised: false }>;
    readonly lead: Lead;
    readonly query: PlannedQuery;
    readonly input: { readonly tenantId: string; readonly searchId: string };
    readonly rejected: RejectedLeadRecord[];
    readonly accessOutcomes: SourceCoverageOutcome[];
    readonly refusedSources: Set<string>;
  }): void {
    const { gate, lead, query, input } = args;
    const sourceId = lead.provenance.sourceId;

    args.rejected.push({
      ...this.leadRecord(lead, query, input),
      stage: 'FETCH',
      reason: `The document was not requested. ${gate.detail}`,
    });

    if (!isSourceLevelRefusal(gate.refusal)) {
      return;
    }
    const key = `${sourceId}:${gate.refusal}`;
    if (args.refusedSources.has(key)) {
      return;
    }
    args.refusedSources.add(key);
    args.accessOutcomes.push({
      sourceId,
      sourceName: gate.sourceVersion?.sourceName ?? sourceId,
      cascadeRung: gate.sourceVersion?.cascadeRung ?? lead.rung,
      // SKIPPED, not FAILED: the source answered nothing because we chose not to ask it. Calling
      // it a failure would report an outage at a publisher that is working perfectly well.
      outcome: 'SKIPPED',
      detail: gate.detail,
      queriesAffected: 1,
      truncation: null,
    });
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
      publisherDomain: lead.publisherDomain,
      cascadeRung: lead.rung,
      queryId: query.queryId,
      // The default is the honest one: nothing has been asked for yet. The four sites that
      // reject a candidate *after* a request went out override it.
      fetchAttempted: false,
      discoveredByEngines: lead.discovery?.discoveryEngines ?? [],
    };
  }

  /**
   * The four axes, then the band.
   *
   * Returns null when axis C says the event cannot support an adverse finding at all — an
   * exclusion matched, or the spans did not validate. That is a rejection with a reason, not a
   * finding with a low band.
   *
   * Axis D is computed here over **this document alone** and then recomputed for real once the
   * run has clustered (`clusterFindings`). A single document cannot know how many independent
   * reports of its event the run found; that is a property of the run, not of the document.
   * What is computed here is the floor, and `bandedFinding` carries the axis results forward so
   * the second pass does not have to re-derive them.
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
      readonly identityAttributes: readonly {
        readonly kind: string;
        readonly value: string;
      }[];
      readonly extractorVersion: string;
      readonly modelId: string | null;
      readonly promptVersion: string | null;
    };
    readonly lead: Lead;
    readonly query: PlannedQuery;
    readonly document: { readonly documentId: string; readonly version: number };
    readonly text: string;
    /** The normalisation that produced `text`, so the finding can record how it was read. */
    readonly normalised: NormalisedDocument;
    /**
     * The authority tier of the **active approved version of this lead's source**, read from the
     * registry by the fetch gate that authorised the request.
     *
     * Passed in rather than hardcoded. It was `2` in this file for every document from every
     * source, which meant a tier-1 court document and a tier-5 forum post banded identically and
     * `canSupportFinding: false` for tier 5 — the rule that stops a blog post becoming a finding
     * — could never fire on this path.
     */
    readonly authorityTier: AuthorityTier;
    readonly subject: Awaited<ReturnType<SubjectsService['findVersion']>>;
    readonly graph: Awaited<ReturnType<AssociationGraphService['loadForSearch']>>;
    readonly searchId: string;
    readonly tenantId: string;
    readonly now: Date;
  }): BandedFinding | null {
    const { assertion, lead, subject } = input;

    // ---- Axis A — is the person in this document the subject? ----------------------------
    //
    // What stood here until 2026-09-21:
    //
    //     matchNameForms(normaliseName(subject.fullName),
    //                    normaliseName(spans.length > 0 ? subject.fullName : ''))
    //
    // The subject's name compared to **itself**, so any document with a mention span matched
    // EXACT regardless of what it said; followed by one hardcoded MODERATE
    // `RARE_FULL_NAME_PLUS_CITY` factor asserting a city check that never ran on either side.
    // One moderate corroborating identifier is enough for Axis A `PARTIAL`, and `PARTIAL` is
    // enough for `SUPPORTED` — so a document that merely contained the subject's name became a
    // supported adverse finding, with a rationale describing evidence nobody had looked at.
    //
    // Now: the document's own text at the extractor's mention offsets is the document side, the
    // subject record is the subject side, and the shared FR-08 resolver — the same one the
    // indexed-source path uses — decides what was actually comparable.
    const documentNames = assertion.subjectMentionSpans
      .map((span): IdentityName | null => {
        const text = input.text.slice(span.start, span.end);
        return text.trim().length === 0 ? null : { text, role: 'PRIMARY', span };
      })
      .filter((name): name is IdentityName => name !== null);

    const subjectEvidence: SubjectIdentityEvidence = {
      names: [
        { text: subject.fullName, role: 'PRIMARY' },
        ...subject.aliases.map((alias): IdentityName => ({
          text: alias.name,
          role: 'ALIAS',
          origin: alias.origin,
        })),
      ],
      datesOfBirth: subject.dateOfBirth === null ? [] : [subject.dateOfBirth],
      countries: subject.countryContext,
      // Companies from both the intake record and the resolved FR-02 graph. A graph edge is the
      // stronger of the two, and the resolver treats a co-occurrence as MODERATE either way.
      companyNames: [
        ...subject.knownCompanies.map((company) => company.name ?? ''),
        ...input.graph.edges.map((edge) => edge.companyName),
      ].filter((name) => name.length > 0),
      identifiers: [],
    };

    const documentEvidence: DocumentIdentityEvidence = {
      names: documentNames,
      // Everything below comes from `identityAttributes` — what the extractor says the text
      // *states*, with no inference. The rule-based extractor returns none today, so on that
      // adapter these are empty and no factor beyond the name can be asserted. That is the
      // correct outcome and it is why a discovery finding lands AMBIGUOUS: there is genuinely
      // nothing else in the document that this service has read.
      datesOfBirth: identityAttributeDates(assertion.identityAttributes),
      countries: identityAttributeValues(assertion.identityAttributes, DOCUMENT_COUNTRY_KINDS),
      companyNames: [
        ...identityAttributeValues(assertion.identityAttributes, DOCUMENT_COMPANY_KINDS),
        // A company from the association graph named in this document's text is evidence the
        // service did inspect: the string is present in the text it read.
        ...input.graph.edges
          .filter((edge) => input.text.includes(edge.companyName))
          .map((edge) => edge.companyName),
      ],
      identifiers: identityAttributeIdentifiers(assertion.identityAttributes),
      // FR-09: the document says the person it names is a different person of the same name.
      distinguishesNamesake: assertion.partyRole === 'NAMESAKE_DISTINGUISHED',
      fieldSpan: assertion.subjectMentionSpans[0] ?? null,
    };

    const resolved = resolveIdentityEvidence(subjectEvidence, documentEvidence);
    const identityFactors = resolved.factors;

    const axisA = gradeIdentity({
      nameMatch: resolved.match.form,
      factors: identityFactors,
      frequencyPrior: subject.nameFrequencyPrior,
      documentDistinguishesNamesake: documentEvidence.distinguishesNamesake,
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

    // ---- Axis D — how much independent authority stands behind it? -------------------------
    //
    // A provisional computation over this document alone, using the **real** tier of its source
    // version. `clusterFindings` recomputes it across the run once every document is in, which
    // is the only level at which "two independent reports" can be established. Tier 5 is already
    // decisive here, though: `assignBand` rule 4 makes a tier-5 document LEAD_ONLY whatever else
    // is true, and with the tier hardcoded to 2 that rule could never fire.
    const clustered: ClusteredSource[] = [
      {
        documentId: input.document.documentId,
        tier: input.authorityTier,
        originatingNewsroomId: lead.publisherDomain,
        issuingAuthorityId: input.authorityTier === 1 ? assertion.namingAuthority : null,
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

    const finding: FindingRecord = {
      findingId: randomUUID(),
      tenantId: input.tenantId,
      searchId: input.searchId,
      band: banded.band,
      axes: banded.axes,
      // The resolver's lines come first and describe **inspected evidence only**: every
      // sentence in `resolved.rationale` corresponds to a comparison that ran. The axis
      // rationales that follow explain what was concluded from them.
      rationale: [
        ...resolved.rationale,
        ...axisA.rationale,
        ...axisB.rationale,
        ...axisC.rationale,
        ...banded.rationale,
      ],
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
        authorityTier: input.authorityTier,
        language: lead.language,
        eventDate: assertion.eventDate,
        publicationDate: assertion.publicationDate,
        updateDate: assertion.updateDate,
        retrievalDate: { value: input.now.toISOString().slice(0, 10), precision: 'DAY' },
        cascadeRung: lead.rung,
        mode: lead.provenance.mode,
        // Present only for a lead a metasearch layer found. Absent, not null, for everything
        // else: `exactOptionalPropertyTypes` keeps "this document has no discovery channel"
        // distinguishable from "it has one and we lost it".
        ...(lead.discovery === undefined
          ? {}
          : {
              discoverySource: lead.discovery.discoverySource,
              discoveryEngines: lead.discovery.discoveryEngines,
            }),
      },
      subjectMentionSpans: assertion.subjectMentionSpans,
      conductSpan: assertion.conductSpan,
      stageSpan: assertion.stageSpan,
      textNormalisation: {
        normaliserVersion: NORMALISER_VERSION,
        charset: input.normalised.charset.label,
        charsetSource: input.normalised.charset.source,
        markupRemoved: input.normalised.markupRemoved,
      },
      originalSpans: {
        subjectMentions: assertion.subjectMentionSpans
          .map((span) => mapSpanToOriginal(input.normalised, span))
          .filter((span): span is { start: number; end: number } => span !== null),
        conduct:
          assertion.conductSpan === null
            ? null
            : mapSpanToOriginal(input.normalised, assertion.conductSpan),
        stage:
          assertion.stageSpan === null
            ? null
            : mapSpanToOriginal(input.normalised, assertion.stageSpan),
      },
      identityFactors,
      queryId: input.query.queryId,
      queryFamily: input.query.family,
      extractorVersion: assertion.extractorVersion,
      modelId: assertion.modelId,
      promptVersion: assertion.promptVersion,
      createdAt: input.now,
    };

    return {
      finding,
      axisA,
      axisB,
      axisC,
      candidate: {
        documentId: input.document.documentId,
        subjectId: subject.subjectId,
        companyId: companyEdge?.companyRef ?? null,
        category: axisC.category,
        proceduralStage: axisC.proceduralStage,
        eventDate: assertion.eventDate.value,
        canonicalUrl: lead.url,
        // The content hash the evidence store computed is not returned by `stageAndCommit`, so
        // the document id stands in: it is already one-per-stored-document, which makes an exact
        // re-fetch of the same URL in one run collapse and nothing else. Near-duplicate detection
        // is what catches copies across publishers, and it is the provider layer's job.
        contentHash: input.document.documentId,
        // `Lead` carries no exact bucket key and no discovery adapter assigns one. Syndication
        // is detected from the document text instead, by `nearDuplicateFingerprint` below.
        nearDuplicateKey: null,
        originatingNewsroomId: lead.publisherDomain,
        // Tier 1 is "published by the body that issued it". Such a document is never folded away
        // as a copy of somebody else's account of the same action.
        isIndependentAuthority: input.authorityTier === 1,
        issuingAuthorityId: input.authorityTier === 1 ? assertion.namingAuthority : null,
        // Computed from the text this run actually read, and null when the document was too
        // short to fingerprint honestly (`MIN_SHINGLES`). A null never merges anything.
        nearDuplicateFingerprint: fingerprintText(input.text),
      },
      tier: input.authorityTier,
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
    readonly unreviewedTermLanguages?: readonly string[] | undefined;
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
      unreviewedTermLanguages: input.unreviewedTermLanguages ?? [],
    });
  }

  /** Aggregate everything into the run's three dimensions (section 6.2). */
  aggregate(input: {
    readonly result: PipelineResult;
    readonly cancelled: boolean;
  }): ReturnType<typeof aggregateRun> {
    return aggregateRun({
      cancelled: input.cancelled,
      // Counted by band, and **every band is counted**. Passing only the top two is what let a
      // run holding an `AMBIGUOUS` finding report `NO_MATCHES_FOUND`: the finding was written,
      // stored and served from `/findings` the whole time, and the summary said there was
      // nothing. A band says how well the evidence supports a connection; it never says whether
      // a finding exists.
      supportedFindingCount: countBands(input.result.findings, ['CORROBORATED', 'SUPPORTED']),
      ambiguousFindingCount: countBands(input.result.findings, ['AMBIGUOUS', 'COMPANY_CONTEXT']),
      otherFindingCount: countBands(input.result.findings, ['CONTRADICTED', 'LEAD_ONLY']),
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

/**
 * Count the findings whose band is one of these.
 *
 * A named helper rather than three inline filters, so that adding a band to `EVIDENCE_BANDS`
 * and forgetting to count it anywhere is a visible omission at one call site instead of an
 * invisible one spread across three. Every band must appear in exactly one of the three groups
 * `aggregate` passes: a finding that is returned and counted nowhere is a finding the summary
 * does not know about, which is the defect this whole path was rebuilt to remove.
 */
function countBands(findings: readonly FindingRecord[], bands: readonly EvidenceBand[]): number {
  return findings.filter((finding) => bands.includes(finding.band)).length;
}
