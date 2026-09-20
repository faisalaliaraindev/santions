/**
 * Findings and rejected leads — what a run produced, durably.
 *
 * # Why rejected leads are stored at all
 *
 * FR-06: "A rejected candidate is stored as a lead with its rejection reason and is visible in
 * the coverage view." A pipeline that silently discards what it decided against is one whose
 * decisions nobody can audit — and the decisions it makes most often are rejections. The count
 * of them is also what separates `NO_MATCHES_FOUND` from `UNRESOLVED` in section 6.2: a run
 * that looked at forty documents and promoted none is a different statement from a run that
 * found nothing to look at.
 *
 * # Immutability and re-runs
 *
 * Findings are keyed by `(tenantId, searchId, findingId)` and written once per run. A rebuild —
 * a redelivered message that got past the fence, or a deliberate re-run — **replaces** the whole
 * set for that search rather than appending. Appending would double every finding on a
 * redelivery, and a reviewer would be looking at the same article twice with no way to tell.
 *
 * The consumer's fence (FI-11/FI-12) is what normally prevents a second run at all; this is the
 * belt to that pair of braces, and it is cheap.
 */

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import type { EvidenceBand, PreciseDate } from '@erly/adverse-domain';

export interface FindingRecord {
  readonly findingId: string;
  readonly tenantId: string;
  readonly searchId: string;
  readonly band: EvidenceBand;
  readonly axes: {
    readonly identity: string;
    readonly attribution: string;
    readonly stage: string;
    readonly partyRole: string;
    readonly authorityTier: number;
    readonly independenceCount: number;
  };
  readonly rationale: readonly string[];
  readonly category: string | null;
  readonly proceduralStage: string;
  readonly partyRole: string;
  readonly namingAuthority: string | null;
  readonly attribution: {
    readonly grade: string;
    readonly isInference: boolean;
    readonly statement: string | null;
    readonly companyRef: string | null;
    readonly companyName: string | null;
    readonly tenureLabel: string | null;
  };
  readonly document: {
    readonly documentId: string;
    readonly documentVersion: number;
    readonly url: string;
    readonly title: string;
    readonly publisher: string;
    readonly sourceId: string;
    readonly authorityTier: number;
    readonly language: string | null;
    readonly eventDate: PreciseDate;
    readonly publicationDate: PreciseDate;
    readonly updateDate: PreciseDate;
    readonly retrievalDate: PreciseDate;
    readonly cascadeRung: number;
    readonly mode: 'MOCK' | 'LIVE';
    /** Structured indexed-source provenance. Absent for fetched documents. */
    readonly sourceRecordId?: string | undefined;
    readonly sourceSnapshotVersion?: string | undefined;
    readonly parserVersion?: string | undefined;
    readonly rawEvidenceHash?: string | undefined;
  };
  /** Offsets into the **normalised** text, which is what `textNormalisation` describes. */
  readonly subjectMentionSpans: readonly { readonly start: number; readonly end: number }[];
  readonly conductSpan: { readonly start: number; readonly end: number } | null;
  readonly stageSpan: { readonly start: number; readonly end: number } | null;
  /**
   * How the text those spans point into was produced from the stored bytes (F1).
   *
   * Recorded rather than the offset map itself, because the normalisation is deterministic: the
   * stored document, this charset and this normaliser version reproduce the same text and the
   * same map. Storing a map per finding would be a second copy of the document in a different
   * shape, and the shape would drift.
   *
   * `charsetSource` is the load-bearing field. `DEFAULTED` means the publisher declared no
   * encoding and UTF-8 was assumed — so a reviewer looking at a finding with an accented name
   * can tell whether the encoding was known or guessed.
   */
  readonly textNormalisation: {
    readonly normaliserVersion: string;
    readonly charset: string;
    readonly charsetSource: string;
    readonly markupRemoved: boolean;
  };
  /**
   * The same spans as offsets in the **decoded original** document.
   *
   * Carried so a surface that shows the stored document itself — rather than the normalised text
   * — can highlight the passage without re-running the normaliser. Null where a span could not
   * be mapped, which is honest: a highlight that is nearly right is worse than none.
   */
  readonly originalSpans: {
    readonly subjectMentions: readonly { readonly start: number; readonly end: number }[];
    readonly conduct: { readonly start: number; readonly end: number } | null;
    readonly stage: { readonly start: number; readonly end: number } | null;
  };
  readonly identityFactors: readonly {
    readonly kind: string;
    readonly strength: string;
    readonly direction: string;
    readonly detail: string;
  }[];
  readonly queryId: string;
  readonly queryFamily: string;
  readonly extractorVersion: string;
  readonly modelId: string | null;
  readonly promptVersion: string | null;
  readonly createdAt: Date;
}

export interface RejectedLeadRecord {
  readonly tenantId: string;
  readonly searchId: string;
  readonly leadId: string;
  readonly url: string;
  readonly title: string;
  readonly publisher: string;
  readonly cascadeRung: number;
  readonly queryId: string;
  /**
   * Where the lead stopped.
   *
   * `RELEVANCE` is **before a socket opened** — FR-06's filter decided the candidate was not
   * worth a request. Separate from `FETCH` on purpose: telling a reviewer a lead was rejected at
   * fetch, when nothing was fetched, describes work the service did not do.
   */
  readonly stage: 'RELEVANCE' | 'FETCH' | 'EXTRACTION' | 'CLASSIFICATION';
  readonly reason: string;
}

@Injectable()
export class FindingsService {
  private readonly findings: Collection<FindingRecord>;
  private readonly leads: Collection<RejectedLeadRecord>;

  constructor(db: Db) {
    this.findings = db.collection<FindingRecord>('findings');
    this.leads = db.collection<RejectedLeadRecord>('rejectedLeads');
  }

  async ensureIndexes(): Promise<void> {
    // Tenant context leads every key (section 6.3).
    await this.findings.createIndex({ tenantId: 1, searchId: 1, findingId: 1 }, { unique: true });
    await this.findings.createIndex({ tenantId: 1, searchId: 1, band: 1 });
    await this.leads.createIndex({ tenantId: 1, searchId: 1, leadId: 1, queryId: 1 });
  }

  /**
   * Replace this search's findings and leads.
   *
   * Takes the caller's session so the findings, the rejected leads and the run's own state
   * commit **together**. A crash between them would leave a run reporting findings it cannot
   * show, or showing findings it does not admit to having.
   */
  async replaceForSearch(
    input: {
      readonly tenantId: string;
      readonly searchId: string;
      readonly findings: readonly FindingRecord[];
      readonly rejectedLeads: readonly RejectedLeadRecord[];
    },
    session: ClientSession,
  ): Promise<void> {
    const scope = { tenantId: input.tenantId, searchId: input.searchId };
    await this.findings.deleteMany(scope, { session });
    await this.leads.deleteMany(scope, { session });

    if (input.findings.length > 0) {
      await this.findings.insertMany([...input.findings], { session });
    }
    if (input.rejectedLeads.length > 0) {
      await this.leads.insertMany([...input.rejectedLeads], { session });
    }
  }

  /** Tenant scoping is in the query, never a check afterwards (SEC-01). */
  async listForSearch(input: {
    readonly tenantId: string;
    readonly searchId: string;
  }): Promise<{ findings: FindingRecord[]; rejectedLeads: RejectedLeadRecord[] }> {
    const scope = { tenantId: input.tenantId, searchId: input.searchId };
    const [findings, rejectedLeads] = await Promise.all([
      // Stable ordering, and deliberately **not** by band: a band is not a risk ranking (I9),
      // and sorting by it would present the list as one. Ordered by when each was produced.
      this.findings.find(scope).sort({ createdAt: 1, findingId: 1 }).toArray(),
      this.leads.find(scope).sort({ leadId: 1, queryId: 1 }).toArray(),
    ]);
    return { findings, rejectedLeads };
  }
}
