/**
 * Reading the **active approved version** of a source, for the gate that authorises a fetch.
 *
 * Phase E step 2. `SourceHealthService` already reads this collection, but it reads a different
 * question: it wants the budgets, the status and the licence clock, because it decides whether a
 * source may be called *right now*. The fetch gate wants what an approver actually signed — the
 * domains, the countries, the languages, the robots position, the licence terms version — because
 * it decides whether **this URL** is inside what was approved. Two questions, two readers, one
 * collection; merging them would produce a reader whose callers each ignore half of it.
 *
 * Three rules this file keeps.
 *
 * **A source with no active version resolves to `null`, never to a permissive default.** An
 * unapproved source is the thing the registry exists to prevent, and a default would be an
 * approval nobody gave.
 *
 * **Both stored shapes are read.** The bootstrap writes source fields flat on the document;
 * `VersionedRecordService` nests them under `content`. Reading only one shape is how an
 * administrator takes a source through four-eyes approval and finds the pipeline still running
 * under the seeded one — a defect `TaxonomyService` already hit and documents.
 *
 * **Nothing here decides anything.** It reads and narrows types. The judgements are in
 * `FetchGateService`, which is where they can be tested without a database.
 */

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

/** The registry vocabulary for a source's robots position. Not the gate's — see `RobotsPosition`. */
export type RegisteredRobotsPosition = 'HONOURED' | 'EXCEPTION_APPROVED' | 'NOT_ESTABLISHED';

/**
 * What an approved source version says, as the fetch gate reads it.
 *
 * Every field here is one `source-content.ts` lists as load-bearing, and every one of them is
 * read by `FetchGateService`. A field nothing reads does not belong in this interface: the list
 * is the answer to "what does an approval actually authorise?".
 */
export interface ActiveSourceVersion {
  readonly sourceId: string;
  /** Stable identifier for the exact version, recorded on every authorisation it permits. */
  readonly versionId: string;
  readonly version: number;
  readonly sourceName: string;
  readonly connectorType: string;
  readonly canonicalDomains: readonly string[];
  readonly countries: readonly string[];
  readonly languages: readonly string[];
  readonly robotsPosition: RegisteredRobotsPosition;
  /** Null when the version records none, which the gate refuses rather than assuming terms. */
  readonly licenceTermsVersion: string | null;
  /** ISO 8601, or null for terms with no end date. */
  readonly licenceExpiresAt: string | null;
  readonly cascadeRung: number;
  readonly authorityTier: number;
}

/**
 * The slice `FetchGateService` depends on.
 *
 * Narrow on purpose, and for the same reason `SourceAccessPort` is: the gate may ask what an
 * approver signed, and it may not write to the registry. It also lets the gate be tested against
 * a stub, which is what keeps every refusal in `fetch-gate.service.ts` provable without Mongo.
 */
export interface SourceVersionReader {
  loadActive(sourceId: string): Promise<ActiveSourceVersion | null>;
}

@Injectable()
export class SourceVersionService implements SourceVersionReader {
  private readonly versions: Collection;

  constructor(db: Db) {
    this.versions = db.collection('sourceVersions');
  }

  /**
   * The active version of a source, or `null` when it has none.
   *
   * Read fresh on every call rather than cached, for the same reason `SourceHealthService` reads
   * fresh: a cached approval keeps authorising fetches after an administrator has retired the
   * version, and the window in which that is true is the window somebody asked us to stop.
   */
  async loadActive(sourceId: string): Promise<ActiveSourceVersion | null> {
    const document = await this.versions.findOne(
      { sourceId, status: 'ACTIVE' },
      { sort: { version: -1 } },
    );
    if (document === null) {
      return null;
    }

    const content = (document['content'] as Record<string, unknown> | undefined) ?? document;
    const version = numberOr(document['version'], 1);
    const robots = stringOrNull(content['robotsPosition']);

    return {
      sourceId,
      versionId: stringOrNull(document['versionId']) ?? `${sourceId}:v${String(version)}`,
      version,
      sourceName: stringOrNull(content['sourceName']) ?? sourceId,
      connectorType: stringOrNull(content['connectorType']) ?? 'UNKNOWN',
      canonicalDomains: stringArray(content['canonicalDomains']),
      countries: stringArray(content['countries']),
      languages: stringArray(content['languages']),
      // An unrecognised or absent value reads as `NOT_ESTABLISHED`, which the gate refuses. A
      // record whose robots field cannot be interpreted has not established a position.
      robotsPosition:
        robots === 'HONOURED' || robots === 'EXCEPTION_APPROVED' ? robots : 'NOT_ESTABLISHED',
      licenceTermsVersion: stringOrNull(content['licenceTermsVersion']),
      licenceExpiresAt: stringOrNull(content['licenceExpiresAt']),
      cascadeRung: numberOr(content['cascadeRung'], 0),
      authorityTier: numberOr(content['authorityTier'], 5),
    };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
