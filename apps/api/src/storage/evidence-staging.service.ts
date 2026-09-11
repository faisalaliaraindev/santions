/**
 * C5 — stage the object, verify it, commit the reference. In that order, always.
 *
 * This is failure-matrix row **FI-03**, and the rule it enforces is the one the whole phase is
 * built around: *never return a successful evidence reference to a missing object.* A screening
 * product that tells a reviewer evidence exists when it does not is worse than one that reports
 * an error, because an error gets investigated and a dangling reference gets believed.
 *
 * **The order is not a convention, it is the design.** Staging first means the worst case is an
 * orphaned object — a few kilobytes nobody references, swept up six hours later, invisible to
 * every user. Committing first means the worst case is a reference to nothing, which surfaces as
 * a broken evidence link in front of a compliance officer during a review. The two failure modes
 * cost wildly different amounts, and the cheap one is the one we choose to have.
 *
 * **Verification means the store's numbers, not ours.** After the write, the object is read back
 * with `head()` and the store's own SHA-256 and byte count are compared against what we intended
 * to store. Trusting the checksum we computed ourselves would verify our arithmetic, which was
 * never in doubt; the risk is a truncated or corrupted transfer, and only the far end can see
 * that. A mismatch deletes the object and throws — a half-written object left behind would be
 * swept as an orphan anyway, but leaving it would mean a retry races its own debris.
 *
 * **Local emulation proves the code path and nothing about IAM.** Bucket policy, least-privilege
 * roles and KMS are verified against real AWS at gate G11. Nothing here may imply otherwise.
 */

import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  SourceDocumentService,
  type SourceDocumentVersionRecord,
  type StorageReference,
} from '../persistence/source-document.service.js';
import { RetentionService } from '../persistence/retention.service.js';
import type { PrecisedDate } from '../persistence/source-document.service.js';

import {
  keyFor,
  tenantOfKey,
  tenantPrefix,
  type ObjectStorePort,
  type StoredObject,
} from './object-store.port.js';

/**
 * How long an object may exist unreferenced before the sweep will delete it.
 *
 * **Six hours**, from the C0 matrix. The longest legitimate gap between a completed upload and
 * its committed reference is one transaction retry cycle — seconds. Six hours is three orders of
 * magnitude of headroom, chosen so a sweep cannot race a slow commit under load. It costs a few
 * hours of storage for a bounded number of objects, which is the cheap side of the trade.
 */
export const ORPHAN_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Bounded so one tenant's backlog cannot monopolise a sweep. */
const SWEEP_BATCH = 500;

export interface StageAndCommitInput {
  readonly tenantId: string;
  readonly body: Uint8Array;
  readonly contentType: string;

  readonly sourceId: string;
  readonly publisher: string;
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly sourceTier: string;
  readonly retrievedAt: PrecisedDate;
  readonly publicationDate?: PrecisedDate | null;
  readonly eventDate?: PrecisedDate | null;
  readonly updateDate?: PrecisedDate | null;
  readonly language?: string | null;
  readonly originalScript?: string | null;
  readonly documentId?: string | undefined;

  /** D-012: 30 days by default, configurable per policy version. */
  readonly retentionExpiresAt: Date | null;
  readonly retentionPolicyBasis?: string;
  readonly now: Date;
}

export interface OrphanSweepSummary {
  readonly listed: number;
  readonly deleted: number;
  readonly withinWindow: number;
  readonly unattributable: number;
}

@Injectable()
export class EvidenceStagingService {
  private readonly logger = new Logger('EvidenceStaging');

  constructor(
    private readonly store: ObjectStorePort,
    private readonly documents: SourceDocumentService,
    private readonly retention: RetentionService,
    private readonly region: string,
  ) {}

  /**
   * Stage the bytes, verify them against the store, then commit the reference.
   *
   * Not wrapped in a MongoDB transaction, and that is deliberate: S3 cannot join one (§6.3, and
   * the phase brief's "do not" list says so explicitly). The ordering here is what stands in for
   * a transaction, and the orphan sweep is what makes the ordering safe.
   */
  async stageAndCommit(input: StageAndCommitInput): Promise<SourceDocumentVersionRecord> {
    const contentHash = sha256Base64(input.body);
    const key = keyFor({ tenantId: input.tenantId, region: this.region, now: input.now });

    const stored = await this.store.put({
      key,
      body: input.body,
      contentType: input.contentType,
      checksumValue: contentHash,
    });

    // Read back what the store holds. This is the verification; `put`'s own return value is the
    // store's account of the write, and this is the store's account of the object.
    const readBack = await this.verified({
      key,
      expected: contentHash,
      byteSize: input.body.byteLength,
      stored,
      readBack: await this.store.head(key),
    });

    const storage: StorageReference = {
      bucket: stored.bucket,
      key,
      byteSize: readBack.byteSize,
      contentType: readBack.contentType,
      checksumAlgorithm: 'SHA256',
      checksumValue: readBack.checksumValue,
      // Set here and nowhere else. `SourceDocumentService.commit` refuses a reference without
      // it, so the only way to get a committed reference is to have come through this method.
      verifiedAt: input.now,
    };

    const record = await this.documents.commit({
      tenantId: input.tenantId,
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      sourceId: input.sourceId,
      publisher: input.publisher,
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl,
      sourceTier: input.sourceTier,
      retrievedAt: input.retrievedAt,
      publicationDate: input.publicationDate ?? null,
      eventDate: input.eventDate ?? null,
      updateDate: input.updateDate ?? null,
      language: input.language ?? null,
      originalScript: input.originalScript ?? null,
      contentHash,
      storage,
      retentionExpiresAt: input.retentionExpiresAt,
      now: input.now,
    });

    // Scheduled after the commit, from the committed record. Scheduling a deletion for an
    // object whose reference did not commit would queue the removal of something that is
    // already an orphan, and the orphan sweep owns that case.
    if (input.retentionExpiresAt !== null) {
      await this.retention.schedule({
        tenantId: input.tenantId,
        targetId: record.documentVersionId,
        storageBucket: storage.bucket,
        storageKey: storage.key,
        dueAt: input.retentionExpiresAt,
        policyBasis: input.retentionPolicyBasis ?? 'policy default (D-012)',
        now: input.now,
      });
    }

    return record;
  }

  /**
   * Compare what we intended to store against what the store says it holds, and return it.
   *
   * Returns the verified object rather than asserting on its argument, so a missing object
   * cannot be typed past this point — the only value the caller can go on with is one that
   * passed. Deletes the object on any mismatch: a retry would otherwise race the debris of the
   * attempt that failed.
   */
  private async verified(input: {
    readonly key: string;
    readonly expected: string;
    readonly byteSize: number;
    readonly stored: StoredObject;
    readonly readBack: StoredObject | null;
  }): Promise<StoredObject> {
    const problem = describeMismatch(input);
    if (problem === null && input.readBack !== null) {
      return input.readBack;
    }

    // Best effort. If this delete fails the object is an orphan, which the sweep handles — and
    // failing the request for the *original* reason is more useful than failing it for the
    // cleanup's reason.
    try {
      await this.store.remove(input.key);
    } catch (error) {
      this.logger.warn(
        `Could not remove the unverified object ${input.key}: ${String(error)}. ` +
          'The orphan sweep will collect it.',
      );
    }

    throw new Error(
      `Refusing to commit a reference to ${input.key}: ${problem ?? 'the store reports no such object'}. ` +
        'The object was not committed and has been removed (FI-03).',
    );
  }

  /**
   * Delete objects under a tenant's prefix that no committed reference names.
   *
   * Reads the committed keys **after** listing the bucket, not before. That ordering matters:
   * an object staged during the sweep appears in a later listing but its reference is already
   * in the set, so it is protected. The inverse order has a window in which a just-committed
   * object looks like an orphan — and it would be deleted while a reference points at it, which
   * is the exact failure FI-03 exists to prevent, caused by the reconciler for it.
   *
   * The age window is the second guard and the load-bearing one.
   */
  async sweepOrphans(input: {
    readonly tenantId: string;
    readonly now: Date;
    readonly windowMs?: number;
  }): Promise<OrphanSweepSummary> {
    const windowMs = input.windowMs ?? ORPHAN_WINDOW_MS;
    const cutoff = new Date(input.now.getTime() - windowMs);
    const prefix = tenantPrefix(input.tenantId, this.region);

    const listed = await this.store.list(prefix);
    const committed = await this.documents.committedStorageKeys(input.tenantId);

    let deleted = 0;
    let withinWindow = 0;
    let unattributable = 0;

    for (const object of listed.slice(0, SWEEP_BATCH)) {
      if (committed.has(object.key)) {
        continue;
      }
      // Refuse to delete anything not attributable to this tenant. Without this the sweep is a
      // bucket-wide delete with a prefix filter, and the first unrelated object anyone puts in
      // the bucket is destroyed by a scheduled job.
      if (tenantOfKey(object.key, this.region) !== input.tenantId) {
        unattributable += 1;
        continue;
      }
      if (object.lastModified > cutoff) {
        // Young and unreferenced is the normal state of an upload in flight, not an orphan.
        withinWindow += 1;
        continue;
      }
      await this.store.remove(object.key);
      deleted += 1;
    }

    if (deleted > 0) {
      this.logger.log(
        `Orphan sweep removed ${String(deleted)} unreferenced object(s) older than ` +
          `${String(Math.round(windowMs / 3_600_000))}h.`,
      );
    }
    return { listed: listed.length, deleted, withinWindow, unattributable };
  }

  /** Does the object a committed reference names actually exist? The T41 assertion. */
  async referenceResolves(record: SourceDocumentVersionRecord): Promise<boolean> {
    return (await this.store.head(record.storage.key)) !== null;
  }
}

function describeMismatch(input: {
  readonly expected: string;
  readonly byteSize: number;
  readonly stored: StoredObject;
  readonly readBack: StoredObject | null;
}): string | null {
  if (input.readBack === null) {
    return 'the store reports no such object after the write';
  }
  if (input.stored.checksumValue !== input.expected) {
    return 'the checksum the store returned on write does not match the bytes sent';
  }
  if (input.readBack.checksumValue !== input.expected) {
    return 'the checksum the store holds does not match the bytes sent';
  }
  if (input.readBack.byteSize !== input.byteSize) {
    return `the store holds ${String(input.readBack.byteSize)} bytes, not ${String(input.byteSize)}`;
  }
  return null;
}

export function sha256Base64(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('base64');
}
