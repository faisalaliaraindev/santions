/** FR-08 name-form matching. Test T13. */

import { describe, expect, it } from 'vitest';

import {
  detectScripts,
  matchNameForms,
  normaliseName,
  phoneticKey,
} from '../../src/identity/name-forms.js';

const n = normaliseName;

describe('normaliseName', () => {
  it('preserves the original value untouched', () => {
    const name = n('Ahmed Al-Fâyed');
    expect(name.original).toBe('Ahmed Al-Fâyed');
    expect(name.folded).toBe('ahmed al-fayed');
  });

  it('classifies particles, affixes and initials', () => {
    const name = n('Dr. Jan van der Berg');
    const kinds = Object.fromEntries(name.tokens.map((t) => [t.folded, t.kind]));
    expect(kinds['dr']).toBe('AFFIX');
    expect(kinds['van']).toBe('PARTICLE');
    expect(kinds['der']).toBe('PARTICLE');
    expect(kinds['berg']).toBe('CORE');
  });

  it('detects scripts for non-Latin names', () => {
    expect(detectScripts('محمد الأحمد')).toContain('Arabic');
    expect(detectScripts('Владимир Петров')).toContain('Cyrillic');
    expect(detectScripts('李小龍')).toContain('Han');
  });

  it('splits hyphenated names into both the whole and the parts', () => {
    const name = n('Anne-Marie Dupont');
    const folded = name.tokens.map((t) => t.folded);
    expect(folded).toContain('anne-marie');
    expect(folded).toContain('anne');
    expect(folded).toContain('marie');
  });
});

describe('matchNameForms', () => {
  it('matches exact names', () => {
    expect(matchNameForms(n('Rhys Mordaunt'), n('Rhys Mordaunt')).form).toBe('EXACT');
  });

  it('T13 — matches across diacritics without merging different names', () => {
    expect(matchNameForms(n('José García'), n('Jose Garcia')).form).toBe('EXACT');
    expect(matchNameForms(n('Jose Garcia'), n('Jose Gutierrez')).form).toBe('NO_MATCH');
  });

  it('tolerates word order', () => {
    const match = matchNameForms(n('Mordaunt Rhys'), n('Rhys Mordaunt'));
    expect(match.form).toBe('EXACT_WORD_ORDER_VARIANT');
  });

  it('distinguishes a particle variant from a plain reordering', () => {
    expect(matchNameForms(n('Jan Berg'), n('Jan van Berg')).form).toBe('PARTICLE_VARIANT');
  });

  it('expands initials', () => {
    expect(matchNameForms(n('R. Mordaunt'), n('Rhys Mordaunt')).form).toBe('INITIAL_EXPANSION');
    expect(matchNameForms(n('Rhys Mordaunt'), n('R. Mordaunt')).form).toBe('INITIAL_EXPANSION');
    // A wrong initial is not a match.
    expect(matchNameForms(n('K. Mordaunt'), n('Rhys Mordaunt')).form).toBe('NO_MATCH');
  });

  it('handles patronymic chains as a subset match, not an exact one', () => {
    const match = matchNameForms(n('Ahmed Hassan Ibrahim'), n('Ahmed Hassan'));
    expect(match.form).toBe('SUBSET_PATRONYMIC');
  });

  it('does not treat a shared surname as a patronymic subset', () => {
    // Different first names: the first token must agree.
    expect(matchNameForms(n('Ahmed Hassan Ibrahim'), n('Yusuf Hassan Ibrahim')).form).toBe(
      'NO_MATCH',
    );
  });

  it('records the matched form and its script for display', () => {
    const match = matchNameForms(n('Владимир Петров'), n('Владимир Петров'));
    expect(match.form).toBe('EXACT');
    expect(match.matchedForm).toBe('Владимир Петров');
    expect(match.matchedScripts).toContain('Cyrillic');
  });

  it('does not cross scripts on its own — that is the transliteration port’s job', () => {
    // This package is pure, so it holds no ICU transliterator. Asserting NO_MATCH here is the
    // contract: cross-script matching goes through matchAcrossScripts with a real port.
    expect(matchNameForms(n('Vladimir Petrov'), n('Владимир Петров')).form).toBe('NO_MATCH');
  });

  it('returns NO_MATCH for genuinely different names', () => {
    expect(matchNameForms(n('Elin Lindqvist'), n('Camila Vasquez')).form).toBe('NO_MATCH');
  });
});

describe('phoneticKey', () => {
  it('collapses common spelling variants', () => {
    expect(phoneticKey('Smith')).toBe(phoneticKey('Smyth'));
    expect(phoneticKey('Philip')).toBe(phoneticKey('Filip'));
  });

  it('keeps a leading vowel, which distinguishes many names', () => {
    expect(phoneticKey('Ahmed')).not.toBe(phoneticKey('Mohammed'));
  });

  it('returns an empty key for a non-Latin token rather than a misleading one', () => {
    expect(phoneticKey('محمد')).toBe('');
  });
});
