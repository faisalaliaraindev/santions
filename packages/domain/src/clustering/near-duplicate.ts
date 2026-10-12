/**
 * FR-10 — near-duplicate fingerprints.
 *
 * # Why this exists
 *
 * `ClusterCandidate.nearDuplicateKey` has been in the clustering rules since they were written,
 * documented as "SimHash/MinHash bucket assigned by the provider layer". No provider ever
 * assigned one. Every candidate reaching `decideClustering` carried `null`, so the
 * `MERGE_SYNDICATION_FAMILY` branch — the branch that stops forty copies of one wire story
 * counting as forty independent reports — was unreachable in production.
 *
 * Without a fingerprint, the only duplicate signals available are an identical content hash and
 * an identical canonical URL. Both catch the same document fetched twice. Neither catches the
 * thing that actually happens: one Reuters report republished by a dozen outlets under a dozen
 * URLs with a dozen different mastheads, or one SEC press release rediscovered through three
 * aggregators. Those are the cases invariant I6 exists for.
 *
 * # Why it lives in the domain package
 *
 * `rules.ts` calls the fingerprint "I/O" and defers it to the provider layer. That is right about
 * *lookup* — finding candidate near-duplicates across a whole search index is a query — and wrong
 * about *computation*. Turning a string into a fingerprint is a pure function of the string. It
 * takes no clock, no network and no database, so it belongs here where the I1–I10 harness can
 * reach it, and where the clustering rules that consume it already live.
 *
 * # The algorithm, and its limits
 *
 * SimHash over word shingles: 64 bits, one counter per bit, each shingle voting by its own hash.
 * Two documents are near-duplicates when their fingerprints differ in few enough bits. This is
 * the standard construction and it has the standard properties — cheap, order-insensitive to
 * small edits, and *approximate*.
 *
 * Two deliberate conservatisms:
 *
 *  - **Short text gets no fingerprint at all.** Below `MIN_SHINGLES` the fingerprint is dominated
 *    by a handful of shingles and two unrelated snippets collide readily. `null` is returned, and
 *    a null key never merges anything. Suppressing a genuine second source because two short
 *    summaries happened to collide is a worse failure than counting one story twice: it removes
 *    evidence about a person rather than adding it.
 *  - **The threshold is set from measurement and leaves room on both sides.** It catches
 *    republication with a changed headline, a trimmed final paragraph or an inserted house style
 *    note. It does not claim to catch a rewrite, and it should not: two newsrooms writing the
 *    same story independently *are* two independent reports. See
 *    `DEFAULT_NEAR_DUPLICATE_DISTANCE` for the figures.
 */

/** Bits in the fingerprint. */
const FINGERPRINT_BITS = 64;

/** Words per shingle. Five is long enough that common phrases do not dominate. */
const SHINGLE_WORDS = 5;

/**
 * Minimum shingles before a fingerprint is trusted. Roughly two sentences of running text.
 * Below this, `fingerprintText` returns null rather than a fingerprint nobody should rely on.
 */
export const MIN_SHINGLES = 20;

/**
 * Maximum differing bits for two documents to be the same underlying text.
 *
 * **Measured, not assumed.** The conventional figure quoted for 64-bit SimHash is three, and that
 * figure is for long documents with thousands of shingles. A news item has a few dozen, so a
 * changed headline moves far more of the vector. Three rejected genuine syndication outright.
 *
 * Measured over the fixtures in `test/clustering/assign.test.ts`, which are the four cases that
 * matter, at the length real items actually are:
 *
 * | pair                                                 | distance |
 * | :--------------------------------------------------- | -------: |
 * | one story, syndicated with a new headline             |        6 |
 * | one story, heavier edit plus a house note             |        9 |
 * | **different** story, identical publisher boilerplate  |       21 |
 * | unrelated stories                                     |       34 |
 *
 * Twelve sits in the gap with margin on both sides: copies are at most 9, and the nearest thing
 * that must *not* collapse — two different enforcement actions written in one regulator's house
 * style — is 21. Those figures are asserted as tests, so a change to the hash, the shingle width
 * or the token rules fails rather than silently moving the boundary.
 */
export const DEFAULT_NEAR_DUPLICATE_DISTANCE = 12;

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

/** FNV-1a, 64-bit. Not a cryptographic hash and does not need to be: this is a bucket key. */
function hash64(value: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * Words, folded for comparison.
 *
 * Diacritics are stripped and case folded so that a copy that lost its accents in transit still
 * fingerprints the same. Punctuation is a separator, not a token: the same story with smart
 * quotes and with straight quotes is the same story.
 */
function words(text: string): readonly string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLocaleLowerCase('en')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * The SimHash of a text, as 16 lowercase hex characters, or null when the text is too short to
 * fingerprint honestly.
 */
export function fingerprintText(text: string): string | null {
  const tokens = words(text);
  const shingleCount = tokens.length - SHINGLE_WORDS + 1;
  if (shingleCount < MIN_SHINGLES) {
    return null;
  }

  const counters = new Array<number>(FINGERPRINT_BITS).fill(0);
  for (let i = 0; i < shingleCount; i += 1) {
    const shingle = tokens.slice(i, i + SHINGLE_WORDS).join(' ');
    const hash = hash64(shingle);
    for (let bit = 0; bit < FINGERPRINT_BITS; bit += 1) {
      const set = ((hash >> BigInt(bit)) & 1n) === 1n;
      counters[bit] = (counters[bit] ?? 0) + (set ? 1 : -1);
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < FINGERPRINT_BITS; bit += 1) {
    if ((counters[bit] ?? 0) > 0) {
      fingerprint |= 1n << BigInt(bit);
    }
  }
  return fingerprint.toString(16).padStart(16, '0');
}

/** Differing bits between two hex fingerprints, or null when either is unusable. */
export function fingerprintDistance(a: string | null, b: string | null): number | null {
  if (a === null || b === null || a.length !== 16 || b.length !== 16) {
    return null;
  }
  let xor: bigint;
  try {
    xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  } catch {
    return null;
  }
  let distance = 0;
  while (xor !== 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/**
 * Whether two fingerprints describe the same underlying text.
 *
 * False whenever either fingerprint is missing. "We could not tell" is not "they are copies",
 * and treating it as such would suppress a source on no evidence.
 */
export function isNearDuplicate(
  a: string | null,
  b: string | null,
  maxDistance: number = DEFAULT_NEAR_DUPLICATE_DISTANCE,
): boolean {
  const distance = fingerprintDistance(a, b);
  return distance !== null && distance <= maxDistance;
}
