import type { ClientSession } from 'mongodb';

import type { DesignationCategory, FindingCategory } from '@erly/adverse-domain';

export const SCHEDULED_ARTIFACT_TRANSPORT = 'SCHEDULED_ARTIFACT_TRANSPORT';

export type IndexedRecordType = 'PERSON' | 'ENTITY' | 'VESSEL' | 'AIRCRAFT' | 'OTHER';

export type IndexedRecordKind = 'AUTHORITY_LIST_ENTRY' | 'OFFICIAL_PUBLICATION';

export interface IndexedFindingMetadata {
  readonly category: FindingCategory;
  readonly proceduralStage: string;
  readonly partyRole: string;
  readonly stageEvidence: string | null;
}

export interface IndexedSourceDate {
  readonly value: string | null;
  readonly precision: 'DAY' | 'MONTH' | 'YEAR' | 'RANGE' | 'UNKNOWN';
  readonly endValue?: string | null;
}

export interface IndexedSourceIdentifier {
  readonly type: string;
  readonly value: string;
  readonly issuingCountry: string | null;
}

export interface IndexedSourceAddress {
  readonly lines: readonly string[];
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
}

/**
 * The screening projection shared by every scheduled publisher source.
 *
 * Publisher-specific evidence remains in `rawEvidence`; fields are nullable because normalising
 * a dataset must never turn absence into an invented fact.
 */
export interface NormalizedSourceRecord {
  readonly sourceId: string;
  readonly sourceRecordId: string;
  /** Defaults to AUTHORITY_LIST_ENTRY for parsers written before scheduled publications. */
  readonly recordKind?: IndexedRecordKind;
  /**
   * What kind of listing an `AUTHORITY_LIST_ENTRY` is, from the parser that read it.
   *
   * On the record rather than derived from the source id, because the parser is the only thing
   * that knows what it parsed: the same OFAC parser reads two lists, and the World Bank's list is
   * a debarment rather than a sanctions designation. Deriving it from the id would put that
   * knowledge in a `switch` somewhere downstream, which is the copy that goes stale when an
   * eleventh source arrives. Defaults to `SANCTIONS_DESIGNATION` for the parsers written before
   * the category enum closed.
   */
  readonly listingCategory?: DesignationCategory;
  readonly recordType: IndexedRecordType;
  readonly primaryName: string;
  readonly aliases: readonly string[];
  readonly originalScriptNames: readonly string[];
  readonly datesOfBirth: readonly IndexedSourceDate[];
  readonly placesOfBirth: readonly string[];
  readonly nationalities: readonly string[];
  readonly citizenships: readonly string[];
  readonly countries: readonly string[];
  readonly addresses: readonly IndexedSourceAddress[];
  readonly identifiers: readonly IndexedSourceIdentifier[];
  readonly companyIdentifiers: readonly IndexedSourceIdentifier[];
  readonly listingDate: IndexedSourceDate | null;
  readonly programmes: readonly string[];
  readonly sanctionTypes: readonly string[];
  readonly grounds: string | null;
  readonly status: string | null;
  readonly effectiveDate: IndexedSourceDate | null;
  readonly expiryDate: IndexedSourceDate | null;
  readonly publisherUrl: string;
  readonly sourceDocumentUrl: string;
  /** Feed title/summary text used only for local candidate retrieval. */
  readonly searchableText?: string | null;
  readonly publicationDate?: IndexedSourceDate | null;
  readonly findingMetadata?: IndexedFindingMetadata | null;
  readonly rawEvidence: Readonly<Record<string, unknown>>;
}

export interface ParsedSourceArtifact {
  readonly records: readonly NormalizedSourceRecord[];
  /** Publisher-declared version/date where one exists. Never fabricated from retrieval time. */
  readonly publisherVersion: string | null;
}

export interface IndexedArtifactParser {
  readonly parserId: string;
  readonly parserVersion: string;
  parse(input: {
    readonly sourceId: string;
    readonly artifactUrl: string;
    readonly contentType: string | null;
    readonly body: Uint8Array;
  }): ParsedSourceArtifact;
}

export interface ScheduledArtifactResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly body: Uint8Array | null;
}

/** Transport stays behind a port so tests never contact publishers. */
export interface ScheduledArtifactTransport {
  fetch(input: {
    readonly sourceId: string;
    readonly url: string;
    readonly etag: string | null;
    readonly lastModified: string | null;
  }): Promise<ScheduledArtifactResponse>;
}

export type IndexedRefreshStatus =
  'NEVER_REFRESHED' | 'REFRESHING' | 'SUCCEEDED' | 'NOT_MODIFIED' | 'FAILED';

export interface IndexedSourceRefreshState {
  readonly sourceId: string;
  readonly activeSourceVersion: number | null;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessfulRefreshAt: Date | null;
  readonly refreshStatus: IndexedRefreshStatus;
  readonly httpStatus: number | null;
  readonly artifactHash: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly parserVersion: string | null;
  readonly rowCount: number;
  readonly insertedCount: number;
  readonly updatedCount: number;
  readonly removedCount: number;
  readonly activeSnapshotVersion: string | null;
  readonly failureReason: string | null;
  readonly freshness: 'CURRENT' | 'STALE' | 'UNAVAILABLE';
  readonly nextRefreshDueAt: Date | null;
  readonly refreshLease: {
    readonly refreshId: string;
    readonly expiresAt: Date;
  } | null;
  /**
   * What the last snapshot prune did, so pruning is observable rather than inferred from a
   * shrinking collection. Null until one has run.
   */
  readonly lastPrune?: IndexedSnapshotPruneSummary | null;
}

/**
 * One bounded pass of snapshot pruning.
 *
 * `complete` says whether the pass finished the work or hit its own delete ceiling. A caller that
 * needs "everything superseded is gone" must drain rather than call once — the same rule the
 * retention sweeper, the outbox publisher and the FI-10 reconciler all follow, and for the same
 * reason: an unbounded delete is how one large source starves everything else sharing the process.
 */
export interface IndexedSnapshotPruneSummary {
  readonly sourceId: string;
  readonly ranAt: Date;
  /** The snapshot a search reads. Never pruned, whatever else is. */
  readonly activeSnapshotVersion: string | null;
  /** The one completed snapshot kept behind the active one, for rollback and for diffing. */
  readonly retainedPreviousSnapshotVersion: string | null;
  readonly snapshotsConsidered: number;
  readonly snapshotsDeleted: number;
  readonly recordsDeleted: number;
  /** False when the pass stopped at its delete ceiling with work still outstanding. */
  readonly complete: boolean;
}

export interface StoredIndexedSourceRecord extends NormalizedSourceRecord {
  readonly sourceSnapshotVersion: string;
  readonly sourceVersion: number;
  readonly parserVersion: string;
  readonly retrievedAt: Date;
  readonly artifactHash: string;
  readonly nameKeys: readonly string[];
  /** Optional while pre-migration snapshots remain readable; new commits always populate it. */
  readonly searchTokens?: readonly string[];
  readonly rawEvidenceHash: string;
  readonly createdAt: Date;
}

export interface SnapshotCommitInput {
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly snapshotVersion: string;
  readonly artifactHash: string;
  readonly parserVersion: string;
  readonly publisherVersion: string | null;
  readonly artifactUrl: string;
  readonly retrievedAt: Date;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly refreshIntervalMs: number;
  readonly records: readonly NormalizedSourceRecord[];
}

export interface IndexedSourceTransactionPort {
  run<T>(
    body: (session: ClientSession) => Promise<T>,
    options: { readonly name: string },
  ): Promise<T>;
}
