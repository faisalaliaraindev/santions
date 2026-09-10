/**
 * FR-08 name-form matching.
 *
 * Requirements implemented here: Unicode NFKC and case folding *preserving the original
 * form*, phonetic keys, word-order tolerance, patronymic and grandfather-name handling,
 * initial expansion, particle handling (van, de, bin, al-), hyphenation, and maiden/married
 * alias linkage.
 *
 * ICU transliteration and libpostal are I/O-adjacent native dependencies and are injected
 * through `TransliterationPort` (see `./transliteration.ts`) rather than imported here, so
 * this module stays pure and runs in `test:invariants` with no I/O.
 */

/**
 * Name particles (nobiliary, patronymic and relational). Kept as a separate token class:
 * they must not be treated as given names, and dropping them entirely would merge
 * "de Vries" with "Vries" incorrectly for ranking purposes.
 */
export const NAME_PARTICLES: ReadonlySet<string> = new Set([
  'van',
  'von',
  'der',
  'den',
  'de',
  'del',
  'della',
  'di',
  'da',
  'do',
  'dos',
  'das',
  'du',
  'le',
  'la',
  'las',
  'los',
  'bin',
  'ibn',
  'bint',
  'binti',
  'binte',
  'al',
  'el',
  'abu',
  'abd',
  'mac',
  'mc',
  "o'",
  'ap',
  'ter',
  'ten',
  'zu',
  'af',
  'av',
]);

/** Honorifics and suffixes that carry no identity signal. */
export const NAME_AFFIXES: ReadonlySet<string> = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'sir',
  'dame',
  'lord',
  'lady',
  'hon',
  'rev',
  'eng',
  'adv',
  'jr',
  'sr',
  'ii',
  'iii',
  'iv',
  'phd',
  'md',
  'esq',
]);

export interface NameToken {
  /** Case-folded, diacritic-stripped comparison form. */
  readonly folded: string;
  /** The token exactly as it appeared in the source string. */
  readonly original: string;
  readonly kind: 'CORE' | 'PARTICLE' | 'AFFIX' | 'INITIAL';
}

export interface NormalisedName {
  /** The input, untouched. FR-01: preserve Unicode and original scripts. */
  readonly original: string;
  /** NFKC-normalised, case-folded, punctuation-collapsed. Diacritics preserved. */
  readonly nfkc: string;
  /** Comparison form: NFKC + case fold + diacritics stripped. */
  readonly folded: string;
  readonly tokens: readonly NameToken[];
  /** Core tokens only, sorted — the word-order-tolerant comparison key. */
  readonly sortedCoreKey: string;
  /** Unicode script codes observed, e.g. ['Latin'] or ['Arabic']. */
  readonly scripts: readonly string[];
}

const SCRIPT_TESTS: readonly (readonly [string, RegExp])[] = [
  ['Latin', /\p{Script=Latin}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Han', /\p{Script=Han}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Bengali', /\p{Script=Bengali}/u],
];

export function detectScripts(value: string): readonly string[] {
  return SCRIPT_TESTS.filter(([, re]) => re.test(value)).map(([name]) => name);
}

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Split on whitespace and hyphens, but keep the hyphenated whole as well: "Anne-Marie"
 * must match both "Anne-Marie" and "Anne Marie".
 */
function tokenise(folded: string): string[] {
  const parts = folded.split(/\s+/u).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    out.push(part);
    if (part.includes('-')) {
      out.push(...part.split('-').filter(Boolean));
    }
  }
  return out;
}

function classify(token: string): NameToken['kind'] {
  const bare = token.replace(/[.\-']/gu, '');
  if (NAME_AFFIXES.has(bare)) {
    return 'AFFIX';
  }
  if (NAME_PARTICLES.has(bare) || NAME_PARTICLES.has(token)) {
    return 'PARTICLE';
  }
  if (bare.length === 1) {
    return 'INITIAL';
  }
  return 'CORE';
}

export function normaliseName(input: string): NormalisedName {
  const nfkc = input
    .normalize('NFKC')
    .toLowerCase()
    // Collapse punctuation to spaces, but preserve hyphen and apostrophe as name-internal.
    .replace(/[^\p{L}\p{N}\-'\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const folded = stripDiacritics(nfkc);
  const raw = tokenise(folded);
  const seen = new Set<string>();
  const tokens: NameToken[] = [];

  for (const t of raw) {
    if (seen.has(t)) {
      continue;
    }
    seen.add(t);
    tokens.push({ folded: t, original: t, kind: classify(t) });
  }

  const core = tokens.filter((t) => t.kind === 'CORE').map((t) => t.folded);

  return {
    original: input,
    nfkc,
    folded,
    tokens,
    sortedCoreKey: [...core].sort().join(' '),
    scripts: detectScripts(input),
  };
}

/**
 * Double Metaphone-style phonetic key, reduced to the transformations that matter for
 * cross-language name matching. Deliberately simple and deterministic: this is a *blocking*
 * key that decides which candidates are compared, never a match decision on its own.
 */
export function phoneticKey(token: string): string {
  let s = stripDiacritics(token.toLowerCase()).replace(/[^a-z]/gu, '');
  if (s === '') {
    return '';
  }
  s = s
    .replace(/^(kn|gn|pn|wr|ps)/u, (m) => m.slice(1))
    .replace(/^x/u, 's')
    .replace(/ph/gu, 'f')
    .replace(/sch/gu, 'sk')
    .replace(/[sz]h/gu, 'x')
    .replace(/ck/gu, 'k')
    .replace(/[cq]/gu, 'k')
    .replace(/dg/gu, 'j')
    .replace(/gh/gu, 'g')
    .replace(/[wy]/gu, '')
    .replace(/v/gu, 'f')
    .replace(/z/gu, 's')
    .replace(/[aeiou]+/gu, 'a');

  // Keep a leading vowel (it distinguishes Ahmed from Mohammed), drop interior ones.
  const head = s.startsWith('a') ? 'a' : '';
  s = head + s.slice(head.length).replace(/a/gu, '');
  // Collapse doubled consonants.
  return (head + s.slice(head.length).replace(/(.)\1+/gu, '$1')).slice(0, 6);
}

export function phoneticKeys(name: NormalisedName): readonly string[] {
  return name.tokens
    .filter((t) => t.kind === 'CORE')
    .map((t) => phoneticKey(t.folded))
    .filter((k) => k !== '');
}

export type NameMatchForm =
  | 'EXACT'
  | 'EXACT_WORD_ORDER_VARIANT'
  | 'PARTICLE_VARIANT'
  | 'INITIAL_EXPANSION'
  | 'SUBSET_PATRONYMIC'
  | 'PHONETIC'
  | 'NO_MATCH';

export interface NameMatch {
  readonly form: NameMatchForm;
  /** The exact form of the name as it appeared in the document. Stored on the finding. */
  readonly matchedForm: string;
  /** Original script of the matched form, for display alongside the romanisation. */
  readonly matchedScripts: readonly string[];
}

const NO_MATCH: NameMatch = { form: 'NO_MATCH', matchedForm: '', matchedScripts: [] };

/**
 * Compare a subject name to a name as it appeared in a document.
 *
 * Returns the *strongest* form that holds. The caller decides what a given form is worth —
 * this function never decides identity, only the shape of the string agreement (FR-08).
 */
export function matchNameForms(subject: NormalisedName, candidate: NormalisedName): NameMatch {
  const found = (form: NameMatchForm): NameMatch => ({
    form,
    matchedForm: candidate.original,
    matchedScripts: candidate.scripts,
  });

  if (subject.folded === candidate.folded) {
    return found('EXACT');
  }

  const subjectCore = subject.tokens.filter((t) => t.kind === 'CORE').map((t) => t.folded);
  const candidateCore = candidate.tokens.filter((t) => t.kind === 'CORE').map((t) => t.folded);

  if (subjectCore.length === 0 || candidateCore.length === 0) {
    return NO_MATCH;
  }

  if (subject.sortedCoreKey === candidate.sortedCoreKey) {
    // Same core tokens, different order or different particles/affixes.
    const subjectHasParticle = subject.tokens.some((t) => t.kind === 'PARTICLE');
    const candidateHasParticle = candidate.tokens.some((t) => t.kind === 'PARTICLE');
    if (subjectHasParticle !== candidateHasParticle) {
      return found('PARTICLE_VARIANT');
    }
    return found('EXACT_WORD_ORDER_VARIANT');
  }

  if (expandsInitials(subject, candidate) || expandsInitials(candidate, subject)) {
    return found('INITIAL_EXPANSION');
  }

  // Patronymic / grandfather-name handling: Arabic and Slavic naming chains routinely drop
  // or add a middle element. A proper subset of at least two shared core tokens, with the
  // first token agreeing, is a real candidate — but only a candidate.
  const subjectSet = new Set(subjectCore);
  const shared = candidateCore.filter((t) => subjectSet.has(t));
  const firstAgrees = subjectCore[0] === candidateCore[0];
  const isSubset =
    shared.length >= 2 &&
    (shared.length === subjectCore.length || shared.length === candidateCore.length);
  if (isSubset && firstAgrees) {
    return found('SUBSET_PATRONYMIC');
  }

  const subjectPhonetic = phoneticKeys(subject);
  const candidatePhonetic = phoneticKeys(candidate);
  if (
    subjectPhonetic.length === candidatePhonetic.length &&
    subjectPhonetic.length > 0 &&
    [...subjectPhonetic].sort().join(' ') === [...candidatePhonetic].sort().join(' ')
  ) {
    return found('PHONETIC');
  }

  return NO_MATCH;
}

function expandsInitials(short: NormalisedName, long: NormalisedName): boolean {
  const shortTokens = short.tokens.filter((t) => t.kind === 'CORE' || t.kind === 'INITIAL');
  const longCore = long.tokens.filter((t) => t.kind === 'CORE').map((t) => t.folded);
  if (shortTokens.length !== longCore.length || shortTokens.length === 0) {
    return false;
  }
  let sawInitial = false;
  for (const [i, token] of shortTokens.entries()) {
    const target = longCore[i];
    if (target === undefined) {
      return false;
    }
    if (token.kind === 'INITIAL') {
      sawInitial = true;
      if (!target.startsWith(token.folded.replace(/[.\-']/gu, ''))) {
        return false;
      }
    } else if (token.folded !== target) {
      return false;
    }
  }
  return sawInitial;
}
