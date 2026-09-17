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
  resolveEffectiveScope,
  unmeasuredLanguages,
  unreviewedLexiconNote,
  type AnchorCompany,
  type ClusteredSource,
  type IdentityFactor,
  type PlannedQuery,
  type PreciseDate,
  type SourceCoverageOutcome,
  type TenureLabel,
  assessRelevance,
  cascadeCoverageOutcomes,
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
      findings,
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
    input: {
      readonly tenantId: string;
      readonly now: Date;
      readonly searchId: string;
      readonly subjectId: string;
      readonly jurisdictions: readonly string[];
      readonly languages: readonly string[];
      readonly taxonomy: TaxonomyVersion;
    },
  ): Promise<{
    leads: readonly SourcedLead[];
    rungReached: number | null;
    discoveryOutcomes: readonly SourceCoverageOutcome[];
  }> {
    const ladder = await this.ladder.build();

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

    // One outcome per distinct gap rather than one per query: a rung with no source is one fact
    // about the run, and repeating it per query would bury the coverage statement in duplicates.
    const seen = new Set<string>();
    const discoveryOutcomes = cascadeCoverageOutcomes(attempts).filter((outcome) => {
      const key = `${String(outcome.cascadeRung)}:${outcome.sourceId}:${outcome.outcome}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

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
    findings: FindingRecord[];
    rejected: RejectedLeadRecord[];
    accessOutcomes: SourceCoverageOutcome[];
    /** What a reader of the result has to be told about how these documents were read. */
    warnings: string[];
  }> {
    const fetcher = this.adapters.evidenceFetch;
    const extractor = this.adapters.extractionModel;
    const findings: FindingRecord[] = [];
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

    return { findings, rejected, accessOutcomes, warnings: [...warnings] };
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
    /** The normalisation that produced `text`, so the finding can record how it was read. */
    readonly normalised: NormalisedDocument;
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
