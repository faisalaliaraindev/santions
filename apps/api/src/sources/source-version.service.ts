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
 * Who accepted that this service would begin making requests to a publisher (D17, D-042).
 *
 * Not the same as the version's approver. Approving a registry entry says the configuration is
 * right; this says a named person accepted first contact with a third party who did not ask to
 * hear from us.
 */
export interface FirstContactApproval {
  readonly approvedBy: string;
  readonly role: string;
  /** ISO 8601 date. */
  readonly approvedOn: string;
  /** The open decision this approval closes — `D17` for the first one. */
  readonly decision: string;
}

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
  /** Optional only for legacy stored/test records; loader always supplies it. */
  readonly publisher?: string;
  readonly connectorType: string;
  readonly canonicalDomains: readonly string[];
  /** Optional only for pre-existing stored/test records; absence means NAMED_COUNTRIES. */
  readonly jurisdictionScope?: 'NAMED_COUNTRIES' | 'GLOBAL';
  readonly countries: readonly string[];
  readonly languages: readonly string[];
  readonly robotsPosition: RegisteredRobotsPosition;
  /** Null when the version records none, which the gate refuses rather than assuming terms. */
  readonly licenceTermsVersion: string | null;
  /** ISO 8601, or null for terms with no end date. */
  readonly licenceExpiresAt: string | null;
  readonly cascadeRung: number;
  readonly authorityTier: number;
  /**
   * The named approval for the **first live request** to this publisher, or null.
   *
   * Null is the honest default and it is what every source carries until somebody signs it. The
   * gate refuses a live fetch without one (**D-042**), so a source can be fully configured,
   * approved as a registry entry, and still unreachable until a person accepts contact with the
   * publisher behind it.
   */
  readonly firstContactApproval: FirstContactApproval | null;
  /**
   * The feed or endpoint this source is polled at, where its connector needs one.
   *
   * Read from `accessPolicy.endpointUrl`. Null for a source that is fetched only by following
   * links, and the discovery connector refuses such a source rather than inventing a URL for it.
   */
  readonly endpointUrl: string | null;
  /**
   * Whether that endpoint is a fixed list or a search taking a query.
   *
   * Defaults to `FIXED_FEED` when the version records nothing, because that is the reading that
   * makes fewer requests: a fixed feed is polled once per cycle, a query feed once per planned
   * query. A wrong guess in the other direction multiplies our traffic at somebody else's server
   * by the size of the query plan.
   */
  readonly endpointKind: 'FIXED_FEED' | 'QUERY_FEED';
  /** For a `QUERY_FEED`, the parameter name the connector sets. Null otherwise. */
  readonly queryParam: string | null;
  /** The publisher's stated minimum interval between polls, in milliseconds. Null when none. */
  readonly pollFloorMs: number | null;
  /**
   * The publisher's stated ceiling on how often we may ask, in requests per second.
   *
   * Distinct from `pollFloorMs`, which bounds how often the *same* bytes are re-read and applies
   * to a `FIXED_FEED`. This bounds how fast *different* requests may leave, and it is what a
   * `QUERY_FEED` needs: every query is a new URL, so no poll floor ever applies to it.
   *
   * Null when the version records none. Read by `RequestPacer` — before this field was wired
   * through, `accessPolicy.requestCeilingPerSecond` was recorded on every source and enforced
   * nowhere.
   */
  readonly requestCeilingPerSecond: number | null;
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
      publisher: stringOrNull(content['publisher']) ?? sourceId,
      connectorType: stringOrNull(content['connectorType']) ?? 'UNKNOWN',
      canonicalDomains: stringArray(content['canonicalDomains']),
      jurisdictionScope: content['jurisdictionScope'] === 'GLOBAL' ? 'GLOBAL' : 'NAMED_COUNTRIES',
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
      firstContactApproval: readFirstContactApproval(content['accessPolicy']),
      endpointUrl: readEndpointUrl(content['accessPolicy']),
      endpointKind: readEndpointKind(content['accessPolicy']),
      queryParam: readQueryParam(content['accessPolicy']),
      pollFloorMs: readPollFloorMs(content['accessPolicy']),
      requestCeilingPerSecond: readRequestCeiling(content['accessPolicy']),
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

/**
 * The first-contact approval, read strictly.
 *
 * **Every field must be present and non-empty, or the answer is null.** This is the one place in
 * this file where a partial record must not degrade into a usable one: a half-filled approval
 * that the gate accepted would be a live request made under a name nobody actually wrote down,
 * which is precisely what D17 exists to prevent. A malformed approval is no approval.
 */
function readFirstContactApproval(value: unknown): FirstContactApproval | null {
  const policy = asRecord(value);
  const approval = policy === null ? null : asRecord(policy['firstContactApproval']);
  if (approval === null) {
    return null;
  }

  const approvedBy = stringOrNull(approval['approvedBy']);
  const role = stringOrNull(approval['role']);
  const approvedOn = stringOrNull(approval['approvedOn']);
  const decision = stringOrNull(approval['decision']);
  if (approvedBy === null || role === null || approvedOn === null || decision === null) {
    return null;
  }
  return { approvedBy, role, approvedOn, decision };
}

function readEndpointUrl(value: unknown): string | null {
  const policy = asRecord(value);
  return policy === null ? null : stringOrNull(policy['endpointUrl']);
}

/** `QUERY_FEED` only when the record says so. See the field comment for why that direction. */
function readEndpointKind(value: unknown): 'FIXED_FEED' | 'QUERY_FEED' {
  const policy = asRecord(value);
  return policy !== null && policy['endpointKind'] === 'QUERY_FEED' ? 'QUERY_FEED' : 'FIXED_FEED';
}

/**
 * The query parameter name, re-validated here as a bare name.
 *
 * The contract schema already constrains it, and it is checked again on the way out because this
 * value is used to build a URL aimed at a third party's server. A registry document can be
 * written by a path the schema did not run on — a migration, a fixture, a hand-edited record —
 * and the cost of trusting one here is a request shaped by whatever that document said.
 */
function readQueryParam(value: unknown): string | null {
  const policy = asRecord(value);
  const name = policy === null ? null : stringOrNull(policy['queryParam']);
  return name !== null && /^[A-Za-z0-9_.-]{1,40}$/.test(name) ? name : null;
}

function readPollFloorMs(value: unknown): number | null {
  const policy = asRecord(value);
  if (policy === null) {
    return null;
  }
  const seconds = policy['pollFloorSeconds'];
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : null;
}

/**
 * The recorded requests-per-second ceiling, or null.
 *
 * A non-positive or non-finite figure reads as absent rather than as "no limit": a corrupt
 * record should make this service ask less often, not more.
 */
function readRequestCeiling(value: unknown): number | null {
  const policy = asRecord(value);
  if (policy === null) {
    return null;
  }
  const ceiling = policy['requestCeilingPerSecond'];
  return typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
