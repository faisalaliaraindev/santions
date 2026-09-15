/**
 * Walking the FR-05 ladder — Phase E step 3.
 *
 * `packages/domain/src/planning/cascade.ts` holds the table and every decision about it: which
 * rung is next, what stops the walk, what counts as a gap, what a gap says in coverage. This file
 * does the I/O and nothing else — it asks each rung's sources, feeds health back, and hands the
 * attempts to the domain to be summarised.
 *
 * # The ladder is built from the registry, not from code
 *
 * A rung is served by whichever **approved source versions** record that `cascadeRung`. So the
 * ladder is different in mock mode and in live mode, and different again after an administrator
 * activates a source — without a deployment, and without this file knowing the difference.
 *
 * The consequence worth stating: **a rung nothing is approved for reports `NO_SOURCE`, which is a
 * gap.** In mock mode today that is rungs 0, 3 and 4 — there is no local-index adapter, no GDELT
 * adapter and no Bing adapter — and reporting them as gaps is simply true. A cascade that
 * silently skipped the rungs it has no source for would let a one-source deployment claim it
 * climbed the whole ladder.
 *
 * # Health is asked per rung, per query, at the point of use
 *
 * Not once per run. D5's kill switch is only effective mid-run because the answer is re-read
 * immediately before each call, and a breaker that opened on the previous query has to remove its
 * rung from *this* one. The check is **non-spending**: the adapter that opens the socket spends
 * the budget (D-035), and spending here as well would drain it at a rate unrelated to the traffic
 * the publisher sees.
 *
 * # Every lead is attributed to the rung on the lead
 *
 * Not to the rung being asked. A source can legitimately answer with material from more than one
 * rung — the mock news fixture serves rungs 2 to 4 from one call — and the honest record is the
 * one the adapter stamped. Deduplication is global across the walk, so the same story reached
 * from two rungs is one lead, which is what stops axis D counting one story as two independent
 * sources (FR-10).
 */

import { Logger } from '@nestjs/common';

import {
  CASCADE_RUNGS,
  TERMINAL_RUNG,
  cascadeCoverageOutcomes,
  describeAttempt,
  nextRung,
  rungSpec,
  summariseCascade,
  type CascadeRung,
  type RungAttempt,
  type SourceCoverageOutcome,
} from '@erly/adverse-domain';

import type { DiscoveryQuery, Lead } from '../sources/lead.js';
import { hasData, type SourceOutcome } from '../sources/source-adapter.js';
import type { SourceHealthService } from '../sources/source-health.service.js';

/**
 * One thing the ladder can ask, at one rung.
 *
 * A closure rather than a port, because the four kinds of discovery are asked differently —
 * `discover`, `search` with an engine mix, `siteSearch` with a domain, and the primary-source
 * seam — and a union type here would push that difference into every call site. What the cascade
 * needs is uniform: a rung, a source to charge and name, and something to await.
 */
export interface LadderEntry {
  readonly rung: CascadeRung;
  readonly sourceId: string;
  readonly sourceName: string;
  ask(query: DiscoveryQuery): Promise<SourceOutcome<readonly Lead[]>>;
}

export interface CascadeWalk {
  /** Deduplicated across the whole walk, on the canonicalised URL the adapter produced. */
  readonly leads: readonly Lead[];
  readonly attempts: readonly RungAttempt[];
  readonly rungReached: CascadeRung | null;
  /** The gaps, in the run's coverage vocabulary. Empty when every rung answered. */
  readonly coverageOutcomes: readonly SourceCoverageOutcome[];
  readonly stoppedEarly: boolean;
}

/** The slice of source health the cascade uses. Narrow: it may ask and report, not suspend. */
export interface CascadeHealthPort {
  checkAccess: SourceHealthService['checkAccess'];
  recordFailure: SourceHealthService['recordFailure'];
  recordSuccess: SourceHealthService['recordSuccess'];
}

export class CascadeService {
  private readonly logger = new Logger('Cascade');

  constructor(private readonly health: CascadeHealthPort) {}

  /**
   * Walk the ladder for one planned query.
   *
   * Returns everything found and everything that went wrong. It never throws for a source
   * failing: a failure is a recorded gap, and an exception here would lose the rungs that did
   * answer along with the one that did not.
   */
  async walk(input: {
    readonly ladder: readonly LadderEntry[];
    readonly query: DiscoveryQuery;
    readonly queriesAffected: number;
    readonly now: Date;
  }): Promise<CascadeWalk> {
    const byUrl = new Map<string, Lead>();
    const attempts: RungAttempt[] = [];

    let rung: CascadeRung | null = 0;
    while (rung !== null) {
      if (rung === TERMINAL_RUNG) {
        // The terminus is not a source. Reaching it is the normal end of a walk and is recorded
        // so that "we climbed the whole ladder" is distinguishable from "we stopped at rung 4".
        break;
      }

      const entries = input.ladder.filter((entry) => entry.rung === rung);
      if (entries.length === 0) {
        attempts.push({
          rung,
          sourceId: null,
          sourceName: rungSpec(rung).label,
          outcome: 'NO_SOURCE',
          candidates: 0,
          detail: null,
          queriesAffected: input.queriesAffected,
        });
        rung = nextRung({ current: rung, failed: false });
        continue;
      }

      let rungFailed = false;
      for (const entry of entries) {
        const attempt = await this.askOne({
          entry,
          query: input.query,
          queriesAffected: input.queriesAffected,
          now: input.now,
          collect: byUrl,
        });
        attempts.push(attempt);
        this.logger.debug(describeAttempt(attempt));
        if (attempt.outcome === 'FAILED') {
          rungFailed = true;
        }
      }

      // `stopsCascade` is rung 6's "record and stop". Every other rung descends however it went,
      // because FR-05's column says so for each of them — and because stopping early on a
      // failure at rung 2 would silently narrow every subsequent run's coverage.
      rung = nextRung({ current: rung, failed: rungFailed });
    }

    const summary = summariseCascade(attempts);
    return {
      leads: [...byUrl.values()],
      attempts,
      rungReached: summary.rungReached,
      coverageOutcomes: cascadeCoverageOutcomes(attempts),
      stoppedEarly: summary.stoppedEarly,
    };
  }

  /** Ask one source at one rung, feed health back, and record what happened. */
  private async askOne(input: {
    readonly entry: LadderEntry;
    readonly query: DiscoveryQuery;
    readonly queriesAffected: number;
    readonly now: Date;
    readonly collect: Map<string, Lead>;
  }): Promise<RungAttempt> {
    const { entry } = input;

    // Point of use, and non-spending. See the file header.
    const access = await this.health.checkAccess({
      sourceId: entry.sourceId,
      now: input.now,
      queriesAffected: input.queriesAffected,
      spend: false,
    });
    if (!access.decision.allowed) {
      return {
        rung: entry.rung,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        outcome: 'REFUSED',
        candidates: 0,
        detail: access.decision.detail,
        queriesAffected: input.queriesAffected,
      };
    }

    let result: SourceOutcome<readonly Lead[]>;
    try {
      result = await entry.ask(input.query);
    } catch (error) {
      // An adapter that throws is a defect, not a coverage outcome — but losing the rest of the
      // ladder to it would turn one bug into a run-wide blackout. Recorded as a failure with the
      // message, which is what a reviewer needs and what an operator will grep for.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`${entry.sourceId} threw at rung ${String(entry.rung)}: ${detail}`);
      return {
        rung: entry.rung,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        outcome: 'FAILED',
        candidates: 0,
        detail,
        queriesAffected: input.queriesAffected,
      };
    }

    if (result.status === 'FAILED') {
      // Through the FR-06 table, so a source failing this run is already refused on the next.
      await this.health.recordFailure({
        sourceId: entry.sourceId,
        signal: result.signal,
        now: input.now,
      });
      return {
        rung: entry.rung,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        outcome: 'FAILED',
        candidates: 0,
        detail: result.detail,
        queriesAffected: input.queriesAffected,
      };
    }

    await this.health.recordSuccess({ sourceId: entry.sourceId, now: input.now });

    if (!hasData(result)) {
      // The source answered and had nothing. The rung was reached; this is not a gap.
      return {
        rung: entry.rung,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        outcome: 'EMPTY',
        candidates: 0,
        detail: null,
        queriesAffected: input.queriesAffected,
      };
    }

    // Count only what this rung contributed, and attribute on the lead's own rung — a source may
    // legitimately answer with material from more than one. Deduplication is global, so a story
    // reached twice is one lead (FR-10).
    let contributed = 0;
    for (const lead of result.data) {
      if (lead.rung === entry.rung) {
        contributed += 1;
      }
      if (!input.collect.has(lead.url)) {
        input.collect.set(lead.url, lead);
      }
    }

    return {
      rung: entry.rung,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      // A source that answered with material for other rungs and none for this one has still
      // been consulted at this rung. `EMPTY`, not a gap.
      outcome: contributed > 0 ? 'FOUND' : 'EMPTY',
      candidates: contributed,
      detail:
        result.status === 'BOUNDED'
          ? `Bounded at ${String(result.truncation.limit)} of ` +
            `${String(result.truncation.availableCount ?? 'an unknown number of')} available.`
          : null,
      queriesAffected: input.queriesAffected,
    };
  }
}

/** Every rung the FR-05 table defines, for a caller building a ladder. */
export const ALL_RUNGS = CASCADE_RUNGS;
