/**
 * C2 — the transaction retry policy, and the queue envelope contract.
 *
 * These are the parts that can be decided without a database, and they are the parts that are
 * easiest to get subtly wrong: what an error *means* is a classification, and a classification
 * is worth testing on its own rather than only through the behaviour it produces.
 */

import { describe, expect, it } from 'vitest';

import {
  backoffMs,
  classifyBodyError,
  classifyCommitError,
  DUPLICATE_KEY_CODE,
  TRANSIENT_LABEL,
  UNKNOWN_COMMIT_LABEL,
} from '../src/persistence/transaction.runner.js';
import { republishDelayMs, toEnvelope } from '../src/jobs/outbox-publisher.js';
import { verifyJobOwnership } from '../src/jobs/job-ownership.js';
import { parseEnvelope, JOB_ENVELOPE_VERSION, type JobEnvelope } from '../src/jobs/queue.port.js';

function mongoError(input: { code?: number; labels?: string[] }): {
  code?: number;
  hasErrorLabel: (label: string) => boolean;
} {
  return {
    ...(input.code === undefined ? {} : { code: input.code }),
    hasErrorLabel: (label: string) => (input.labels ?? []).includes(label),
  };
}

describe('transaction error classification', () => {
  it('retries the whole transaction after a write conflict', () => {
    expect(classifyBodyError(mongoError({ code: 112, labels: [TRANSIENT_LABEL] }))).toBe(
      'RETRY_TRANSACTION',
    );
  });

  it('never retries a duplicate key, even when it carries a transient label', () => {
    // A duplicate key inside a transaction can arrive labelled transient. Retrying it would
    // loop until the deadline and then report a timeout instead of the unique-index violation
    // that actually happened — and two services in this codebase *use* a duplicate key as
    // their "somebody already did this" signal.
    expect(
      classifyBodyError(mongoError({ code: DUPLICATE_KEY_CODE, labels: [TRANSIENT_LABEL] })),
    ).toBe('FAIL');
  });

  it('fails an unrecognised error rather than retrying it', () => {
    expect(classifyBodyError(mongoError({ code: 2 }))).toBe('FAIL');
  });

  it('retries the COMMIT, not the work, when the commit outcome is unknown', () => {
    // The property this whole runner exists for. The work may be committed; re-running the
    // body would commit it twice.
    expect(classifyCommitError(mongoError({ labels: [UNKNOWN_COMMIT_LABEL] }))).toBe(
      'RETRY_COMMIT',
    );
  });

  it('prefers "unknown outcome" over "transient" when a commit error carries both', () => {
    // An outcome we did not hear is not an outcome we know did not happen. The safe answer to
    // "we do not know" is to ask again, never to do it again.
    expect(
      classifyCommitError(mongoError({ labels: [UNKNOWN_COMMIT_LABEL, TRANSIENT_LABEL] })),
    ).toBe('RETRY_COMMIT');
  });

  it('restarts the transaction when a commit fails transiently and nothing committed', () => {
    expect(classifyCommitError(mongoError({ labels: [TRANSIENT_LABEL] }))).toBe(
      'RETRY_TRANSACTION',
    );
  });

  it('reads error labels from the array when hasErrorLabel is absent', () => {
    // Not every error the driver surfaces carries the helper method.
    expect(classifyBodyError({ errorLabels: [TRANSIENT_LABEL] })).toBe('RETRY_TRANSACTION');
    expect(classifyBodyError({ errorLabels: [] })).toBe('FAIL');
  });
});

describe('backoff', () => {
  it('uses full jitter from zero to the exponential ceiling', () => {
    expect(backoffMs(1, 0)).toBe(0);
    expect(backoffMs(3, 0.999)).toBeGreaterThan(0);
    expect(backoffMs(3, 0.999)).toBeLessThan(80);
  });

  it('caps the ceiling however many attempts have passed', () => {
    expect(backoffMs(50, 0.999)).toBeLessThan(500);
  });

  it('caps outbox republication too, so a dead queue does not produce an unbounded wait', () => {
    expect(republishDelayMs(50, 0.999)).toBeLessThan(5 * 60 * 1000);
    expect(republishDelayMs(1, 0)).toBe(0);
  });
});

describe('job envelope', () => {
  const valid: JobEnvelope = {
    envelopeVersion: JOB_ENVELOPE_VERSION,
    eventId: 'e1',
    eventType: 'search.queued',
    tenantId: 'tenant-alpha',
    aggregateType: 'SearchRun',
    aggregateId: 'run-1',
    aggregateRevision: 1,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    payload: { searchId: 'run-1' },
  };

  it('round-trips a well-formed envelope', () => {
    expect(parseEnvelope(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects malformed input rather than crashing or half-accepting it', () => {
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope('null')).toBeNull();
    expect(parseEnvelope('[]')).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...valid, tenantId: 42 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...valid, aggregateRevision: '1' }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...valid, payload: 'x' }))).toBeNull();
  });

  it('rejects an envelope from an unknown version', () => {
    // A producer on a newer contract must go to the DLQ, not be half-read by an older
    // consumer that happens to recognise the fields it knows.
    expect(parseEnvelope(JSON.stringify({ ...valid, envelopeVersion: 2 }))).toBeNull();
  });

  it('carries the aggregate revision, so a receiver can discard a stale delivery', () => {
    const envelope = toEnvelope({
      tenantId: 'tenant-alpha',
      eventId: 'e1',
      eventType: 'search.queued',
      aggregateType: 'SearchRun',
      aggregateId: 'run-1',
      aggregateRevision: 7,
      payload: {},
      correlationId: null,
      occurredAt: new Date('2026-09-11T00:00:00.000Z'),
      publishedAt: null,
      attempt: 0,
      nextAttemptAt: new Date('2026-09-11T00:00:00.000Z'),
      lastError: null,
    });
    expect(envelope.aggregateRevision).toBe(7);
    expect(envelope.occurredAt).toBe('2026-09-11T00:00:00.000Z');
  });
});

describe('job ownership (SEC-01)', () => {
  const envelope: JobEnvelope = {
    envelopeVersion: JOB_ENVELOPE_VERSION,
    eventId: 'e1',
    eventType: 'search.queued',
    tenantId: 'tenant-alpha',
    aggregateType: 'SearchRun',
    aggregateId: 'run-1',
    aggregateRevision: 3,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    payload: {},
  };

  it('accepts a message whose aggregate really is owned by the claimed tenant', async () => {
    const verdict = await verifyJobOwnership({
      envelope,
      load: () => Promise.resolve({ tenantId: 'tenant-alpha', revision: 3 }),
    });
    expect(verdict.kind).toBe('OWNED');
  });

  it('refuses a forged tenant instead of doing that tenant work', async () => {
    // The attack this exists to stop: a message claiming tenant-beta for a run that belongs to
    // tenant-alpha. Loading by aggregate ID alone means the claim is checked, not obeyed.
    const verdict = await verifyJobOwnership({
      envelope: { ...envelope, tenantId: 'tenant-beta' },
      load: () => Promise.resolve({ tenantId: 'tenant-alpha', revision: 3 }),
    });
    expect(verdict.kind).toBe('TENANT_MISMATCH');
  });

  it('does not let the loader be scoped by the value under test', async () => {
    // A loader given the envelope's tenant would report NOT_FOUND for a forged tenant, which
    // reads like a harmless replay rather than an attempted crossing. This asserts the loader
    // is called with the aggregate ID and nothing else.
    const seen: unknown[] = [];
    await verifyJobOwnership({
      envelope: { ...envelope, tenantId: 'tenant-beta' },
      load: (...args) => {
        seen.push(args);
        return Promise.resolve({ tenantId: 'tenant-alpha' });
      },
    });
    expect(seen).toEqual([['run-1']]);
  });

  it('reports a missing aggregate rather than inventing one', async () => {
    const verdict = await verifyJobOwnership({ envelope, load: () => Promise.resolve(null) });
    expect(verdict.kind).toBe('NOT_FOUND');
  });

  it('discards a delivery older than the state already applied (T31)', async () => {
    const verdict = await verifyJobOwnership({
      envelope: { ...envelope, aggregateRevision: 2 },
      load: () => Promise.resolve({ tenantId: 'tenant-alpha', revision: 5 }),
    });
    expect(verdict.kind).toBe('STALE_REVISION');
  });

  it('accepts a delivery for a revision newer than the record, which is normal', async () => {
    // The record is read after the event was published; it can legitimately be behind.
    const verdict = await verifyJobOwnership({
      envelope: { ...envelope, aggregateRevision: 9 },
      load: () => Promise.resolve({ tenantId: 'tenant-alpha', revision: 5 }),
    });
    expect(verdict.kind).toBe('OWNED');
  });
});
