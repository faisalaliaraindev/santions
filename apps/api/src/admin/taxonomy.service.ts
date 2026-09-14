/**
 * Reading a tenant's **pinned** taxonomy version.
 *
 * The sibling of `PolicyService`, and for the same reason (FR-03): "every search records the
 * taxonomy version it ran under, and historical searches continue to explain themselves under
 * that version." A run that re-read the current taxonomy at display time would start explaining
 * a March result under October's categories — and a category disabled in between would make an
 * old finding unexplainable, or worse, silently recategorised.
 *
 * So `loadPinned` reads by version, with **no `status` filter**: a superseded version is still
 * the one that run used.
 */

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import type { TaxonomyVersion } from '@erly/adverse-domain';

import { ApiException } from '../common/api-exception.js';

/**
 * The stored shape.
 *
 * The bootstrap writes categories and languages flat on the document, which is already the
 * `TaxonomyVersion` shape the domain expects — so this reads rather than translates. Where a
 * field is absent on an older record it defaults to the safe value: no categories, no measured
 * language, empty lexicon. Every one of those defaults narrows what the service will claim.
 */
interface TaxonomyVersionRecord {
  readonly tenantId: string;
  readonly version: number;
  readonly status?: string;
  readonly categories?: TaxonomyVersion['categories'];
  readonly languages?: TaxonomyVersion['languages'];
  readonly lexicon?: TaxonomyVersion['lexicon'];
  /**
   * The nested form, written by `VersionedRecordService`.
   *
   * Two shapes exist and both are real, which was discovered at D6 when the first taxonomy was
   * activated through the admin API: the bootstrap writes the fields flat, and a version
   * proposed through `/v1/admin/taxonomy` carries them under `content`. Reading only the flat
   * shape meant an administrator could take a taxonomy all the way through four-eyes approval
   * and activation and have the pipeline keep running under the seeded one — silently, with the
   * admin API reporting success. So both are read, nested first, because a version that has
   * both is one this service wrote.
   */
  readonly content?: {
    readonly categories?: TaxonomyVersion['categories'];
    readonly languages?: TaxonomyVersion['languages'];
    readonly lexicon?: TaxonomyVersion['lexicon'];
  };
  readonly proposedBy?: string;
  readonly approvedBy?: string | null;
  readonly activatedAt?: string | null;
}

@Injectable()
export class TaxonomyService {
  private readonly taxonomies: Collection<TaxonomyVersionRecord>;

  constructor(db: Db) {
    this.taxonomies = db.collection<TaxonomyVersionRecord>('taxonomyVersions');
  }

  async loadPinned(tenantId: string, version: number): Promise<TaxonomyVersion> {
    const record = await this.taxonomies.findOne({ tenantId, version });
    if (record === null) {
      throw new ApiException(
        'INVALID_POLICY',
        'The taxonomy version this search was created under no longer exists.',
        { internalDetail: `tenant=${tenantId} taxonomyVersion=${String(version)}` },
      );
    }

    return {
      taxonomyVersionId: `${tenantId}:v${String(version)}`,
      version,
      tenantId,
      categories: record.content?.categories ?? record.categories ?? [],
      lexicon: record.content?.lexicon ?? record.lexicon ?? [],
      // An absent language list means nothing is measured, which means nothing is enabled.
      // That is the correct reading of a missing field, and the coverage statement will say so.
      languages: record.content?.languages ?? record.languages ?? [],
      status: (record.status as TaxonomyVersion['status'] | undefined) ?? 'ACTIVE',
      proposedBy: record.proposedBy ?? 'bootstrap',
      approvedBy: record.approvedBy ?? null,
      activatedAt: record.activatedAt ?? null,
    };
  }

  async loadActive(tenantId: string): Promise<TaxonomyVersion> {
    const record = await this.taxonomies.findOne(
      { tenantId, status: 'ACTIVE' },
      { sort: { version: -1 } },
    );
    if (record === null) {
      throw new ApiException('INVALID_POLICY', 'No active taxonomy version for this tenant.', {
        internalDetail: `tenant=${tenantId}`,
      });
    }
    return this.loadPinned(tenantId, record.version);
  }
}
