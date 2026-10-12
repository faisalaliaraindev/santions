/**
 * Phase D step D5 — where source health is stored, and the one place a source is asked
 * "may I be used right now?".
 *
 * # The document this service owns, and the one it must not touch
 *
 * `sourceHealth` is a **separate mutable collection keyed by `sourceId`**. It is deliberately
 * not part of `sourceVersions`: an approved version is immutable, and breaker state, budget
 * counters and a kill switch change continuously. Writing them onto the version would force a
 * choice between breaking that immutability and losing the observations, and this service exists
 * so nobody has to make it. The approved version says what is **permitted**; this document says
 * what is **happening**.
 *
 * It is **shared, not tenant-owned**, for the same reason source configuration is (§6.3): a
 * publisher's rate limit and a publisher's outage are properties of the publisher. Two tenants
 * screening against the same source are behind the same breaker, and per-tenant budgets would
 * let the sum of the tenants exceed the free tier the publisher actually grants. It therefore
 * joins `capabilityCoverage` and `nameFrequencyProfiles` in the documented list of cross-tenant
 * collections in `docs/architecture.md`.
 *
 * # Why `checkAccess` is called at the point of use
 *
 * A run pins its source versions at plan time. If access were decided there too, a source
 * suspended for a rights violation would keep being fetched for the whole length of every
 * in-flight run — the exact behaviour T36 forbids. So the pipeline calls `checkAccess`
 * immediately before each call it is about to make, and a kill switch engaged one second ago is
 * honoured by a run that started an hour ago.
 *
 * # All the reasoning is pure
 *
 * Every decision — whether the breaker is open, whether the cooldown elapsed, whether the budget
 * window rolled, what the refusal means in coverage vocabulary — is made by
 * `packages/domain/src/reliability/source-health.ts`. This file reads Mongo, hands the document
 * to those functions, and writes back what they return.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import {
  accessCoverageOutcome,
  decideSourceAccess,
  engageKillSwitch,
  newSourceHealth,
  observeSuccess,
  releaseKillSwitch,
  rollBudgets,
  sinceSuspendedNote,
  spendAccess,
  applyObservedFailure,
  NO_STOP_CONDITIONS,
  type FailureSignal,
  type SourceAccessDecision,
  type SourceBudgets,
  type SourceCoverageOutcome,
  type SourceHealth,
  type StopConditionPolicy,
} from '@adverse-search/domain';

import { ApiException } from '../common/api-exception.js';
import { AuditService } from '../persistence/audit.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';

import { PLATFORM_AUDIT_TENANT_ID, SYSTEM_ACTOR } from './platform-audit.js';

/** The stored shape. `_id` is the `sourceId`, so there is one document per source by construction. */
interface SourceHealthRecord extends Omit<SourceHealth, 'sourceId'> {
  readonly _id: string;
  readonly updatedAt: Date;
  /**
   * Consecutive server errors, for the D17 stop conditions.
   *
   * Deliberately **not** on the `SourceHealth` domain document. FR-06's breaker counts
   * qualifying failures of every class, and this counts one narrow thing a *recorded per-source
   * policy* asks about — a publisher's site failing repeatedly. Putting it on the domain
   * document would make it look like part of the breaker, and the next person would wire it
   * into a decision the FR-06 table already makes differently.
   *
   * Absent on documents written before stop conditions existed, and read as zero.
   */
  readonly consecutiveServerErrors?: number;
}

/**
 * What the approved version contributes to the decision.
 *
 * Read fresh on every check rather than cached. A cached budget is a budget that keeps being
 * spent after an administrator lowered it, and a cached status is a suspension that does not
 * take effect until a process restarts.
 */
interface VersionFacts {
  readonly version: number;
  readonly status: string;
  readonly budgets: SourceBudgets;
  readonly licenceExpiresAt: string | null;
  readonly sourceName: string;
  readonly cascadeRung: number;
  /**
   * The escalations the approver recorded on this version (D17), or none.
   *
   * Read fresh on every failure, like the budgets and for the same reason: a stop condition
   * added by an administrator this morning must apply to the run that is in flight now.
   */
  readonly stopConditions: StopConditionPolicy;
}

export interface AccessCheck {
  readonly decision: SourceAccessDecision;
  /** Null when access was permitted. Never null when it was refused — a refusal is not a skip. */
  readonly coverageOutcome: SourceCoverageOutcome | null;
}

@Injectable()
export class SourceHealthService {
  private readonly logger = new Logger('SourceHealth');
  private readonly health: Collection<SourceHealthRecord>;
  private readonly versions: Collection;

  constructor(
    db: Db,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {
    this.health = db.collection<SourceHealthRecord>('sourceHealth');
    this.versions = db.collection('sourceVersions');
  }

  async ensureIndexes(): Promise<void> {
    // Keyed by `_id` already; this index is for the operator view, which lists what is unwell.
    await this.health.createIndex({ breaker: 1, updatedAt: -1 });
  }

  /**
   * May this source be called, right now?
   *
   * On `allowed`, the spend is recorded **before** the caller makes the call: the publisher
   * counts requests, not successes, and a budget decremented on success would let a failing
   * source be called without limit.
   *
   * `queriesAffected` shapes only the coverage outcome, never the decision. It is how many
   * queries this refusal costs the run, which is what a reviewer needs to read.
   */
  async checkAccess(input: {
    readonly sourceId: string;
    readonly now: Date;
    readonly queriesAffected?: number | undefined;
    /**
     * Whether this check consumes one of the source's budgeted requests. Defaults to `true`.
     *
     * The budget counts **requests put on the wire**, which is what the publisher counts, so the
     * component that opens the socket is the component that spends. Phase E made that a real
     * distinction: the pipeline asks "may I try this lead at all?" before handing it to the fetch
     * adapter, and the adapter then makes one, two or three actual requests — robots.txt, the
     * document, a redirect hop. If both spent, the budget would drain at a rate unrelated to the
     * traffic the publisher sees.
     *
     * So the pipeline passes `spend: false` for its rights-and-breaker check, and
     * `HttpEvidenceFetchAdapter` spends once per request it actually issues.
     */
    readonly spend?: boolean | undefined;
  }): Promise<AccessCheck> {
    const facts = await this.versionFacts(input.sourceId);
    const current = await this.load(input.sourceId, facts, input.now);

    const decision = decideSourceAccess({
      health: current,
      budgets: facts.budgets,
      versionStatus: facts.status,
      now: input.now,
    });

    // `decision.health` carries the cooldown transition and the rolled windows; the spend is
    // applied on top of it so a half-open probe is counted exactly once.
    const next =
      decision.allowed && input.spend !== false
        ? spendAccess({ health: decision.health, now: input.now })
        : decision.health;
    await this.save(next, input.now);

    if (!decision.allowed) {
      this.logger.warn(`${input.sourceId}: ${decision.refusal ?? 'REFUSED'} — ${decision.detail}`);
    }

    return {
      decision,
      coverageOutcome: accessCoverageOutcome({
        decision,
        sourceId: input.sourceId,
        sourceName: facts.sourceName,
        cascadeRung: facts.cascadeRung,
        queriesAffected: input.queriesAffected ?? 1,
      }),
    };
  }

  /**
   * Fold in a failure, classifying the observed signal through the FR-06 table on the way, and
   * apply whatever **stop conditions** the source's approved version records (D17).
   *
   * The two are evaluated together and in that order, because a stop condition is an escalation
   * of the classification rather than a replacement for it: the FR-06 class is what the breaker,
   * the retry policy and the coverage record read, and the stop condition only decides whether
   * this source also stops entirely. `evaluateStopConditions` can return "halt" or "nothing to
   * add" and has no third answer, so nothing here can make a refused request permitted.
   *
   * A halt is implemented by engaging the kill switch. That is not a shortcut — it is the
   * mechanism D5 already built for exactly this shape: effective immediately, effective mid-run
   * because access is rechecked at the point of use, reason mandatory and carried into the
   * coverage statement, and **four eyes to release**, which is what "requires fresh approval"
   * has to mean if it is to mean anything.
   */
  async recordFailure(input: {
    readonly sourceId: string;
    readonly signal: FailureSignal;
    readonly now: Date;
  }): Promise<SourceHealth> {
    const facts = await this.versionFacts(input.sourceId);
    const current = await this.load(input.sourceId, facts, input.now);

    // One pure composition, shared with the trip-wire harness, so the test and the service run
    // the same code rather than two implementations that agree until they do not.
    const applied = applyObservedFailure({
      health: current,
      signal: input.signal,
      conditions: facts.stopConditions,
      consecutiveServerErrors: await this.serverErrorStreak(input.sourceId),
      now: input.now,
      haltedBy: SYSTEM_ACTOR,
    });
    const next = applied.health;

    if (next.breaker === 'OPEN' && current.breaker !== 'OPEN') {
      this.logger.warn(
        `${input.sourceId}: circuit breaker opened after ${applied.failureClass}. ` +
          `Requests are held; every run that wanted this source reports a coverage gap.`,
      );
    }

    if (!applied.halted) {
      await this.save(next, input.now, undefined, applied.consecutiveServerErrors);
      return next;
    }

    this.logger.error(
      `${input.sourceId}: HALTED by stop condition ${applied.verdict.reason ?? 'HALT'}. ` +
        `${applied.verdict.detail} No further request is made to this source.`,
    );

    return this.transactions.run(
      async (session) => {
        await this.save(next, input.now, session, applied.consecutiveServerErrors);
        await this.audit.append(
          {
            // A halt has no tenant: nobody asked for it. See `platform-audit.ts`.
            tenantId: PLATFORM_AUDIT_TENANT_ID,
            actor: { type: 'SYSTEM', subject: SYSTEM_ACTOR, clientId: null },
            action: 'source:stop_condition_halt',
            target: { type: 'SourceHealth', id: input.sourceId, version: facts.version },
            reason: next.killSwitch?.reason ?? applied.verdict.detail,
            correlationId: null,
            result: 'DENIED',
            now: input.now,
          },
          session,
        );
        return next;
      },
      { name: 'sourceHealth.stopCondition' },
    );
  }

  /** The stored consecutive-server-error streak, or zero for a source never observed failing. */
  private async serverErrorStreak(sourceId: string): Promise<number> {
    const record = await this.health.findOne(
      { _id: sourceId },
      { projection: { consecutiveServerErrors: 1 } },
    );
    return record?.consecutiveServerErrors ?? 0;
  }

  async recordSuccess(input: {
    readonly sourceId: string;
    readonly now: Date;
  }): Promise<SourceHealth> {
    const facts = await this.versionFacts(input.sourceId);
    const current = await this.load(input.sourceId, facts, input.now);
    const next = observeSuccess({ health: current, now: input.now });
    // The streak resets here as well as in `recordFailure`: a success is what ends a run of
    // server errors, and a counter that only ever reset on a *different kind* of failure would
    // eventually halt a source that recovered between outages.
    await this.save(next, input.now, undefined, 0);
    return next;
  }

  /**
   * Engage the kill switch — one person, effective immediately.
   *
   * Deliberately not four-eyes. D1 settled the same question for suspension: stopping a source
   * is the safe direction, and requiring a second approver to stop fetching from a publisher who
   * has just complained means the fetching continues while the second approver is found.
   * Releasing is the direction that needs two, and `release` enforces that.
   *
   * The reason is mandatory and reaches the coverage statement of every run that wanted this
   * source, so it is written for a reviewer rather than for a log.
   */
  async engage(input: {
    readonly sourceId: string;
    readonly reason: string;
    readonly actor: string;
    readonly tenantId: string;
    readonly now: Date;
    readonly correlationId?: string | undefined;
  }): Promise<SourceHealth> {
    const facts = await this.versionFacts(input.sourceId);
    const current = await this.load(input.sourceId, facts, input.now);
    if (current.killSwitch !== null) {
      throw new ApiException(
        'ALREADY_TERMINAL',
        `Source ${input.sourceId} is already suspended by ${current.killSwitch.engagedBy}: ` +
          current.killSwitch.reason,
      );
    }

    const next = engageKillSwitch({
      health: current,
      reason: input.reason,
      engagedBy: input.actor,
      now: input.now,
    });

    return this.transactions.run(
      async (session) => {
        await this.save(next, input.now, session);
        await this.audit.append(
          {
            tenantId: input.tenantId,
            actor: { type: 'USER', subject: input.actor, clientId: null },
            action: 'source:kill_switch_engage',
            target: { type: 'SourceHealth', id: input.sourceId, version: facts.version },
            reason: input.reason,
            correlationId: input.correlationId ?? null,
            result: 'ALLOWED',
            now: input.now,
          },
          session,
        );
        return next;
      },
      { name: 'sourceHealth.engage' },
    );
  }

  /**
   * Release the kill switch — four eyes.
   *
   * The releaser must not be the person who engaged it, on the same reasoning as every other
   * four-eyes check in this service: a source is normally suspended because somebody believes we
   * should not be fetching it, and the person who formed that belief is the wrong person to
   * decide unilaterally that it no longer holds.
   */
  async release(input: {
    readonly sourceId: string;
    readonly reason: string;
    readonly actor: string;
    readonly tenantId: string;
    readonly now: Date;
    readonly correlationId?: string | undefined;
  }): Promise<SourceHealth> {
    const facts = await this.versionFacts(input.sourceId);
    const current = await this.load(input.sourceId, facts, input.now);
    if (current.killSwitch === null) {
      throw new ApiException('ALREADY_TERMINAL', `Source ${input.sourceId} is not suspended.`);
    }
    if (current.killSwitch.engagedBy === input.actor) {
      throw new ApiException(
        'FORBIDDEN',
        'Four-eyes: the person who suspended a source may not release it. A different ' +
          'authorised user must.',
      );
    }

    const next = releaseKillSwitch(current);
    return this.transactions.run(
      async (session) => {
        await this.save(next, input.now, session);
        await this.audit.append(
          {
            tenantId: input.tenantId,
            actor: { type: 'USER', subject: input.actor, clientId: null },
            action: 'source:kill_switch_release',
            target: { type: 'SourceHealth', id: input.sourceId, version: facts.version },
            reason: `${input.reason} (suspended by ${current.killSwitch?.engagedBy ?? 'unknown'})`,
            correlationId: input.correlationId ?? null,
            result: 'ALLOWED',
            now: input.now,
          },
          session,
        );
        return next;
      },
      { name: 'sourceHealth.release' },
    );
  }

  /** The operator view: every source this service has observed, unwell ones included. */
  async list(now: Date): Promise<SourceHealth[]> {
    const records = await this.health.find({}).sort({ _id: 1 }).toArray();
    return records.map((record) => toDomain(record, now));
  }

  async get(sourceId: string, now: Date): Promise<SourceHealth> {
    const facts = await this.versionFacts(sourceId);
    return this.load(sourceId, facts, now);
  }

  /**
   * The T36 "or after result" half: what a **historical** result must say about its source.
   *
   * A result produced under a source that was later suspended is not retro-actively deleted —
   * deleting it would destroy an accurate record of what was found and when. But a subsequent
   * read of it must show that the source has since been suspended, or a reviewer re-reading a
   * six-month-old report is relying on a source this service has stopped trusting without being
   * told. See decision D-031 for where this surfaces and why in both places.
   *
   * Returns a note per `sourceId`, absent when the source is fine.
   */
  async suspensionNotesFor(input: {
    readonly sourceIds: readonly string[];
    readonly producedAt: Date;
    readonly asOf: Date;
  }): Promise<Record<string, string>> {
    const unique = [...new Set(input.sourceIds)];
    if (unique.length === 0) {
      return {};
    }
    const records = await this.health.find({ _id: { $in: unique } }).toArray();
    const notes: Record<string, string> = {};
    for (const record of records) {
      const note = sinceSuspendedNote({
        health: { killSwitch: record.killSwitch, licenceExpiresAt: record.licenceExpiresAt },
        producedAt: input.producedAt.toISOString(),
        asOf: input.asOf,
      });
      if (note !== null) {
        notes[record._id] = note;
      }
    }
    return notes;
  }

  /**
   * Read the health document, creating it in memory if this source has never been observed.
   *
   * The licence expiry and the observed version are refreshed from the approved version on every
   * read. That is the direction the copy must flow: the version is the record an approver signed,
   * and health is downstream of it. A stale licence date cached on the health document would let
   * a source be fetched past terms that an administrator has already corrected.
   */
  private async load(sourceId: string, facts: VersionFacts, now: Date): Promise<SourceHealth> {
    const record = await this.health.findOne({ _id: sourceId });
    if (record === null) {
      return newSourceHealth({
        sourceId,
        observedVersion: facts.version,
        now,
        licenceExpiresAt: facts.licenceExpiresAt,
      });
    }
    return {
      ...toDomain(record, now),
      observedVersion: facts.version,
      licenceExpiresAt: facts.licenceExpiresAt,
    };
  }

  private async save(
    health: SourceHealth,
    now: Date,
    session?: Parameters<AuditService['append']>[1],
    consecutiveServerErrors?: number,
  ): Promise<void> {
    const { sourceId, ...rest } = health;
    await this.health.updateOne(
      { _id: sourceId },
      {
        $set: {
          ...rest,
          updatedAt: now,
          ...(consecutiveServerErrors === undefined ? {} : { consecutiveServerErrors }),
        },
      },
      { upsert: true, ...(session === undefined ? {} : { session }) },
    );
  }

  /**
   * The approved version's contribution, or a refusing default.
   *
   * A source with no active version is **not** an error here and is **not** permission. It
   * resolves to a version status that `decideSourceAccess` refuses, so an unregistered source id
   * produces a recorded coverage gap rather than either a crash or an unbudgeted call.
   */
  private async versionFacts(sourceId: string): Promise<VersionFacts> {
    const document = await this.versions.findOne(
      { sourceId, status: 'ACTIVE' },
      { sort: { version: -1 } },
    );
    if (document === null) {
      return {
        version: 0,
        status: 'NO_ACTIVE_VERSION',
        budgets: { hourlyBudget: null, dailyBudget: null },
        licenceExpiresAt: null,
        sourceName: sourceId,
        cascadeRung: 0,
        stopConditions: NO_STOP_CONDITIONS,
      };
    }

    // Seeded records store their content flat; versions written through the admin lifecycle nest
    // it under `content`. Both are read, because both are real active versions.
    const content = (document['content'] as Record<string, unknown> | undefined) ?? document;
    return {
      version: (document['version'] as number | undefined) ?? 1,
      status: (document['status'] as string | undefined) ?? 'NO_ACTIVE_VERSION',
      budgets: {
        hourlyBudget: numberOrNull(content['freeTierHourlyBudget']),
        dailyBudget: numberOrNull(content['freeTierDailyBudget']),
      },
      licenceExpiresAt: stringOrNull(content['licenceExpiresAt']),
      sourceName: stringOrNull(content['sourceName']) ?? sourceId,
      cascadeRung: numberOrNull(content['cascadeRung']) ?? 0,
      stopConditions: readStopConditions(content['accessPolicy']),
    };
  }
}

/**
 * The stop conditions an approver recorded, read defensively from the version's content.
 *
 * Defensive because this is registry data that predates the field: a version approved before
 * stop conditions existed has no `accessPolicy` at all, and the honest reading of its absence is
 * "no escalation", not "unknown". Every field that cannot be read falls back to the *less*
 * restrictive value, which is the safe direction here and only here — a stop condition invented
 * out of a malformed record would halt a working source on a value nobody approved, and FR-06's
 * table still governs the failure either way.
 */
function readStopConditions(value: unknown): StopConditionPolicy {
  const policy = asRecord(value);
  const conditions = policy === null ? null : asRecord(policy['stopConditions']);
  if (conditions === null) {
    return NO_STOP_CONDITIONS;
  }

  const statuses = Array.isArray(conditions['haltOnStatuses'])
    ? conditions['haltOnStatuses'].filter(
        (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
      )
    : [];
  const cooldownSeconds = numberOrNull(conditions['rateLimitCooldownSeconds']) ?? 0;

  return {
    haltOnStatuses: statuses,
    haltOnRateLimit: conditions['haltOnRateLimit'] === true,
    rateLimitCooldownMs: Math.round(cooldownSeconds * 1000),
    serverErrorStreakToHalt: numberOrNull(conditions['serverErrorStreakToHalt']),
    requiresFreshApprovalOnHalt: conditions['requiresFreshApprovalOnHalt'] === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The stored document as the domain sees it.
 *
 * The budget windows are rolled to `now` on the way out, so a caller reading health never sees
 * yesterday's spend presented as today's allowance. `decideSourceAccess` rolls them again and
 * that is harmless — rolling is idempotent — but a plain read must be honest on its own.
 */
function toDomain(record: SourceHealthRecord, now: Date): SourceHealth {
  return rollBudgets(
    {
      sourceId: record._id,
      observedVersion: record.observedVersion,
      breaker: record.breaker,
      openedAt: record.openedAt,
      halfOpenProbes: record.halfOpenProbes,
      consecutiveFailures: record.consecutiveFailures,
      lastFailureClass: record.lastFailureClass,
      lastFailureAt: record.lastFailureAt,
      lastSuccessAt: record.lastSuccessAt,
      hourly: record.hourly,
      daily: record.daily,
      killSwitch: record.killSwitch,
      licenceExpiresAt: record.licenceExpiresAt,
    },
    now,
  );
}
