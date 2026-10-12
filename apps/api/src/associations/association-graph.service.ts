/**
 * FR-02 — the association graph, and the snapshot that freezes it.
 *
 * # The three records
 *
 * `graphSnapshots` — one per search, **created inside the search-creation transaction** and
 * never rewritten. `associationAssertions` — the `DIRECTOR_OF` edges, each owned by exactly one
 * snapshot. `companies` — the company as the register described it **at the moment that
 * snapshot was built**, also owned by one snapshot.
 *
 * # Why the company is copied per snapshot instead of shared
 *
 * Because a registry correction next month must not rewrite what a historical search explained.
 * A shared `companies` collection keyed on the company number is the obvious design and it is
 * wrong here: the day a register renames a company or moves it to `dissolved`, every past
 * search silently starts describing it the new way, and a report that was produced in March no
 * longer says what it said in March. Duplication is the price of a record that stays true. The
 * same reasoning is why `pinVersions` pins taxonomy and policy versions onto the run rather
 * than reading the current ones at display time.
 *
 * A refresh therefore produces a **new** snapshot carrying `refreshOfSnapshotId`, linked to the
 * old one. Nothing mutates the old one.
 *
 * # Why the snapshot is created empty and filled in later
 *
 * It is created `PENDING` in the search-creation transaction, so the run is pinned to exactly
 * one snapshot id from the first moment it exists. It is *populated* by `build()`, which the
 * worker calls.
 *
 * Building it inline in `POST /v1/searches` would put registry latency into search acceptance
 * and — much worse — would make a registry outage a search-creation failure. FR-02 is explicit
 * that a registry failure must not stop person searching: "If registry access fails, continue
 * valid person searching and show association coverage as incomplete."
 *
 * There is no job handler yet (Phase C left that to Phase E deliberately), so today `build()`
 * is called directly by tests. That is the same arrangement `JobConsumer` uses: the interesting
 * behaviour is a method that performs no transport call, so it can be asserted without one.
 *
 * # What this service will not do
 *
 * It does not decide identity. `resolveOfficer` does, in the pure package, using the same Axis A
 * grading a document match uses. This service fetches, stores, and obeys.
 */

import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import {
  edgeInScope,
  interpretEmptyResult,
  mayAttachCompanies,
  normaliseName,
  resolveOfficer,
  summariseAssociationCoverage,
  type AssociationCoverage,
  type AssociationScope,
  type BoundApplication,
  type CurrencyState,
  type GraphBounds,
  type IdentityFactor,
  type NameMatchForm,
  type PreciseDate,
  type ResolutionStatus,
  type SourceCoverageOutcome,
  type Tenure,
} from '@adverse-search/domain';

import { CapabilityCoverageService } from '../admin/capability-coverage.service.js';
import { ApiException } from '../common/api-exception.js';
import { AuditService } from '../persistence/audit.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';
import type { CompanyRegistryPort } from '../sources/company-registry.port.js';
import { hasData } from '../sources/source-adapter.js';
import type { SourceAdapterSet } from '../sources/sources.registry.js';
import { SubjectsService } from '../subjects/subjects.service.js';
import { PolicyService } from '../tenancy/policy.service.js';

export type SnapshotStatus = 'PENDING' | 'BUILT';

/**
 * Association coverage as stored on the snapshot.
 *
 * The three-way `outcome` and its mapping into the run live in
 * `packages/domain/src/association/association-coverage.ts` — pure, because deciding what a
 * bounded or failed traversal amounts to is a decision, and this file's job is to record it.
 *
 * `boundsApplied` is a structured list rather than prose. Every bound that bound is a row, so a
 * consumer can count them, filter them or re-render them; `limitations` carries the rendered
 * sentences for a reviewer. The D3 version stored only the sentences, which meant the only way
 * to ask "did the edge cap bind?" was to match on a string.
 */
export interface SnapshotCoverage {
  readonly outcome: AssociationCoverage;
  /** Always populated for INCOMPLETE and UNKNOWN. A gap with no reason is not a statement. */
  readonly detail: string | null;
  readonly sourceId: string | null;
  readonly boundsApplied: readonly BoundApplication[];
  readonly limitations: readonly string[];
  /**
   * What the run's own coverage aggregation consumes (`aggregateRun`). Stored rather than
   * derived on read, so the run and the snapshot cannot come to disagree about what happened.
   */
  readonly sourceOutcome: SourceCoverageOutcome | null;
}

interface GraphSnapshotRecord {
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly searchId: string;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly jurisdictions: readonly string[];
  readonly scope: AssociationScope;
  readonly status: SnapshotStatus;
  readonly coverage: SnapshotCoverage;
  /**
   * The policy version this run pinned, and the bounds resolved from it **at creation**.
   *
   * Copied onto the snapshot rather than re-read at build time, for the same reason companies
   * are copied: a bound raised next month must not change what this search is reported to have
   * covered. The truncation note on an old report has to keep matching the graph beside it.
   */
  readonly policyVersion: number;
  readonly bounds: GraphBounds;
  readonly boundProblems: readonly string[];
  readonly refreshOfSnapshotId: string | null;
  readonly createdAt: Date;
  readonly builtAt: Date | null;
  readonly mode: 'MOCK' | 'LIVE';
}

interface CompanyRecord {
  readonly tenantId: string;
  readonly snapshotId: string;
  readonly companyRef: string;
  readonly jurisdiction: string;
  readonly name: string;
  readonly status: string;
  readonly incorporatedOn: PreciseDate;
  readonly observedAt: string;
  readonly sourceId: string;
}

/**
 * A `DIRECTOR_OF` edge, with everything FR-02 requires stored on it.
 *
 * FR-02 lists: source, jurisdiction, company identifier, appointment dates, resignation dates,
 * date precision, observed date and resolution status. All of it is here, and the precision
 * rides inside each `PreciseDate` rather than in a parallel field that can disagree with it.
 */
interface AssociationAssertionRecord {
  readonly assertionId: string;
  readonly tenantId: string;
  readonly snapshotId: string;
  readonly subjectId: string;
  readonly officerRef: string;
  readonly officerName: string;
  readonly companyRef: string;
  readonly companyName: string;
  readonly jurisdiction: string;
  readonly role: string;
  readonly tenure: Tenure;
  readonly observedAt: string;
  readonly resolution: ResolutionStatus;
  readonly identityGrade: string;
  readonly nameMatch: NameMatchForm;
  readonly identityFactors: readonly IdentityFactor[];
  readonly resolutionRationale: readonly string[];
  readonly currency: CurrencyState;
  readonly inScope: boolean;
  readonly scopeReason: string;
  /** True only when the edge may anchor a company query. Never true for a candidate. */
  readonly attachesCompany: boolean;
  readonly sourceId: string;
  readonly adapterId: string;
  readonly parserVersion: string;
  readonly mode: 'MOCK' | 'LIVE';
}

/** An officer as the register returned it, carried between the two resolution passes. */
interface OfficerCandidateInput {
  readonly officerRef: string;
  readonly name: string;
  readonly jurisdiction: string;
  readonly identifiers: readonly {
    readonly kind: string;
    readonly value: string;
    readonly partial: boolean;
  }[];
  readonly companyRefs: readonly string[];
}

/** An officer the register returned that produced no edges — recorded, not discarded. */
interface UnresolvedCandidateRecord {
  readonly tenantId: string;
  readonly snapshotId: string;
  readonly officerRef: string;
  readonly officerName: string;
  readonly jurisdiction: string;
  readonly resolution: ResolutionStatus;
  readonly identityGrade: string;
  readonly nameMatch: NameMatchForm;
  readonly resolutionRationale: readonly string[];
}

export interface AssociationGraphView {
  readonly snapshotId: string;
  readonly searchId: string;
  readonly status: SnapshotStatus;
  readonly scope: AssociationScope;
  readonly coverage: SnapshotCoverage;
  readonly bounds: GraphBounds;
  readonly policyVersion: number;
  readonly edges: readonly AssociationAssertionRecord[];
  readonly companies: readonly CompanyRecord[];
  readonly unresolvedCandidates: readonly UnresolvedCandidateRecord[];
  readonly refreshOfSnapshotId: string | null;
  readonly builtAt: string | null;
}

@Injectable()
export class AssociationGraphService {
  private readonly logger = new Logger('AssociationGraph');

  private readonly snapshots: Collection<GraphSnapshotRecord>;
  private readonly companies: Collection<CompanyRecord>;
  private readonly assertions: Collection<AssociationAssertionRecord>;
  private readonly candidates: Collection<UnresolvedCandidateRecord>;

  constructor(
    db: Db,
    private readonly subjects: SubjectsService,
    private readonly adapters: SourceAdapterSet,
    private readonly capabilities: CapabilityCoverageService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly policies: PolicyService,
    private readonly mode: 'mock' | 'live',
  ) {
    this.snapshots = db.collection<GraphSnapshotRecord>('graphSnapshots');
    this.companies = db.collection<CompanyRecord>('companies');
    this.assertions = db.collection<AssociationAssertionRecord>('associationAssertions');
    this.candidates = db.collection<UnresolvedCandidateRecord>('unresolvedOfficerCandidates');
  }

  async ensureIndexes(): Promise<void> {
    // Tenant context leads every key (section 6.3).
    await this.snapshots.createIndex({ tenantId: 1, searchId: 1 }, { unique: true });
    await this.snapshots.createIndex({ tenantId: 1, snapshotId: 1 }, { unique: true });
    await this.assertions.createIndex(
      { tenantId: 1, snapshotId: 1, assertionId: 1 },
      { unique: true },
    );
    await this.assertions.createIndex({ tenantId: 1, snapshotId: 1, officerRef: 1 });
    await this.companies.createIndex(
      { tenantId: 1, snapshotId: 1, companyRef: 1 },
      { unique: true },
    );
    await this.candidates.createIndex(
      { tenantId: 1, snapshotId: 1, officerRef: 1 },
      { unique: true },
    );
  }

  /**
   * Which scope this search actually runs under.
   *
   * Default-deny: a tenant whose policy has not approved a historical scope is **refused**, not
   * silently downgraded to current-only. A silent downgrade produces a result that answers a
   * narrower question than the one asked, labelled as though it answered the asked one, and the
   * caller has no way to tell.
   *
   * **The approval reads from the policy version, not from the commercial entitlement.** D3 put
   * it on the entitlement, which was the wrong home and duplicated a field the seeded policy
   * already carried. FR-02 calls it an *approved* historical scope, and the policy version is
   * what carries approvals: it goes through the D1 four-eyes lifecycle, it writes an audit
   * entry, and it is pinned to the run — so a historical search can cite the policy version
   * that permitted it. An entitlement is what a customer bought, which is a different question.
   */
  async resolveScope(input: {
    readonly tenantId: string;
    readonly includeFormerDirectorships: boolean;
  }): Promise<AssociationScope> {
    if (!input.includeFormerDirectorships) {
      return 'CURRENT_ONLY';
    }
    const policy = await this.policies.loadActive(input.tenantId);
    if (!policy.historicalScopeApproved) {
      throw new ApiException(
        'INVALID_SCOPE',
        'A former-director search requires an approved historical scope. The active policy ' +
          'version for this tenant does not approve one (FR-02).',
        {
          details: [
            {
              path: 'requestedScope.includeFormerDirectorships',
              message: 'historicalScopeApproved is not set on the active policy version',
            },
          ],
          internalDetail: `tenant=${input.tenantId} policyVersion=${String(policy.version)}`,
        },
      );
    }
    return 'INCLUDE_FORMER';
  }

  /**
   * Create the empty snapshot, inside the caller's transaction.
   *
   * Takes a session and does not open one: the snapshot and the run that pins it must commit
   * together, or a crash between them leaves a run pointing at a snapshot that does not exist.
   */
  async createPendingSnapshot(input: {
    readonly tenantId: string;
    readonly searchId: string;
    readonly subjectId: string;
    readonly subjectVersion: number;
    readonly jurisdictions: readonly string[];
    readonly scope: AssociationScope;
    /** The version `pinVersions` pinned. The bounds are resolved from exactly this one. */
    readonly policyVersion: number;
    readonly refreshOfSnapshotId?: string | null;
    readonly now: Date;
    readonly session: ClientSession;
  }): Promise<string> {
    // Resolved here, at creation, and copied onto the snapshot. Reading them at build time
    // instead would let a policy change between acceptance and execution silently alter what
    // the run covered — and the run would report the new bounds as though it had used them.
    const policy = await this.policies.loadPinned(input.tenantId, input.policyVersion);

    const snapshotId = randomUUID();
    await this.snapshots.insertOne(
      {
        snapshotId,
        tenantId: input.tenantId,
        searchId: input.searchId,
        subjectId: input.subjectId,
        subjectVersion: input.subjectVersion,
        jurisdictions: input.jurisdictions,
        scope: input.scope,
        status: 'PENDING',
        coverage: {
          // Before anything has been attempted the honest answer is that we have not asked.
          // Not COMPLETE-with-nothing, which would read as "no associations exist".
          outcome: 'UNKNOWN',
          detail: 'The association graph has not been built for this search yet.',
          sourceId: null,
          boundsApplied: [],
          limitations: [],
          sourceOutcome: null,
        },
        policyVersion: input.policyVersion,
        bounds: policy.graphBounds,
        boundProblems: policy.boundProblems,
        refreshOfSnapshotId: input.refreshOfSnapshotId ?? null,
        createdAt: input.now,
        builtAt: null,
        mode: this.mode === 'live' ? 'LIVE' : 'MOCK',
      },
      { session: input.session },
    );
    return snapshotId;
  }

  /**
   * Populate the snapshot.
   *
   * Idempotent: a snapshot already `BUILT` is returned untouched, because a redelivered queue
   * message must not rebuild a frozen graph. A registry failure does **not** throw — it lands
   * in the coverage statement, and the search carries on (FR-02).
   */
  async build(input: {
    readonly tenantId: string;
    readonly searchId: string;
    readonly now: Date;
  }): Promise<AssociationGraphView> {
    const snapshot = await this.snapshots.findOne({
      tenantId: input.tenantId,
      searchId: input.searchId,
    });
    if (snapshot === null) {
      throw new ApiException('NOT_FOUND', 'No association snapshot for that search.', {
        internalDetail: `tenant=${input.tenantId} search=${input.searchId}`,
      });
    }
    if (snapshot.status === 'BUILT') {
      return this.view(snapshot);
    }

    const subject = await this.subjects.findVersion({
      tenantId: input.tenantId,
      subjectId: snapshot.subjectId,
      version: snapshot.subjectVersion,
    });

    const registry = this.adapters.companyRegistry;
    const jurisdiction = this.pickJurisdiction(snapshot.jurisdictions, registry);

    if (registry === null || jurisdiction === null) {
      // Nothing was asked, and the coverage says exactly that. This is the Costa Rica case
      // today (D14): no free automatable officer-level source exists, so there is no adapter
      // to ask. Reporting it as INCOMPLETE would imply an attempt.
      const detail = await this.describeMissingRegistry(snapshot.jurisdictions, input.now);
      return this.commit({
        snapshot,
        now: input.now,
        coverage: this.summarise(snapshot, {
          sourceId: null,
          answered: false,
          failure: null,
          boundsApplied: [],
          notAskedReason: detail,
        }),
        companies: [],
        assertions: [],
        candidates: [],
      });
    }

    const officers = await registry.findOfficers({
      tenantId: input.tenantId,
      jurisdiction,
      name: subject.fullName,
      limit: snapshot.bounds.maxOfficerCandidates,
    });

    if (officers.status === 'FAILED') {
      // Degraded execution. The person search is unaffected; this is a coverage gap with a
      // named source and a named reason.
      this.logger.warn(
        `Registry ${registry.descriptor.adapterId} failed for search ${input.searchId}: ` +
          `${officers.policy.failureClass}. Association coverage is incomplete; the search ` +
          `continues.`,
      );
      return this.commit({
        snapshot,
        now: input.now,
        coverage: this.summarise(snapshot, {
          sourceId: registry.descriptor.sourceId,
          answered: false,
          failure: officers.policy.failureClass,
          boundsApplied: [],
          notAskedReason: null,
        }),
        companies: [],
        assertions: [],
        candidates: [],
      });
    }

    if (officers.status === 'NO_RESULTS') {
      // The register answered "nobody". Whether that may be called a clean result depends on
      // the declared capability, not on the empty array — D-020. Only SUPPORTED earns
      // COMPLETE; anything else means an empty answer is NOT_ESTABLISHED.
      const capability = await this.capabilities.statusOf(
        jurisdiction,
        'OFFICER_ASSOCIATIONS',
        input.now,
      );
      const meaning = interpretEmptyResult(capability.status);
      const summarised = this.summarise(snapshot, {
        sourceId: registry.descriptor.sourceId,
        answered: true,
        failure: null,
        boundsApplied: [],
        notAskedReason: null,
      });
      return this.commit({
        snapshot,
        now: input.now,
        coverage:
          meaning === 'NO_FINDINGS'
            ? summarised
            : {
                // The register answered, so this is not a failure — but the capability is not
                // SUPPORTED here, so the empty answer is not established as absence (D-020).
                // The outcome is overridden to UNKNOWN while the source outcome still records
                // that the register was asked and did reply.
                ...summarised,
                outcome: 'UNKNOWN',
                detail:
                  `The register returned no officers, but officer associations are ` +
                  `${capability.status} in ${jurisdiction}, so an empty result is not ` +
                  `established as "no associations". ${capability.rationale}`,
              },
        companies: [],
        assertions: [],
        candidates: [],
      });
    }

    const boundsApplied: BoundApplication[] = [];
    /** Registry calls that failed mid-traversal. Separate from a bound: nothing was capped. */
    const partialFailures: string[] = [];

    if (officers.status === 'BOUNDED') {
      boundsApplied.push({
        bound: 'MAX_OFFICER_CANDIDATES',
        limit: officers.truncation.limit,
        available: officers.truncation.availableCount,
        appliedTo: subject.fullName,
      });
    }

    const resolutions = this.resolveAll(subject, officers.data, jurisdiction);

    const companies: CompanyRecord[] = [];
    const assertions: AssociationAssertionRecord[] = [];
    const candidates: UnresolvedCandidateRecord[] = [];

    const subjectSuppliedCompanies = subject.knownCompanies.length > 0;

    for (const { candidate, resolution } of resolutions) {
      // **Resolution happens twice, and the ordering is the point.** The officer search does
      // not tell us which companies the register attributes to an officer, so the strongest
      // available signal — "the client told us their customer directs company X, and the
      // register puts a person of that name in company X" — simply is not knowable yet. The
      // first pass therefore decides only whether asking is worth a call; the second, after the
      // appointments are known, is the one stored on the edges.
      //
      // What may be asked about:
      //
      //   - never a contradicted officer. The register says this is someone else, and no
      //     company list changes that;
      //   - a resolved or reviewable officer, because the answer is already actionable;
      //   - **and** any non-contradicted officer when the client supplied known companies,
      //     because that is exactly the case the second pass exists to catch. Without this
      //     clause a subject with a supplied company and a register that publishes no date of
      //     birth would never be resolved at all, which is the common case in a register that
      //     publishes little.
      //
      // Where nothing was supplied, a weak name match still costs no call — so the twelve
      // namesakes of T20 remain twelve candidates and zero hops.
      const worthHopping =
        resolution.status !== 'CONTRADICTED' &&
        (resolution.status === 'RESOLVED' ||
          resolution.status === 'CANDIDATE_FOR_REVIEW' ||
          subjectSuppliedCompanies);

      if (!worthHopping) {
        candidates.push({
          tenantId: input.tenantId,
          snapshotId: snapshot.snapshotId,
          officerRef: candidate.officerRef,
          officerName: candidate.name,
          jurisdiction,
          resolution: resolution.status,
          identityGrade: resolution.grade,
          nameMatch: resolution.nameMatch,
          resolutionRationale: resolution.rationale,
        });
        continue;
      }

      const appointments = await registry.listAppointments({
        tenantId: input.tenantId,
        officerRef: candidate.officerRef,
        jurisdiction,
        limit: snapshot.bounds.maxCompaniesPerOfficer,
      });

      if (appointments.status === 'FAILED') {
        // Not a bound. The register was asked and did not answer for this officer, which is a
        // different limitation from a cap and reads differently to a reviewer.
        partialFailures.push(
          `Appointments for officer ${candidate.officerRef} could not be read ` +
            `(${appointments.policy.failureClass}).`,
        );
        continue;
      }
      if (appointments.status === 'BOUNDED') {
        boundsApplied.push({
          bound: 'MAX_COMPANIES_PER_OFFICER',
          limit: appointments.truncation.limit,
          available: appointments.truncation.availableCount,
          appliedTo: candidate.officerRef,
        });
      }
      if (!hasData(appointments)) {
        // The register holds the officer but attributes no company to them. Recorded as a
        // candidate rather than dropped — "this person exists and directs nothing here" is a
        // different statement from "we did not look".
        candidates.push({
          tenantId: input.tenantId,
          snapshotId: snapshot.snapshotId,
          officerRef: candidate.officerRef,
          officerName: candidate.name,
          jurisdiction,
          resolution: resolution.status,
          identityGrade: resolution.grade,
          nameMatch: resolution.nameMatch,
          resolutionRationale: resolution.rationale,
        });
        continue;
      }

      // The second pass. Now that the officer's companies are known, the known-company
      // corroboration can be evaluated — and it is the signal that most often decides this.
      const finalResolution = this.resolve(subject, {
        ...candidate,
        companyRefs: appointments.data.map((d) => d.companyRef),
      });

      for (const directorship of appointments.data) {
        // The third bound, and the backstop on the other two: a handful of officers each with a
        // few hundred directorships passes both per-call caps and still produces a graph nobody
        // can review. Recorded once — the first time it binds — rather than once per discarded
        // edge, which would bury the coverage statement in identical lines.
        if (assertions.length >= snapshot.bounds.maxEdgesPerSnapshot) {
          if (!boundsApplied.some((b) => b.bound === 'MAX_EDGES_PER_SNAPSHOT')) {
            boundsApplied.push({
              bound: 'MAX_EDGES_PER_SNAPSHOT',
              limit: snapshot.bounds.maxEdgesPerSnapshot,
              available: null,
              appliedTo: `officer ${candidate.officerRef}`,
            });
          }
          break;
        }

        const scope = edgeInScope(directorship.tenure, snapshot.scope, {
          value: input.now.toISOString().slice(0, 10),
          precision: 'DAY',
        });

        assertions.push({
          assertionId: randomUUID(),
          tenantId: input.tenantId,
          snapshotId: snapshot.snapshotId,
          subjectId: snapshot.subjectId,
          officerRef: candidate.officerRef,
          officerName: candidate.name,
          companyRef: directorship.companyRef,
          companyName: directorship.companyName,
          jurisdiction: directorship.jurisdiction,
          role: directorship.role,
          tenure: directorship.tenure,
          observedAt: directorship.observedAt,
          resolution: finalResolution.status,
          identityGrade: finalResolution.grade,
          nameMatch: finalResolution.nameMatch,
          identityFactors: finalResolution.factors,
          resolutionRationale: finalResolution.rationale,
          currency: scope.currency,
          inScope: scope.included,
          scopeReason: scope.reason,
          // The T14 property, stored rather than recomputed at display time: only a resolved
          // officer's company may be attached and anchored on.
          attachesCompany: mayAttachCompanies(finalResolution.status) && scope.included,
          sourceId: registry.descriptor.sourceId,
          adapterId: appointments.provenance.adapterId,
          parserVersion: appointments.provenance.parserVersion,
          mode: appointments.provenance.mode,
        });

        if (!companies.some((c) => c.companyRef === directorship.companyRef)) {
          const company = await registry.getCompany(directorship.companyRef, jurisdiction);
          companies.push(
            hasData(company)
              ? {
                  tenantId: input.tenantId,
                  snapshotId: snapshot.snapshotId,
                  companyRef: company.data.companyRef,
                  jurisdiction: company.data.jurisdiction,
                  name: company.data.name,
                  status: company.data.status,
                  incorporatedOn: company.data.incorporatedOn,
                  observedAt: company.provenance.retrievedAt,
                  sourceId: registry.descriptor.sourceId,
                }
              : {
                  // The register named the company on the appointment but would not describe
                  // it. Recorded with what is known and an UNKNOWN status, rather than
                  // dropped: an edge pointing at a company with no record is worse than a
                  // company record that says it could not be read.
                  tenantId: input.tenantId,
                  snapshotId: snapshot.snapshotId,
                  companyRef: directorship.companyRef,
                  jurisdiction: directorship.jurisdiction,
                  name: directorship.companyName,
                  status: 'UNKNOWN',
                  incorporatedOn: { value: null, precision: 'UNKNOWN' },
                  observedAt: company.provenance.retrievedAt,
                  sourceId: registry.descriptor.sourceId,
                },
          );
        }
      }
    }

    const coverage = this.summarise(snapshot, {
      sourceId: registry.descriptor.sourceId,
      answered: true,
      failure: null,
      boundsApplied,
      extraLimitations: partialFailures,
      notAskedReason: null,
    });

    return this.commit({ snapshot, now: input.now, coverage, companies, assertions, candidates });
  }

  /**
   * Turn what happened into the snapshot's coverage.
   *
   * The decision itself is pure (`summariseAssociationCoverage`); this adds the two things it
   * cannot know — the bound problems the policy carried, and any per-officer failure that is a
   * limitation without being a bound.
   */
  private summarise(
    snapshot: GraphSnapshotRecord,
    input: {
      readonly sourceId: string | null;
      readonly answered: boolean;
      readonly failure: string | null;
      readonly boundsApplied: readonly BoundApplication[];
      readonly extraLimitations?: readonly string[];
      readonly notAskedReason: string | null;
    },
  ): SnapshotCoverage {
    const summary = summariseAssociationCoverage({
      sourceId: input.sourceId,
      sourceName: 'Company register (FR-02 association graph)',
      jurisdiction: snapshot.jurisdictions[0] ?? 'unspecified',
      answered: input.answered,
      failure: input.failure,
      boundsApplied: input.boundsApplied,
      policyProblems: [...snapshot.boundProblems, ...(input.extraLimitations ?? [])],
      notAskedReason: input.notAskedReason,
    });

    return {
      outcome: summary.outcome,
      detail: summary.detail,
      sourceId: input.sourceId,
      boundsApplied: input.boundsApplied,
      limitations: summary.limitations,
      sourceOutcome: summary.sourceOutcome,
    };
  }

  /** Resolve every candidate. Pure work, separated so the loop above stays about I/O. */
  private resolveAll(
    subject: Awaited<ReturnType<SubjectsService['findVersion']>>,
    officers: readonly {
      readonly officerRef: string;
      readonly name: string;
      readonly jurisdiction: string;
      readonly identifiers: readonly {
        readonly kind: string;
        readonly value: string;
        readonly partial: boolean;
      }[];
      readonly appointmentCount: number | null;
    }[],
    jurisdiction: string,
  ): readonly {
    candidate: OfficerCandidateInput;
    resolution: ReturnType<typeof resolveOfficer>;
  }[] {
    return officers.map((officer) => {
      const candidate: OfficerCandidateInput = {
        officerRef: officer.officerRef,
        name: officer.name,
        jurisdiction,
        identifiers: officer.identifiers,
        // Empty, and honestly so. The officer search does not tell us which companies the
        // register attributes to this officer, so at this point we genuinely do not know. The
        // second pass, after the hop, is where that becomes knowable.
        companyRefs: [],
      };
      return { candidate, resolution: this.resolve(subject, candidate) };
    });
  }

  /**
   * One resolution, against the subject record.
   *
   * Separated so both passes go through the same mapping. Two call sites building the
   * `ResolutionSubject` independently is how the second one ends up omitting the alias list.
   */
  private resolve(
    subject: Awaited<ReturnType<SubjectsService['findVersion']>>,
    candidate: OfficerCandidateInput,
  ): ReturnType<typeof resolveOfficer> {
    return resolveOfficer(
      {
        name: normaliseName(subject.fullName),
        aliases: subject.aliases.map((a) => normaliseName(a.name)),
        dateOfBirth: subject.dateOfBirth,
        countryContext: subject.countryContext,
        knownCompanyRefs: subject.knownCompanies.map((c) => c.registrationNumber),
        frequencyPrior: subject.nameFrequencyPrior,
      },
      {
        officerRef: candidate.officerRef,
        name: normaliseName(candidate.name),
        jurisdiction: candidate.jurisdiction,
        identifiers: candidate.identifiers,
        companyRefs: candidate.companyRefs,
      },
    );
  }

  /**
   * One transaction: every edge, every company, and the snapshot's flip to `BUILT`.
   *
   * A half-written graph with a `BUILT` snapshot would be reported as a complete association
   * picture, so the flip is the last thing in the same commit as the rows it describes.
   */
  private async commit(input: {
    readonly snapshot: GraphSnapshotRecord;
    readonly now: Date;
    readonly coverage: SnapshotCoverage;
    readonly companies: readonly CompanyRecord[];
    readonly assertions: readonly AssociationAssertionRecord[];
    readonly candidates: readonly UnresolvedCandidateRecord[];
  }): Promise<AssociationGraphView> {
    const updated = await this.transactions.run(
      async (session) => {
        if (input.companies.length > 0) {
          await this.companies.insertMany([...input.companies], { session });
        }
        if (input.assertions.length > 0) {
          await this.assertions.insertMany([...input.assertions], { session });
        }
        if (input.candidates.length > 0) {
          await this.candidates.insertMany([...input.candidates], { session });
        }

        const result = await this.snapshots.findOneAndUpdate(
          {
            tenantId: input.snapshot.tenantId,
            snapshotId: input.snapshot.snapshotId,
            // Only a PENDING snapshot may be filled in. A concurrent build that lost the race
            // writes nothing rather than doubling the edges.
            status: 'PENDING',
          },
          {
            $set: { status: 'BUILT', coverage: input.coverage, builtAt: input.now },
          },
          { returnDocument: 'after', session },
        );

        if (result === null) {
          throw new ApiException(
            'REVISION_CONFLICT',
            'This association snapshot was built by another worker.',
            { internalDetail: `snapshot=${input.snapshot.snapshotId}` },
          );
        }

        await this.audit.append(
          {
            tenantId: input.snapshot.tenantId,
            // SYSTEM, not a user: nobody asked for this individually — it is the run doing
            // what the run was accepted to do.
            actor: { type: 'SYSTEM', subject: 'association-graph', clientId: null },
            action: 'association:snapshot:build',
            target: { type: 'GraphSnapshot', id: input.snapshot.snapshotId, version: null },
            result: 'ALLOWED',
            reason: `coverage=${input.coverage.outcome}`,
            correlationId: null,
            now: input.now,
          },
          session,
        );

        return result;
      },
      { name: 'associations.build' },
    );

    return this.view(updated);
  }

  /** The frozen graph, as the route serves it. */
  async loadForSearch(input: {
    readonly tenantId: string;
    readonly searchId: string;
  }): Promise<AssociationGraphView> {
    const snapshot = await this.snapshots.findOne({
      tenantId: input.tenantId,
      searchId: input.searchId,
    });
    if (snapshot === null) {
      // Deliberately non-enumerating: an unauthorised read and a missing record look alike
      // (section 3.1).
      throw new ApiException('NOT_FOUND', 'No association snapshot for that search.');
    }
    return this.view(snapshot);
  }

  private async view(snapshot: GraphSnapshotRecord): Promise<AssociationGraphView> {
    const filter = { tenantId: snapshot.tenantId, snapshotId: snapshot.snapshotId };
    const [edges, companies, candidates] = await Promise.all([
      this.assertions.find(filter).sort({ companyRef: 1, officerRef: 1 }).toArray(),
      this.companies.find(filter).sort({ companyRef: 1 }).toArray(),
      this.candidates.find(filter).sort({ officerRef: 1 }).toArray(),
    ]);

    return {
      snapshotId: snapshot.snapshotId,
      searchId: snapshot.searchId,
      status: snapshot.status,
      scope: snapshot.scope,
      coverage: snapshot.coverage,
      bounds: snapshot.bounds,
      policyVersion: snapshot.policyVersion,
      edges,
      companies,
      unresolvedCandidates: candidates,
      refreshOfSnapshotId: snapshot.refreshOfSnapshotId,
      builtAt: snapshot.builtAt?.toISOString() ?? null,
    };
  }

  /** The first requested jurisdiction the configured registry actually covers. */
  private pickJurisdiction(
    jurisdictions: readonly string[],
    registry: CompanyRegistryPort | null,
  ): string | null {
    if (registry === null) {
      return null;
    }
    return jurisdictions.find((j) => registry.descriptor.jurisdictions.includes(j)) ?? null;
  }

  /** Why no register was asked, in words a reviewer can use. */
  private async describeMissingRegistry(
    jurisdictions: readonly string[],
    now: Date,
  ): Promise<string> {
    const first = jurisdictions[0];
    if (first === undefined) {
      return 'The search declared no jurisdiction, so no company register could be selected.';
    }
    const capability = await this.capabilities.statusOf(first, 'OFFICER_ASSOCIATIONS', now);
    return (
      `No approved company register covers ${first}, so none was asked. Officer associations ` +
      `are ${capability.status} there. ${capability.rationale}`
    );
  }
}

/** Re-exported so a caller can type the shape without importing the whole service. */
export type {
  AssociationAssertionRecord,
  CompanyRecord,
  GraphSnapshotRecord,
  UnresolvedCandidateRecord,
};
