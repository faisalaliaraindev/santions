/**
 * FR-03 lexicon audit — fails the build if any query term maps to a protected
 * characteristic (test T79).
 *
 * This is a data-protection control (SEC-05), not a relevance control. A protected
 * characteristic must never leave the service as an outbound query term, and must never be
 * stored as a finding attribute.
 */

import { PROTECTED_CHARACTERISTIC_STEMS } from './categories.js';
import type { LexiconTerm, TaxonomyVersion } from './types.js';

export interface LexiconAuditViolation {
  readonly term: string;
  readonly language: string;
  readonly kind: LexiconTerm['kind'];
  /** The protected-characteristic stem the term matched. */
  readonly matchedStem: string;
}

export interface LexiconAuditResult {
  readonly passed: boolean;
  readonly violations: readonly LexiconAuditViolation[];
  readonly termsChecked: number;
}

/**
 * Fold to a comparison form: lowercase, strip diacritics, collapse punctuation to single
 * spaces. Keeps the audit from being defeated by "Trans-gender" or "Müslim".
 */
function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Remove every separator, so "Trans-gender" and "trans gender" both reduce to "transgender". */
function compact(folded: string): string {
  return folded.replace(/\s+/gu, '');
}

/**
 * Match on word boundaries so "race" flags but "trace", "bracelet" and "grace" do not, while
 * multi-word stems ("sexual orientation") still match as a phrase.
 *
 * Also checked against a separator-free form of both sides: a lexicon author writing
 * "Trans-gender" or "trans gender" must not slip past a stem written as one word.
 */
function containsStem(foldedTerm: string, foldedStem: string): boolean {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (new RegExp(`(?:^|\\s)${escape(foldedStem)}(?:\\s|$)`, 'u').test(foldedTerm)) {
    return true;
  }

  // Only apply the compacted check to single-word stems. Compacting a multi-word stem such as
  // "sexual orientation" would make it match unrelated concatenations.
  const compactStem = compact(foldedStem);
  if (compactStem !== foldedStem) {
    return false;
  }
  return new RegExp(`(?:^|\\b)${escape(compactStem)}(?:\\b|$)`, 'u').test(compact(foldedTerm));
}

export function auditLexicon(
  terms: readonly LexiconTerm[],
  stems: readonly string[] = PROTECTED_CHARACTERISTIC_STEMS,
): LexiconAuditResult {
  const foldedStems = stems.map((s) => ({ raw: s, folded: fold(s) }));
  const violations: LexiconAuditViolation[] = [];

  for (const term of terms) {
    const foldedTerm = fold(term.term);
    for (const stem of foldedStems) {
      if (containsStem(foldedTerm, stem.folded)) {
        violations.push({
          term: term.term,
          language: term.language,
          kind: term.kind,
          matchedStem: stem.raw,
        });
        break;
      }
    }
  }

  return { passed: violations.length === 0, violations, termsChecked: terms.length };
}

export function auditTaxonomy(taxonomy: TaxonomyVersion): LexiconAuditResult {
  return auditLexicon(taxonomy.lexicon);
}

/** Throwing form, for use in CI and at taxonomy activation. */
export function assertLexiconClean(terms: readonly LexiconTerm[]): void {
  const result = auditLexicon(terms);
  if (!result.passed) {
    const detail = result.violations
      .map(
        (v) => `  "${v.term}" (${v.language}, ${v.kind}) matches protected stem "${v.matchedStem}"`,
      )
      .join('\n');
    throw new Error(
      `Lexicon audit failed: ${String(result.violations.length)} term(s) map to a protected characteristic.\n${detail}`,
    );
  }
}
