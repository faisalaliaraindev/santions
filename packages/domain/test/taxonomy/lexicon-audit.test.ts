/** FR-03 lexicon audit — test T79. A protected-characteristic term must fail the build. */

import { describe, expect, it } from 'vitest';

import { assertLexiconClean, auditLexicon } from '../../src/taxonomy/lexicon-audit.js';
import type { LexiconTerm } from '../../src/taxonomy/types.js';

function term(value: string, kind: LexiconTerm['kind'] = 'CONDUCT'): LexiconTerm {
  return { term: value, language: 'en', kind, category: 'FRAUD_FINANCIAL_CRIME', rank: 1 };
}

describe('auditLexicon', () => {
  it('passes a clean conduct lexicon', () => {
    const result = auditLexicon([term('embezzlement'), term('money laundering'), term('bribery')]);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.termsChecked).toBe(3);
  });

  it('T79 — fails when a term maps to a protected characteristic', () => {
    const result = auditLexicon([term('embezzlement'), term('muslim businessman')]);
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.term).toBe('muslim businessman');
    expect(result.violations[0]?.matchedStem).toBe('muslim');
  });

  it.each([
    ['political opinion', 'political opinion'],
    ['trade union organiser', 'trade union'],
    ['transgender', 'transgender'],
    ['mental illness', 'mental illness'],
    ['opposition party financier', 'opposition party'],
  ])('flags %s across every protected class', (value, stem) => {
    const result = auditLexicon([term(value)]);
    expect(result.passed, `"${value}" should be flagged`).toBe(false);
    expect(result.violations[0]?.matchedStem).toBe(stem);
  });

  it('is not defeated by diacritics, case or punctuation', () => {
    for (const variant of ['Müslim', 'MUSLIM', 'muslim,', 'Trans-gender']) {
      expect(auditLexicon([term(variant)]).passed, variant).toBe(false);
    }
  });

  it('matches on word boundaries, so ordinary terms are not false positives', () => {
    // "race" is a protected stem; "trace", "embrace" and "racketeering" must not match it.
    const result = auditLexicon([term('trace of funds'), term('embrace'), term('racketeering')]);
    expect(result.passed).toBe(true);
  });

  it('audits procedural terms and authority names too, not only conduct terms', () => {
    const result = auditLexicon([term('activist detained', 'PROCEDURAL')]);
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.kind).toBe('PROCEDURAL');
  });

  it('assertLexiconClean throws with every violation named', () => {
    expect(() => {
      assertLexiconClean([term('fraud'), term('jewish trader'), term('gay rights')]);
    }).toThrow(/2 term\(s\) map to a protected characteristic/);
  });

  it('assertLexiconClean is silent on a clean lexicon', () => {
    expect(() => {
      assertLexiconClean([term('fraud'), term('insider dealing')]);
    }).not.toThrow();
  });
});
