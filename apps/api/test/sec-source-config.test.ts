/**
 * The SEC litigation-releases source configuration — the record **D17** names.
 *
 * This is a proposal, not an activation: nothing here puts a source in the registry, and the
 * named approval D17 requires is an act of the source admin through the D1 lifecycle. What these
 * tests protect is that the record is **submittable and honest** — that it satisfies the FR-05
 * schema an approver's submission is checked against, and that it does not claim anything no
 * request has established.
 *
 * **No live request has been made to the SEC or to any other source.**
 */

import { describe, expect, it } from 'vitest';

import { sourceContentSchema } from '@adverse-search/contracts';

import {
  SEC_LITIGATION_RELEASES_CONTENT,
  SEC_LITIGATION_RELEASES_SOURCE_ID,
  SEC_POLL_FLOOR_MS,
  SEC_REQUEST_CEILING_PER_SECOND,
  SEC_STOP_CONDITIONS,
  secLitigationReleasesContent,
} from '../src/sources/registry/sec-litigation-releases.js';

describe('the proposed source version', () => {
  it('satisfies the FR-05 schema an approver would submit it against', () => {
    // A seeded record that does not conform is one an administrator can look at and never put
    // through an approval. Checked here so the failure lands on the person writing the record.
    expect(() => secLitigationReleasesContent()).not.toThrow();
    expect(sourceContentSchema.safeParse(SEC_LITIGATION_RELEASES_CONTENT).success).toBe(true);
  });

  it('records the fair-access policy as numbers, not as prose alone', () => {
    const content = secLitigationReleasesContent();
    const policy = content['accessPolicy'] as Record<string, unknown>;

    expect(policy['requestCeilingPerSecond']).toBe(SEC_REQUEST_CEILING_PER_SECOND);
    expect(policy['pollFloorSeconds']).toBe(SEC_POLL_FLOOR_MS / 1000);
    expect(policy['conditionalGet']).toBe(true);
    expect(policy['userAgentRequired']).toBe(true);
    // The summary is what the approver read. A link they might have read is not a record.
    expect(String(policy['policySummary'])).toContain('403');
    expect(String(policy['policySummary'])).toContain('429');
  });

  it('polls at roughly a thousandth of the ceiling it records', () => {
    // The distance between what is permitted and what is done, as a number somebody can check.
    const pollsPerSecond = 1 / (SEC_POLL_FLOOR_MS / 1000);
    expect(pollsPerSecond).toBeLessThan(SEC_REQUEST_CEILING_PER_SECOND / 500);
  });

  it('carries the named first-contact approval D17 requires', () => {
    const policy = secLitigationReleasesContent()['accessPolicy'] as Record<string, unknown>;
    const approval = policy['firstContactApproval'] as Record<string, unknown>;
    expect(approval['approvedBy']).toBe('Faisal Ali');
    expect(approval['decision']).toBe('D17');
    expect(approval['approvedOn']).toBe('2026-09-15');
  });

  it('keeps the recorded stop conditions and the domain constant in step', () => {
    // Two spellings of one policy would be a stop condition somebody believes is in force and
    // is not. The registry record is what runs; this asserts the constant matches it.
    const policy = secLitigationReleasesContent()['accessPolicy'] as Record<string, unknown>;
    const stop = policy['stopConditions'] as Record<string, unknown>;

    expect(stop['haltOnStatuses']).toEqual([...SEC_STOP_CONDITIONS.haltOnStatuses]);
    expect(stop['haltOnRateLimit']).toBe(SEC_STOP_CONDITIONS.haltOnRateLimit);
    expect(stop['rateLimitCooldownSeconds']).toBe(SEC_STOP_CONDITIONS.rateLimitCooldownMs / 1000);
    expect(stop['serverErrorStreakToHalt']).toBe(SEC_STOP_CONDITIONS.serverErrorStreakToHalt);
    expect(stop['requiresFreshApprovalOnHalt']).toBe(
      SEC_STOP_CONDITIONS.requiresFreshApprovalOnHalt,
    );
  });
});

describe('what the record does not claim', () => {
  it('records the robots position as NOT_ESTABLISHED, because nobody has read their robots.txt', () => {
    // The honest value today. Recording HONOURED would put a check that has not happened into
    // the record the fetch gate reads — and the fetch gate refuses NOT_ESTABLISHED, so the
    // source cannot be fetched until the position is established by actually reading it.
    expect(SEC_LITIGATION_RELEASES_CONTENT.robotsPosition).toBe('NOT_ESTABLISHED');
  });

  it('declares the feed volatile, however documented the institution is', () => {
    // The class is a statement about the feed shape we parse, not about the SEC. Claiming
    // DOCUMENTED_STABLE would exempt this source from the scheduled contract test that detects
    // a silent shape change (T84) — the failure that drops recall to zero while the service
    // keeps reporting clean results.
    expect(SEC_LITIGATION_RELEASES_CONTENT.stabilityClass).toBe('UNDOCUMENTED_VOLATILE');
  });

  it('declares US coverage and is not Costa Rican coverage', () => {
    // D-010 enables Costa Rica. This source proves the live path; it does not cover CR, and a
    // coverage view grouping by country must not be able to read it as though it did.
    expect(SEC_LITIGATION_RELEASES_CONTENT.countries).toEqual(['US']);
    expect(SEC_LITIGATION_RELEASES_SOURCE_ID).toContain('sec');
  });

  it('budgets a backstop well above the poll rate and well below a runaway', () => {
    // Four polls an hour at the floor, plus a robots read on a cold cache. Six leaves room for
    // that and no room for a loop: a mistake exhausts the budget and becomes a recorded
    // coverage gap rather than an incident at the publisher.
    expect(SEC_LITIGATION_RELEASES_CONTENT.freeTierHourlyBudget).toBeGreaterThan(4);
    expect(SEC_LITIGATION_RELEASES_CONTENT.freeTierHourlyBudget).toBeLessThan(20);
    expect(SEC_LITIGATION_RELEASES_CONTENT.freeTierDailyBudget).toBeGreaterThan(96);
  });
});
