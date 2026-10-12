/**
 * Where **per-domain** health is stored — the other half of FR-06's reliability controls
 * (decision **D-040**).
 *
 * # Why this exists beside `SourceHealthService`
 *
 * D5 built the per-source breaker and stopped there, honestly: FR-06 asks for per source *and*
 * per domain, and per source was what the registry could express. The gap it left is specific.
 * A discovery source hands us links to a hundred publishers, and when one of those publishers
 * starts refusing us, the per-source breaker has nowhere to put the fact — recording it against
 * the feed would suspend a working feed, and recording it nowhere would keep us calling a host
 * that has already said no.
 *
 * So there are two documents and two questions. `sourceHealth` answers "is this **agreement**
 * usable?" — licence, budget, kill switch, version status. `domainHealth` answers "is this
 * **publisher** willing to hear from us right now?" Both must allow a request. Neither invents a
 * failure taxonomy: both read FR-06's table, through the same two predicates.
 *
 * # Shared, and keyed on the registrable domain
 *
 * Cross-tenant, like `sourceHealth`, and for the same reason: a publisher's outage and a
 * publisher's refusal are properties of the publisher. Per-tenant domain state would let ten
 * tenants each independently rediscover that a host is blocking us, ten times over, at the
 * host's expense.
 *
 * The key is the registrable domain — `news.example.com` and `amp.example.com` are one
 * publisher — computed by `registrableDomain`, whose header explains what that rule gets wrong
 * and why the error is in the safe direction.
 *
 * # All the reasoning is pure
 *
 * This file reads Mongo, hands documents to `packages/domain/src/reliability/domain-health.ts`,
 * and writes back what comes out.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import {
  classifyFailure,
  decideDomainAccess,
  newDomainHealth,
  observeDomainFailure,
  observeDomainSuccess,
  registrableDomainOfUrl,
  releaseDomainSuspension,
  spendDomainProbe,
  suspendDomain,
  type DomainAccessDecision,
  type DomainHealth,
  type FailureSignal,
} from '@adverse-search/domain';

import { ApiException } from '../common/api-exception.js';
import { AuditService } from '../persistence/audit.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';

import type { DomainAccessPort } from './http-evidence-fetch.adapter.js';
import { PLATFORM_AUDIT_TENANT_ID } from './platform-audit.js';

/** The stored shape. `_id` is the registrable domain, so there is one document per publisher. */
interface DomainHealthRecord extends Omit<DomainHealth, 'domain'> {
  readonly _id: string;
  readonly updatedAt: Date;
}

@Injectable()
export class DomainHealthService implements DomainAccessPort {
  private readonly logger = new Logger('DomainHealth');
  private readonly domains: Collection<DomainHealthRecord>;

  constructor(
    db: Db,
    private readonly audit: AuditService,
    private readonly transactions: TransactionRunner,
  ) {
    this.domains = db.collection<DomainHealthRecord>('domainHealth');
  }

  async ensureIndexes(): Promise<void> {
    // For the operator view, which lists what is unwell rather than what exists.
    await this.domains.createIndex({ breaker: 1, updatedAt: -1 });
  }

  /**
   * May this URL's publisher be called, right now?
   *
   * Returns `{ domain: null, decision: null }` for a URL with no host — a malformed lead, which
   * the URL gate refuses a moment later anyway. Answering "allowed" for it would be a claim
   * about a publisher that does not exist; throwing would turn one bad lead into a failed run.
   *
   * On `allowed`, a half-open probe is counted here, before the caller makes the call, for the
   * same reason the source budget is spent before the call: the probe allowance exists to bound
   * how many requests reach a recovering host, and counting it on the way back bounds nothing.
   */
  async checkDomain(input: {
    readonly url: string;
    readonly now: Date;
  }): Promise<{ readonly domain: string | null; readonly decision: DomainAccessDecision | null }> {
    const domain = registrableDomainOfUrl(input.url);
    if (domain === null) {
      return { domain: null, decision: null };
    }

    const current = await this.load(domain);
    const decision = decideDomainAccess({ health: current, now: input.now });
    const next = decision.allowed ? spendDomainProbe(decision.health) : decision.health;
    await this.save(next, input.now);

    if (!decision.allowed) {
      this.logger.warn(`${domain}: ${decision.refusal ?? 'REFUSED'} — ${decision.detail}`);
    }
    return { domain, decision };
  }

  /**
   * Fold in a failure the **server produced**.
   *
   * A gate refusal must never arrive here, and the rule is enforced rather than documented: a
   * `policyRefusal` or a `robotsDisallow` classifies as `HARD_BLOCK`, whose domain action is
   * `SUSPEND`, so passing one in would suspend a publisher because *we* declined to ask them
   * something. Same reasoning as D-035, one layer along.
   */
  async recordDomainFailure(input: {
    readonly url: string;
    readonly signal: FailureSignal;
    readonly detail: string;
    readonly now: Date;
  }): Promise<void> {
    if (input.signal.policyRefusal === true || input.signal.robotsDisallow === true) {
      return;
    }
    const domain = registrableDomainOfUrl(input.url);
    if (domain === null) {
      return;
    }

    const current = await this.load(domain);
    const failureClass = classifyFailure(input.signal).failureClass;
    const next = observeDomainFailure({
      health: current,
      failureClass,
      detail: input.detail,
      now: input.now,
      ...(input.signal.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: input.signal.retryAfterSeconds }),
    });

    if (next.suspension !== null && current.suspension === null) {
      this.logger.error(
        `${domain}: suspended after ${failureClass}. No further request is made to this ` +
          `publisher until an operator releases it — a hard block does not expire on a clock.`,
      );
    } else if (next.breaker === 'OPEN' && current.breaker !== 'OPEN') {
      this.logger.warn(`${domain}: circuit breaker opened after ${failureClass}.`);
    }

    await this.save(next, input.now);
  }

  async recordDomainSuccess(input: { readonly url: string; readonly now: Date }): Promise<void> {
    const domain = registrableDomainOfUrl(input.url);
    if (domain === null) {
      return;
    }
    const current = await this.load(domain);
    await this.save(observeDomainSuccess({ health: current, now: input.now }), input.now);
  }

  /** The operator view: every domain this service has observed. */
  async list(): Promise<DomainHealth[]> {
    const records = await this.domains.find({}).sort({ _id: 1 }).toArray();
    return records.map(toDomain);
  }

  async get(domain: string): Promise<DomainHealth> {
    return this.load(domain);
  }

  /**
   * Suspend a publisher by hand — one person, effective immediately.
   *
   * The same asymmetry as the source kill switch (D5): stopping is the safe direction and must
   * not wait for a second approver, because the traffic continues while that approver is found.
   */
  async suspend(input: {
    readonly domain: string;
    readonly reason: string;
    readonly actor: string;
    readonly now: Date;
    readonly correlationId?: string | undefined;
  }): Promise<DomainHealth> {
    const current = await this.load(input.domain);
    if (current.suspension !== null) {
      throw new ApiException(
        'ALREADY_TERMINAL',
        `${input.domain} is already suspended by ${current.suspension.suspendedBy}: ` +
          current.suspension.detail,
      );
    }
    const next = suspendDomain({
      health: current,
      reason: input.reason,
      suspendedBy: input.actor,
      now: input.now,
    });
    return this.commit(
      next,
      'domain:suspend',
      input.reason,
      input.actor,
      input.now,
      input.correlationId,
    );
  }

  /**
   * Release a suspension — four eyes when a person engaged it.
   *
   * A suspension the FR-06 table produced carries `suspendedBy: 'SYSTEM'`, and there is no
   * second person to exclude; one authorised operator releases it, having established why the
   * publisher refused. A suspension a person engaged is released by a different person, on the
   * same reasoning as every other four-eyes check here: whoever formed the belief that we should
   * stop is the wrong person to decide alone that it no longer holds.
   */
  async release(input: {
    readonly domain: string;
    readonly reason: string;
    readonly actor: string;
    readonly now: Date;
    readonly correlationId?: string | undefined;
  }): Promise<DomainHealth> {
    const current = await this.load(input.domain);
    if (current.suspension === null) {
      throw new ApiException('ALREADY_TERMINAL', `${input.domain} is not suspended.`);
    }
    if (current.suspension.suspendedBy === input.actor) {
      throw new ApiException(
        'FORBIDDEN',
        'Four-eyes: the person who suspended a domain may not release it. A different ' +
          'authorised user must.',
      );
    }
    const next = releaseDomainSuspension(current);
    return this.commit(
      next,
      'domain:release',
      `${input.reason} (suspended by ${current.suspension.suspendedBy})`,
      input.actor,
      input.now,
      input.correlationId,
    );
  }

  private async commit(
    next: DomainHealth,
    action: string,
    reason: string,
    actor: string,
    now: Date,
    correlationId: string | undefined,
  ): Promise<DomainHealth> {
    return this.transactions.run(
      async (session) => {
        await this.save(next, now, session);
        await this.audit.append(
          {
            // Domain health belongs to no tenant, so it is audited under the platform trail.
            // See `platform-audit.ts` for why a shared record gets its own chain.
            tenantId: PLATFORM_AUDIT_TENANT_ID,
            actor: { type: 'USER', subject: actor, clientId: null },
            action,
            target: { type: 'DomainHealth', id: next.domain, version: 1 },
            reason,
            correlationId: correlationId ?? null,
            result: 'ALLOWED',
            now,
          },
          session,
        );
        return next;
      },
      { name: `domainHealth.${action}` },
    );
  }

  private async load(domain: string): Promise<DomainHealth> {
    const record = await this.domains.findOne({ _id: domain });
    return record === null ? newDomainHealth({ domain }) : toDomain(record);
  }

  private async save(
    health: DomainHealth,
    now: Date,
    session?: Parameters<AuditService['append']>[1],
  ): Promise<void> {
    const { domain, ...rest } = health;
    await this.domains.updateOne(
      { _id: domain },
      { $set: { ...rest, updatedAt: now } },
      { upsert: true, ...(session === undefined ? {} : { session }) },
    );
  }
}

function toDomain(record: DomainHealthRecord): DomainHealth {
  return {
    domain: record._id,
    breaker: record.breaker,
    openedAt: record.openedAt,
    halfOpenProbes: record.halfOpenProbes,
    consecutiveFailures: record.consecutiveFailures,
    lastFailureClass: record.lastFailureClass,
    lastFailureAt: record.lastFailureAt,
    lastSuccessAt: record.lastSuccessAt,
    degradedUntil: record.degradedUntil,
    suspension: record.suspension,
  };
}
