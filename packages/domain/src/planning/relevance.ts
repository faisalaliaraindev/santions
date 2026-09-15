/**
 * FR-06 relevance filtering — the nine signals, scored before a socket opens.
 *
 * # What this decides, and the one thing it must never decide
 *
 * It decides whether a candidate is **worth a request**. It does not decide whether anything is
 * adverse. FR-06 says so in one sentence — *"filtering never decides adversity"* — and the reason
 * is that a filter which dropped candidates for looking innocuous would quietly make the service
 * better at confirming suspicions than at testing them.
 *
 * So an adverse term near the name is a signal that this document is **about the person we are
 * screening**, not evidence that the person did anything. A rejected candidate is stored as a lead
 * with its reason and shown in the coverage view, because a reviewer has to be able to see what
 * was skipped.
 *
 * # Why there are no weights
 *
 * FR-06 lists nine signals. The obvious implementation is a weighted sum and a threshold. This is
 * not that, and the reason is that **the weights would be invented**.
 *
 * The phase brief says the weights should be set against the FR-16 labelled corpus. That corpus
 * exists and holds sixteen cases about *identity, attribution and banding* — not one of them about
 * whether a candidate was worth fetching. Calibrating against it would be calibrating against the
 * wrong question; choosing coefficients without it would put a number in the fetch gate that
 * nobody validated, and every lead dropped by that number would be dropped on an opinion.
 *
 * What this does instead:
 *
 * - **Categorical rejections** for the three things that need no calibration at all. A candidate
 *   outside the requested window, or that is not an article, or that is a copy of something
 *   already fetched, is refused on a fact rather than on a score.
 *
 *   Note what is **not** on that list: a candidate whose title and snippet do not name the
 *   subject. That was a rejection in the first draft and it was wrong. The FR-04 plan has
 *   company-anchored query families whose whole purpose is to find documents naming a *company*
 *   rather than the person, and a headline is not the document — refusing those would have
 *   deleted the association half of the product while the coverage statement said the sources
 *   were searched. It is a missing positive signal, and the score says so.
 * - **An uncalibrated score**, recorded and explained, that **does not gate**. It is the fraction
 *   of evaluable positive signals that fired, carried with the list of which ones did — so the
 *   corpus work, when it happens, has real scores from real runs to calibrate against rather than
 *   starting from nothing.
 *
 * That is D-037's reasoning extended: the score still does not gate; the facts do.
 *
 * # Three of the nine cannot be evaluated before a fetch, and say so
 *
 * FR-06 lists "name appearing only in sidebar/comment/related modules" as a pre-fetch signal. It
 * is not knowable from a headline and a URL — it is a statement about a document's structure. Any
 * implementation that claimed to evaluate it pre-fetch would be guessing.
 *
 * So signals that cannot be evaluated are returned in `unevaluable` and excluded from the score's
 * denominator. A score computed from six of nine signals says it was computed from six.
 *
 * Pure: no clock, no I/O, no lexicon lookup. The caller supplies the facts.
 */

/** The nine signals FR-06 enumerates, in its order. */
export const RELEVANCE_SIGNALS = [
  'NAME_IN_TITLE_OR_SNIPPET',
  'NAME_WITH_DISAMBIGUATOR',
  'ADVERSE_TERM_NEAR_NAME',
  'PUBLISHER_TIER',
  'WITHIN_REQUESTED_WINDOW',
  'NEAR_DUPLICATE_FROM_DOMAIN',
  'NON_ARTICLE_URL_PATTERN',
  'NAME_ONLY_IN_PERIPHERAL_MODULE',
  'AGGREGATOR_COPY_OF_FETCHED',
] as const;
export type RelevanceSignal = (typeof RELEVANCE_SIGNALS)[number];

/** Whether a signal argues for fetching, against it, or is a gate in its own right. */
export type SignalPolarity = 'POSITIVE' | 'NEGATIVE' | 'GATE';

const POLARITY: Readonly<Record<RelevanceSignal, SignalPolarity>> = {
  NAME_IN_TITLE_OR_SNIPPET: 'POSITIVE',
  NAME_WITH_DISAMBIGUATOR: 'POSITIVE',
  ADVERSE_TERM_NEAR_NAME: 'POSITIVE',
  PUBLISHER_TIER: 'POSITIVE',
  // FR-06 calls this one a gate in the text: "publication date inside the requested window
  // (a gate)". It is not weighed against anything.
  WITHIN_REQUESTED_WINDOW: 'GATE',
  NEAR_DUPLICATE_FROM_DOMAIN: 'NEGATIVE',
  NON_ARTICLE_URL_PATTERN: 'NEGATIVE',
  NAME_ONLY_IN_PERIPHERAL_MODULE: 'NEGATIVE',
  AGGREGATOR_COPY_OF_FETCHED: 'NEGATIVE',
};

export function signalPolarity(signal: RelevanceSignal): SignalPolarity {
  return POLARITY[signal];
}

/** Why a candidate was refused, on a fact rather than on a score. */
export const RELEVANCE_REJECTIONS = [
  'OUTSIDE_REQUESTED_WINDOW',
  'NOT_AN_ARTICLE_URL',
  'DUPLICATE_OF_FETCHED_ORIGIN',
  'BELOW_CONFIGURED_THRESHOLD',
] as const;
export type RelevanceRejection = (typeof RELEVANCE_REJECTIONS)[number];

/**
 * How the score was produced. Recorded on every authorisation, beside the number.
 *
 * `UNCALIBRATED` is in the name on purpose. A bare 0.4 is uninterpretable, and a reviewer — or a
 * later engineer — has to be able to tell this apart from a figure fitted to a corpus.
 */
export const RELEVANCE_METHOD = 'FR06_NINE_SIGNAL_UNCALIBRATED_v1';

/**
 * How far from the name an adverse term still counts as "near" it, in tokens.
 *
 * Twelve. A structural choice rather than a calibrated one, and it is stated as such: it is about
 * the length of a headline clause, not about a measured relationship between distance and
 * relevance. It is the one number here that a corpus would be expected to move.
 */
export const NEAR_NAME_TOKEN_DISTANCE = 12;

/** The facts a caller supplies about one candidate. */
export interface RelevanceInput {
  /** The candidate's headline, as the discovery source returned it. */
  readonly title: string;
  /** The snippet the source returned, or null. Never synthesised from the title. */
  readonly snippet: string | null;
  readonly url: string;
  /** The subject's name and aliases, in the forms the planner searched for. */
  readonly subjectNameForms: readonly string[];
  /**
   * Attributes that would disambiguate this subject from a namesake — a birth year, a company
   * name, a role. Supplied by the caller from the subject record; never inferred here.
   */
  readonly disambiguators: readonly string[];
  /** Adverse and procedural terms from the **pinned** taxonomy, in the searched languages. */
  readonly adverseTerms: readonly string[];
  /** The source's recorded authority tier, 1 (highest) to 5. Null when unknown. */
  readonly publisherTier: number | null;
  /** The candidate's publication date, `YYYY-MM-DD`, or null when the source published none. */
  readonly publishedOn: string | null;
  /** The run's requested window, inclusive, or null for unbounded. */
  readonly window: { readonly from: string | null; readonly to: string | null } | null;
  /** Titles already accepted from this same domain in this run, for the near-duplicate signal. */
  readonly acceptedTitlesFromDomain: readonly string[];
  /** True when this candidate's canonical origin has already been fetched in this run. */
  readonly originAlreadyFetched: boolean;
  /**
   * The minimum score a candidate must reach. **Defaults to 0, which drops nothing.**
   *
   * Configurable on the policy version so it can be raised once a corpus exists, and zero until
   * then: a threshold chosen before the corpus would drop leads on a number nobody validated, and
   * the leads it dropped would be invisible in exactly the way this filter's coverage record
   * exists to prevent.
   */
  readonly minimumScore?: number | undefined;
}

export interface SignalOutcome {
  readonly signal: RelevanceSignal;
  readonly polarity: SignalPolarity;
  readonly fired: boolean;
  /** What made it fire, in a reviewer's words. Null when it did not. */
  readonly detail: string | null;
}

export interface RelevanceAssessment {
  readonly method: string;
  /**
   * The fraction of **evaluable** positive signals that fired, or null when none was evaluable.
   *
   * Uncalibrated, recorded, and deliberately not used to gate. See the file header.
   */
  readonly score: number | null;
  readonly signals: readonly SignalOutcome[];
  /** Signals that cannot be evaluated before a fetch. Excluded from the score's denominator. */
  readonly unevaluable: readonly RelevanceSignal[];
  readonly decision: 'FETCH' | 'REJECT';
  readonly rejection: RelevanceRejection | null;
  /** Written for a reviewer reading the coverage view, not for a log line. */
  readonly detail: string;
}

/**
 * Assess one candidate.
 *
 * Order matters and is the policy: the window gate first, because FR-06 makes it a gate rather
 * than a weight; then the facts that need no calibration; then the score, which does not gate.
 */
export function assessRelevance(input: RelevanceInput): RelevanceAssessment {
  const haystack = fold(`${input.title} ${input.snippet ?? ''}`);
  const signals: SignalOutcome[] = [];

  // 5 — the window. A gate in FR-06's own words.
  const windowOutcome = withinWindow(input.publishedOn, input.window);
  signals.push({
    signal: 'WITHIN_REQUESTED_WINDOW',
    polarity: 'GATE',
    fired: windowOutcome.within,
    detail: windowOutcome.detail,
  });
  if (!windowOutcome.within) {
    return reject(
      signals,
      'OUTSIDE_REQUESTED_WINDOW',
      windowOutcome.detail ??
        'The candidate was published outside the window this search asked for.',
    );
  }

  // 1 — the subject's name, in a form the planner searched for.
  const nameMatch = input.subjectNameForms.find((form) => haystack.includes(fold(form))) ?? null;
  signals.push({
    signal: 'NAME_IN_TITLE_OR_SNIPPET',
    polarity: 'POSITIVE',
    fired: nameMatch !== null,
    detail: nameMatch === null ? null : `"${nameMatch}" appears in the title or snippet.`,
  });

  // 2 — the name together with something that separates this subject from a namesake.
  const disambiguator =
    nameMatch === null
      ? null
      : (input.disambiguators.find((value) => haystack.includes(fold(value))) ?? null);
  signals.push({
    signal: 'NAME_WITH_DISAMBIGUATOR',
    polarity: 'POSITIVE',
    fired: disambiguator !== null,
    detail: disambiguator === null ? null : `The name appears with "${disambiguator}" beside it.`,
  });

  // 3 — an adverse or procedural term near the name. A signal that the document is *about* this
  // person, never that the person did anything.
  const nearTerm =
    nameMatch === null ? null : nearestAdverseTerm(haystack, fold(nameMatch), input.adverseTerms);
  signals.push({
    signal: 'ADVERSE_TERM_NEAR_NAME',
    polarity: 'POSITIVE',
    fired: nearTerm !== null,
    detail:
      nearTerm === null
        ? null
        : `"${nearTerm}" appears within ${String(NEAR_NAME_TOKEN_DISTANCE)} tokens of the name. ` +
          `This says the document is about this person — it says nothing about what they did.`,
  });

  // 4 — publisher tier. Tier 1 and 2 are the sources whose reporting carries weight on axis D.
  const tierFired = input.publisherTier !== null && input.publisherTier <= 3;
  signals.push({
    signal: 'PUBLISHER_TIER',
    polarity: 'POSITIVE',
    fired: tierFired,
    detail: tierFired
      ? `The source is recorded at authority tier ${String(input.publisherTier)}.`
      : null,
  });

  // 7 — a URL that is not an article. Categorical: there is no document here to fetch.
  const nonArticle = nonArticleUrl(input.url);
  signals.push({
    signal: 'NON_ARTICLE_URL_PATTERN',
    polarity: 'NEGATIVE',
    fired: nonArticle !== null,
    detail: nonArticle,
  });

  // 6 — a near-duplicate of something already taken from this domain.
  const duplicateTitle = nearDuplicate(input.title, input.acceptedTitlesFromDomain);
  signals.push({
    signal: 'NEAR_DUPLICATE_FROM_DOMAIN',
    polarity: 'NEGATIVE',
    fired: duplicateTitle !== null,
    detail:
      duplicateTitle === null
        ? null
        : `This domain has already contributed "${duplicateTitle}", which is near-identical.`,
  });

  // 9 — an aggregator's copy of something already fetched. Categorical: one story, one lead.
  signals.push({
    signal: 'AGGREGATOR_COPY_OF_FETCHED',
    polarity: 'NEGATIVE',
    fired: input.originAlreadyFetched,
    detail: input.originAlreadyFetched
      ? 'The origin of this copy has already been fetched in this run. Fetching it again would ' +
        'add distribution, not verification (FR-10).'
      : null,
  });

  // 8 — not knowable from a headline and a URL. Declared, never guessed.
  const unevaluable: RelevanceSignal[] = ['NAME_ONLY_IN_PERIPHERAL_MODULE'];

  // The subject's name **not** appearing in the title or snippet is a missing positive signal,
  // not a reason to refuse. FR-06 lists it as a signal and makes only the window a gate, and
  // turning it into a rejection was wrong for a concrete reason the fixtures caught:
  //
  // The FR-04 plan has **company-anchored query families**. They exist precisely to find
  // documents that name a *company* the subject is associated with — "Fiscalía acusa a directiva
  // de Inversiones Talamanca" names the company and the role, and not the person. Refusing those
  // would delete the entire association half of the product, quietly, and the coverage statement
  // would say the sources were searched.
  //
  // A headline is also not the document. A name absent from a headline is routinely present in
  // the second paragraph, which is the paragraph that matters.
  if (nonArticle !== null) {
    return reject(signals, 'NOT_AN_ARTICLE_URL', nonArticle, unevaluable);
  }
  if (input.originAlreadyFetched) {
    return reject(
      signals,
      'DUPLICATE_OF_FETCHED_ORIGIN',
      'The origin of this copy has already been fetched in this run.',
      unevaluable,
    );
  }

  const score = scoreOf(signals, unevaluable);
  const minimum = input.minimumScore ?? 0;
  if (score !== null && minimum > 0 && score < minimum) {
    return reject(
      signals,
      'BELOW_CONFIGURED_THRESHOLD',
      `Scored ${score.toFixed(2)} against a configured minimum of ${minimum.toFixed(2)}. ` +
        `The score is uncalibrated (${RELEVANCE_METHOD}); this threshold was set deliberately.`,
      unevaluable,
      score,
    );
  }

  return {
    method: RELEVANCE_METHOD,
    score,
    signals,
    unevaluable,
    decision: 'FETCH',
    rejection: null,
    detail: describe(signals, score, unevaluable),
  };
}

/**
 * The fraction of evaluable positive signals that fired.
 *
 * Positives only. Negatives that are not categorical — a near-duplicate — are recorded and shown
 * rather than folded into a number, because subtracting them would need a weight and a weight
 * would need the corpus.
 */
function scoreOf(
  signals: readonly SignalOutcome[],
  unevaluable: readonly RelevanceSignal[],
): number | null {
  const positives = signals.filter(
    (outcome) => outcome.polarity === 'POSITIVE' && !unevaluable.includes(outcome.signal),
  );
  if (positives.length === 0) {
    return null;
  }
  return positives.filter((outcome) => outcome.fired).length / positives.length;
}

function reject(
  signals: readonly SignalOutcome[],
  rejection: RelevanceRejection,
  detail: string,
  unevaluable: readonly RelevanceSignal[] = ['NAME_ONLY_IN_PERIPHERAL_MODULE'],
  score: number | null = null,
): RelevanceAssessment {
  return {
    method: RELEVANCE_METHOD,
    score,
    signals,
    unevaluable,
    decision: 'REJECT',
    rejection,
    detail,
  };
}

/** The sentence a reviewer reads beside an accepted candidate. */
function describe(
  signals: readonly SignalOutcome[],
  score: number | null,
  unevaluable: readonly RelevanceSignal[],
): string {
  const fired = signals.filter((outcome) => outcome.fired).map((outcome) => outcome.signal);
  return (
    `Worth fetching on ${String(fired.length)} signal(s): ${fired.join(', ')}. ` +
    `Score ${score === null ? 'not computable' : score.toFixed(2)} by ${RELEVANCE_METHOD} — ` +
    `uncalibrated, and not used to gate. ` +
    `${String(unevaluable.length)} signal(s) cannot be evaluated before a fetch: ` +
    `${unevaluable.join(', ')}.`
  );
}

/**
 * Is the candidate inside the requested window?
 *
 * **A candidate with no date passes.** FR-07 keeps a missing date null rather than inventing one,
 * and refusing every undated candidate would silently drop whole publishers who do not put dates
 * in their feeds — a recall loss that would look like an absence of news.
 */
function withinWindow(
  publishedOn: string | null,
  window: { readonly from: string | null; readonly to: string | null } | null,
): { within: boolean; detail: string | null } {
  if (window === null || publishedOn === null) {
    return {
      within: true,
      detail:
        publishedOn === null
          ? 'No publication date was returned, so the window could not exclude it. FR-07: a ' +
            'missing date is never invented, and an undated candidate is not thereby out of scope.'
          : null,
    };
  }
  if (window.from !== null && publishedOn < window.from) {
    return {
      within: false,
      detail: `Published ${publishedOn}, before the requested window opened on ${window.from}.`,
    };
  }
  if (window.to !== null && publishedOn > window.to) {
    return {
      within: false,
      detail: `Published ${publishedOn}, after the requested window closed on ${window.to}.`,
    };
  }
  return { within: true, detail: null };
}

/**
 * URL shapes that are not a document.
 *
 * Deliberately narrow. A false positive here refuses a real article, so this lists only shapes
 * that are structurally not an article rather than anything that looks unpromising.
 */
function nonArticleUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'The candidate URL is not a URL.';
  }

  const path = parsed.pathname.toLowerCase();
  const patterns: readonly [RegExp, string][] = [
    [/\/(tag|tags|category|categories|topic|topics)\//, 'a tag or category index'],
    [/\/(author|autor|by)\//, 'an author index'],
    [/\/(search|buscar)\b/, 'a search results page'],
    [/\/(login|signin|register|subscribe|suscribirse)\b/, 'a login or subscription page'],
    [/\.(jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip)$/, 'a media file rather than a document'],
    [/^\/?$/, 'a site home page rather than an article'],
  ];

  for (const [pattern, label] of patterns) {
    if (pattern.test(path)) {
      return `The URL is ${label}, so there is no document here to fetch.`;
    }
  }
  return null;
}

/**
 * Has this domain already contributed a near-identical headline?
 *
 * Compared on folded tokens rather than on the raw string: a publisher that re-runs a story with
 * "UPDATE:" prefixed is running the same story.
 */
function nearDuplicate(title: string, accepted: readonly string[]): string | null {
  const tokens = new Set(tokenise(fold(title)));
  if (tokens.size === 0) {
    return null;
  }

  for (const candidate of accepted) {
    const other = new Set(tokenise(fold(candidate)));
    if (other.size === 0) {
      continue;
    }
    let shared = 0;
    for (const token of tokens) {
      if (other.has(token)) {
        shared += 1;
      }
    }
    // Four fifths of the shorter headline's distinct tokens. High enough that two different
    // stories about one person do not collide, low enough that a re-headlined wire copy does.
    if (shared / Math.min(tokens.size, other.size) >= 0.8) {
      return candidate;
    }
  }
  return null;
}

/** The nearest adverse term to the name, within the token distance, or null. */
function nearestAdverseTerm(
  haystack: string,
  foldedName: string,
  terms: readonly string[],
): string | null {
  const tokens = tokenise(haystack);
  const nameTokens = tokenise(foldedName);
  const firstNameToken = nameTokens[0];
  if (firstNameToken === undefined) {
    return null;
  }

  const namePositions = tokens.reduce<number[]>((positions, token, index) => {
    if (token === firstNameToken) {
      positions.push(index);
    }
    return positions;
  }, []);
  if (namePositions.length === 0) {
    return null;
  }

  for (const term of terms) {
    const termTokens = tokenise(fold(term));
    const head = termTokens[0];
    if (head === undefined) {
      continue;
    }
    for (const [index, token] of tokens.entries()) {
      if (token !== head) {
        continue;
      }
      if (
        namePositions.some((position) => Math.abs(position - index) <= NEAR_NAME_TOKEN_DISTANCE)
      ) {
        return term;
      }
    }
  }
  return null;
}

function tokenise(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/** Case- and accent-folded, so `Solís` in a headline matches `Solis` in a planned query. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
