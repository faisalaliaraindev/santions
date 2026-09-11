/**
 * C4 — tests for the pure half of the workload harness.
 *
 * The benchmark itself needs a running index and lives in `scripts/workload`. What is tested
 * here is everything the benchmark's *numbers* depend on: the percentile arithmetic, the
 * refusal to report recall for a class that was never queried, and the properties of the
 * generated population that make a recall figure mean something.
 *
 * This matters more than it looks. A benchmark is self-reporting — nothing downstream checks
 * its output — so the arithmetic underneath it is the only thing standing between a plausible
 * table and a wrong decision recorded as evidence.
 */

import { describe, expect, it } from 'vitest';

import { normaliseName } from '@erly/adverse-domain';

import { SEED_DATASET } from '../../src/dataset/seed.js';
import {
  QUERY_CLASSES,
  generateWorkloadPopulation,
  type QueryClass,
} from '../../src/workload/population.js';
import { isDecisive, quantile, recallOf, summarise } from '../../src/workload/stats.js';

describe('latency statistics', () => {
  it('reports quantiles by nearest rank, so every figure is an observation that happened', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const summary = summarise(samples);

    expect(summary.count).toBe(100);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(100);
    expect(summary.p50).toBe(50);
    expect(summary.p90).toBe(90);
    expect(summary.p95).toBe(95);
    expect(summary.p99).toBe(99);
    // Every reported quantile is a member of the sample, not an interpolation between two.
    for (const value of [summary.p50, summary.p90, summary.p95, summary.p99]) {
      expect(samples).toContain(value);
    }
  });

  it('does not let a well-behaved mean hide a bad tail', () => {
    // Ninety-nine fast requests and one that takes a second: the mean says 20 ms.
    const samples = [...Array.from({ length: 99 }, () => 10), 1000];
    const summary = summarise(samples);

    expect(summary.mean).toBeCloseTo(19.9, 1);
    expect(summary.p99).toBe(10);
    expect(summary.max).toBe(1000);
  });

  it('returns NaN rather than a confident zero for an empty sample', () => {
    const summary = summarise([]);
    expect(summary.count).toBe(0);
    expect(Number.isNaN(summary.p95)).toBe(true);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it('clamps the quantile rank inside the sample', () => {
    expect(quantile([1, 2, 3], 0)).toBe(1);
    expect(quantile([1, 2, 3], 1)).toBe(3);
  });
});

describe('deciding whether a measurement decides anything', () => {
  it('calls a difference inside the noise margin indecisive', () => {
    const a = summarise(Array.from({ length: 100 }, () => 10));
    const b = summarise(Array.from({ length: 100 }, () => 11));
    const verdict = isDecisive(a, b);

    expect(verdict.ratio).toBeCloseTo(1.1, 2);
    expect(verdict.decisive).toBe(false);
  });

  it('calls a difference beyond the margin decisive', () => {
    const a = summarise(Array.from({ length: 100 }, () => 10));
    const b = summarise(Array.from({ length: 100 }, () => 40));
    const verdict = isDecisive(a, b);

    expect(verdict.ratio).toBeCloseTo(4, 2);
    expect(verdict.decisive).toBe(true);
  });

  it('is not decisive when either side has no samples', () => {
    expect(isDecisive(summarise([]), summarise([1, 2, 3])).decisive).toBe(false);
  });
});

describe('recall', () => {
  it('reports the fraction found', () => {
    expect(recallOf([true, true, false, true]).recall).toBeCloseTo(0.75, 5);
  });

  it('reports NaN, never 1, for a class nothing was queried in', () => {
    const result = recallOf([]);
    expect(result.attempted).toBe(0);
    // The dangerous alternative would be a 100% that means "untested".
    expect(Number.isNaN(result.recall)).toBe(true);
  });
});

describe('the generated population', () => {
  const population = generateWorkloadPopulation({ size: 2000, seed: 1 });

  it('is deterministic for a seed', () => {
    const again = generateWorkloadPopulation({ size: 2000, seed: 1 });
    expect(again.subjects.map((s) => s.nameOriginal)).toEqual(
      population.subjects.map((s) => s.nameOriginal),
    );
    expect(again.queries).toEqual(population.queries);
  });

  it('differs for a different seed, so one lucky corpus cannot be mistaken for a result', () => {
    const other = generateWorkloadPopulation({ size: 2000, seed: 2 });
    expect(other.subjects.map((s) => s.nameOriginal)).not.toEqual(
      population.subjects.map((s) => s.nameOriginal),
    );
  });

  it('reaches the requested size with unique index keys', () => {
    expect(population.size).toBe(2000);
    expect(new Set(population.subjects.map((s) => s.subjectVersionId)).size).toBe(2000);
  });

  it('holds every query target, so recall is measurable rather than notional', () => {
    const ids = new Set(population.subjects.map((s) => s.subjectVersionId));
    expect(population.queries.length).toBeGreaterThan(0);
    for (const query of population.queries) {
      expect(ids.has(query.expectedSubjectVersionId)).toBe(true);
    }
  });

  it('derives queries from the FR-16 corpus, not from invented names', () => {
    const caseIds = new Set(SEED_DATASET.cases.map((c) => c.caseId));
    for (const query of population.queries) {
      expect(caseIds.has(query.caseId)).toBe(true);
    }
  });

  it('covers every FR-08 query class', () => {
    const covered = new Set<QueryClass>(population.queries.map((q) => q.class));
    for (const cls of QUERY_CLASSES) {
      expect(covered.has(cls)).toBe(true);
    }
  });

  it('never issues a query identical to the indexed name except in the EXACT class', () => {
    // A "phonetic" query that is character-identical to the stored name measures exact match
    // and reports it as phonetic recall — the derivation returns null instead, and this is the
    // assertion that keeps that true.
    const byId = new Map(population.subjects.map((s) => [s.subjectVersionId, s]));
    for (const query of population.queries) {
      if (query.class === 'EXACT') {
        continue;
      }
      const target = byId.get(query.expectedSubjectVersionId);
      expect(target?.nameOriginal).not.toBe(query.text);
    }
  });

  it('crowds each target with lookalikes, so retrieval has to discriminate', () => {
    // The FR-16 name must not be unique in the haystack: at least one other subject folds to
    // the same string, and more than one shares its surname.
    const folded = new Map<string, number>();
    for (const subject of population.subjects) {
      folded.set(subject.nameFolded, (folded.get(subject.nameFolded) ?? 0) + 1);
    }
    for (const labelled of SEED_DATASET.cases) {
      const key = normaliseName(labelled.subjectName).folded;
      expect(folded.get(key) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('carries the derived name forms the index searches, not the raw name alone', () => {
    for (const subject of population.subjects.slice(0, 200)) {
      expect(subject.nameFolded).not.toBe('');
      expect(subject.sortedCoreKey).not.toBe('');
      expect(subject.phoneticKeys.length).toBeGreaterThan(0);
      expect(subject.scripts.length).toBeGreaterThan(0);
    }
  });

  it('puts a non-Latin query in the set, because that is the form a Latin index handles worst', () => {
    const transliteration = population.queries.filter((q) => q.class === 'TRANSLITERATION');
    expect(transliteration.length).toBeGreaterThan(0);
    for (const query of transliteration) {
      expect(/[\p{Script=Latin}]/u.test(query.text)).toBe(false);
    }
  });
});
