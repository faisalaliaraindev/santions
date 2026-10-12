/**
 * The engine matrix — what our connector integrates, and what the research says about each.
 *
 * # Three axes, and keeping them apart is the whole point of this file
 *
 * Facts about an engine change for different reasons, by different acts, at different scopes.
 * Collapsing any two of them is the mistake this file exists to prevent:
 *
 * - `integrated` — *can* our connector query this engine and report on it? A technical fact
 *   about our code. It is `true` for every engine here and stays true whatever anyone decides.
 * - `governanceStatus` — what did somebody who read the upstream terms conclude? A legal
 *   reading. Recorded in code because it is reviewed like code, and platform-wide because
 *   somebody else's terms of use do not vary by customer.
 * - **whether a tenant has it switched on** — which is *not in this file*. That is per-tenant
 *   configuration, set through the control API with a name and a reason on it
 *   (`engine-enablement.service.ts`). This file supplies only the **default** applied to a
 *   tenant who has not configured one.
 *
 * One flag would fail in three directions at once. Refusing an engine on legal grounds would
 * **delete it from the diagnostics**, so a reviewer asking "why is Google not in these results?"
 * would get silence and the next engineer would conclude Google was never built. It would couple
 * the engineering to the legal reading, so the technical work could not be finished and tested
 * for all six engines while the governance question stays open on each. And it would put a
 * per-customer switch in a source file, so turning an engine on for one tenant would be a
 * release.
 *
 * So a disabled engine is **not absent**. It is attempted-as-`DISABLED_BY_POLICY`, it appears in
 * every per-engine table with the decision id that disabled it, and it contributes zero results.
 * A visible, explained zero rather than a gap.
 *
 * # One engine never disables the layer
 *
 * An engine being off removes that engine. It does not remove SearXNG, it does not remove any
 * other engine, and it does not fail the source: the source-level outcome is derived from the
 * engine outcomes (`deriveSourceOutcome`), so five engines working and one refused is `PARTIAL`
 * with the refusal named, never `FAILED`.
 *
 * # The default is ON for five engines, and that is a decision somebody made
 *
 * `defaultEnabledForDiscovery` is `true` for the five engines D21 permitted. That is **not** this
 * file inferring permission from `governanceStatus` — nothing here computes one from the other,
 * and the two are written on separate lines precisely so they can disagree visibly. It is the
 * product owner's recorded decision (2026-09-22, under D21) that a tenant who has expressed no
 * preference gets those engines, and that narrowing it is the tenant's act rather than ours.
 *
 * # Google is the one engine whose default is OFF, and that is a *safety* decision
 *
 * `GOOGLE_NEWS.defaultEnabledForDiscovery` is `false`. It is the only `false` in the matrix.
 *
 * It was `true` until 2026-09-22, with the refusal carried loudly beside it, on the reasoning
 * that a visible disagreement between switch and reading is more honest than a quiet agreement.
 * That reasoning was sound while the two fields could only ever disagree *harmlessly* — Google
 * was refused, so `effectiveEnabled` was false whatever the switch said, and nothing depended on
 * the switch's value.
 *
 * **What changed is what happens on the day the refusal moves.** With the default at `true`, a
 * single edit to `governanceStatus` — one field, one line, in one code review framed as a
 * governance decision — would have taken Google from "queried by nobody" to "queried on every
 * search of every tenant who never configured an engine", in one release, with no tenant having
 * asked for it. A governance decision and a fleet-wide activation are two different acts and must
 * not be spendable with one keystroke. So the default is `false`: after the refusal moves, Google
 * is *available to be switched on*, tenant by tenant, by a named person with a recorded reason
 * (`engine-enablement.service.ts`), and until one of them does, it is still queried by nobody.
 *
 * `apps/api/test/searxng-google-default-off.test.ts` holds that property against a *simulated* permitted
 * reading, so it fails if anyone restores the `true` — it does not wait for the real edit.
 *
 * The refusal itself is untouched by this. `false` here is not a second opinion about Google's
 * terms; a reader who mistakes it for one will wrongly conclude the refusal is redundant.
 *
 * **`REFUSED` is the stricter of the two gates.** Moving `GOOGLE_NEWS` off `REFUSED` would
 * require reopening D20 on the terms D20 quoted, and nothing short of that does it. The default
 * being `false` narrows what that edit *does*; it does not make the edit any easier to make.
 *
 * What is forbidden throughout is converting a reading into `PERMITTED` *silently* — by inferring
 * it from a switch, or from an engine having worked. **An engine returning HTTP 200 is not
 * permission.** One bounded diagnostic under D20-A (2026-09-22) established that Google News via
 * this SearXNG route works from our egress and returns original-publisher URLs, which retired the
 * provenance objection for this route and left the licence objection as the whole of the refusal.
 * It moved nothing here, and it must not be cited as though it had.
 *
 * The five `PENDING` readings were moved to `PERMITTED` on 2026-09-22 under D21 by the product
 * owner, and each `evidenceNote` says in as many words that the decision is a recorded
 * acceptance of the residual risk rather than a completed review by counsel. That distinction
 * is the point: the limitation each note carried while it was `PENDING` is still in the note.
 *
 * # What changes a governance reading
 *
 * Read that engine's upstream terms, decide, and edit its record here: `governanceStatus`,
 * `reviewedBy`, `reviewedAt`, `evidenceNote`. That is a code review, because a reading of
 * somebody else's terms is not a configuration value and a form is the wrong place to make one.
 * Turning an engine on or off for a tenant is the other thing entirely, and it is an API call.
 */

/**
 * The engines this connector integrates, as a closed union.
 *
 * Closed rather than `string` so that a typo is a compile error rather than a request to an
 * engine nobody reviewed. The values are our own vocabulary; `searxngEngineName` maps each to
 * the exact identifier our instance's `/config` reports.
 */
export type DiscoveryEngine =
  | 'GOOGLE_NEWS'
  | 'BING_NEWS'
  | 'BRAVE_NEWS'
  | 'DUCKDUCKGO_NEWS'
  | 'REUTERS'
  | 'WIKINEWS';

/**
 * Where an engine's governance stands.
 *
 * `PERMITTED` and `REFUSED` both mean somebody read the terms and decided. `PENDING` means
 * nobody has. It is a reading, not a switch — see the file header on why the switch lives
 * elsewhere.
 */
export type EngineGovernanceStatus = 'PERMITTED' | 'REFUSED' | 'PENDING';

export interface EngineGovernanceRecord {
  readonly engine: DiscoveryEngine;
  /**
   * The exact identifier our SearXNG `/config` reports for this engine.
   *
   * Read from the running instance rather than guessed — `docs/sources/evidence/` records the
   * read. Sent verbatim in the `engines` parameter, so a wrong value here is an engine that
   * silently never runs.
   */
  readonly searxngEngineName: string;
  /**
   * **Technical integration.** Can this connector query this engine and report on it?
   *
   * True for every engine in the matrix. A fact about our code, unaffected by governance and by
   * any tenant's switch: an engine that is integrated but switched off is attempted-as-
   * `DISABLED_BY_POLICY` and appears in every diagnostic with that outcome, rather than
   * vanishing from the report.
   */
  readonly integrated: boolean;
  /**
   * The **default** discovery permission, applied to a tenant who has not configured one.
   *
   * Not what the request path reads: `EngineEnablementService` resolves the effective value per
   * tenant from this default and that tenant's stored setting, and the connector asks that.
   *
   * `true` for the five D21 engines by the owner's decision, and `false` for `GOOGLE_NEWS` — see
   * the file header, which explains both why that is not the same thing as `governanceStatus`
   * saying `PERMITTED`, and why Google's default is the one that is off.
   */
  readonly defaultEnabledForDiscovery: boolean;
  readonly governanceStatus: EngineGovernanceStatus;
  /** The open decision that records this engine's position. Never null — every engine has one. */
  readonly decisionId: string;
  /** ISO date. When a person last looked at this engine's position. */
  readonly reviewedAt: string;
  /** Who looked, or null when nobody has. Null and `PENDING` go together. */
  readonly reviewedBy: string | null;
  /**
   * Does SearXNG read this engine through the publisher's own documented API?
   *
   * Recorded because it is the fact that decides most of these cases, and because it was read
   * from SearXNG's own engine module in the running container rather than assumed. `false` means
   * we would be reading an endpoint the publisher does not document for this use, which is the
   * shape of access every terms-of-use clause in this area is written against.
   */
  readonly usesPublisherDocumentedApi: boolean;
  /** What the research found, in the words a reviewer needs. Never a link on its own. */
  readonly evidenceNote: string;
}

/**
 * The matrix.
 *
 * **All six are integrated** — the connector queries, parses, attributes and reports every one,
 * and the contract tests cover all six whatever any switch says.
 *
 * **Five default to on; Google defaults to off.** Their governance readings differ and are
 * recorded honestly: one refused under a closed decision (D20, Google), five permitted under D21
 * as of 2026-09-22. Every one of those readings travels into the control API and the per-engine
 * diagnostics beside the switch — including the limitation each D21 note still carries. Google's
 * `false` default is the second gate described in the file header, not a second opinion about
 * its terms.
 */
export const ENGINE_GOVERNANCE: Readonly<Record<DiscoveryEngine, EngineGovernanceRecord>> = {
  GOOGLE_NEWS: {
    engine: 'GOOGLE_NEWS',
    searxngEngineName: 'google news',
    integrated: true,
    // FALSE, alone in this matrix, and deliberately. See "Google is the one engine whose
    // default is OFF" in the file header: this is the second, independent gate that stops a
    // governance edit from activating Google for every tenant at once.
    defaultEnabledForDiscovery: false,
    governanceStatus: 'REFUSED',
    decisionId: 'D20',
    reviewedAt: '2026-09-22',
    reviewedBy: 'Faisal Ali, Source admin',
    usesPublisherDocumentedApi: false,
    evidenceNote:
      'GOVERNANCE READING: REFUSED by D20, and this milestone did not reopen it. Google’s ' +
      'News Terms of Use permit "your own personal use (i.e., non-commercial use)" and ' +
      'separately forbid "any robot, spider, other device or manual process to monitor or copy ' +
      'any content from the Service". This is a commercial, automated screening product, so both ' +
      'clauses are engaged. SearXNG’s google_news engine scrapes google.com/search?tbm=nws ' +
      '— the prohibited mechanism aimed at the covered service — which is if anything ' +
      'further from permitted than the RSS feed D20 examined. Running the metasearch instance ' +
      'ourselves changes who dials the socket, not whose terms apply. TWO THINGS A LATER READER ' +
      'MUST NOT MISREAD. First, D20 rested on TWO objections and only one now stands: one bounded ' +
      'diagnostic under D20-A (2026-09-22) confirmed that this SearXNG route returns ORIGINAL ' +
      'PUBLISHER URLs, not news.google.com/rss/articles redirects, so the FR-09 provenance ' +
      'objection D20 raised against the RSS feed does NOT carry over here. The licence objection ' +
      'above is now the whole of the refusal, and it is untouched — that request returning ' +
      'HTTP 200 is evidence about Google’s infrastructure, never about Google’s terms. ' +
      'Second, this engine is the only one in the matrix whose default switch is OFF. That is a ' +
      'blast-radius control, not a second refusal: it exists so that if this reading is ever moved ' +
      'off REFUSED, that edit alone does not activate Google for every tenant — each tenant ' +
      'would still have to switch it on by name, with a reason. Whoever moves the reading must ' +
      'leave the default alone.',
  },

  BING_NEWS: {
    engine: 'BING_NEWS',
    searxngEngineName: 'bing news',
    integrated: true,
    defaultEnabledForDiscovery: true,
    governanceStatus: 'PERMITTED',
    decisionId: 'D21',
    reviewedAt: '2026-09-22',
    reviewedBy: 'Faisal Ali, Product owner (D21, 2026-09-22)',
    usesPublisherDocumentedApi: false,
    evidenceNote:
      'GOVERNANCE READING: PERMITTED under D21, recorded 2026-09-22 by the product owner (Faisal ' +
      'Ali) for adverse-media discovery. That decision is an explicit, documented acceptance of the ' +
      'residual risk set out below — it is not a completed review of the publisher’s terms by ' +
      'counsel, and it does not claim to be. The limitations are unchanged and are precisely why ' +
      'the decision is recorded here rather than assumed. No review of the Microsoft Services ' +
      'Agreement against this use has been performed. SearXNG’s bing_news engine reads ' +
      'bing.com/news/infinitescrollajax, an undocumented internal endpoint, with use_official_api: ' +
      'false. D20 already recorded that bing-news-rss "is very probably in the same position and ' +
      'has not been examined; it should not be activated on the assumption that it differs", and ' +
      'this is the same publisher reached by a less documented route.',
  },

  BRAVE_NEWS: {
    engine: 'BRAVE_NEWS',
    searxngEngineName: 'brave.news',
    integrated: true,
    defaultEnabledForDiscovery: true,
    governanceStatus: 'PERMITTED',
    decisionId: 'D21',
    reviewedAt: '2026-09-22',
    reviewedBy: 'Faisal Ali, Product owner (D21, 2026-09-22)',
    usesPublisherDocumentedApi: false,
    evidenceNote:
      'GOVERNANCE READING: PERMITTED under D21, recorded 2026-09-22 by the product owner (Faisal ' +
      'Ali) for adverse-media discovery. That decision is an explicit, documented acceptance of the ' +
      'residual risk set out below — it is not a completed review of the publisher’s terms by ' +
      'counsel, and it does not claim to be. The limitations are unchanged and are precisely why ' +
      'the decision is recorded here rather than assumed. No review of Brave Search’s terms against ' +
      'this use has been performed. SearXNG’s brave engine scrapes search.brave.com HTML with ' +
      'use_official_api: false. Brave do publish a contractually licensed Search API, which is the ' +
      'route that would not need this question answered — it is paid beyond a free allowance, so ' +
      'adopting it is a commercial decision outside this project’s free-and-open-source constraint, ' +
      'recorded here so the next reader does not re-derive it. Separately, the engine returned ' +
      '"HTTP connection error" on the one request that reached it during the audit. That is a ' +
      'runtime fact, not a governance one, and it is reported separately as CONNECTION_ERROR.',
  },

  DUCKDUCKGO_NEWS: {
    engine: 'DUCKDUCKGO_NEWS',
    searxngEngineName: 'duckduckgo news',
    integrated: true,
    defaultEnabledForDiscovery: true,
    governanceStatus: 'PERMITTED',
    decisionId: 'D21',
    reviewedAt: '2026-09-22',
    reviewedBy: 'Faisal Ali, Product owner (D21, 2026-09-22)',
    usesPublisherDocumentedApi: false,
    evidenceNote:
      'GOVERNANCE READING: PERMITTED under D21, recorded 2026-09-22 by the product owner (Faisal ' +
      'Ali) for adverse-media discovery. That decision is an explicit, documented acceptance of the ' +
      'residual risk set out below — it is not a completed review of the publisher’s terms by ' +
      'counsel, and it does not claim to be. The limitations are unchanged and are precisely why ' +
      'the decision is recorded here rather than assumed. No review of DuckDuckGo’s terms against ' +
      'this use has been performed. The engine reads an internal endpoint with use_official_api: ' +
      'false. DuckDuckGo publish an Instant Answer API whose terms are documented, but it is not a ' +
      'news search and is not what this engine reads. Worth recording because it is the one engine ' +
      'a previous settings file named as approved: that file listed duckduckgo under a comment ' +
      'claiming an approved engine list, and no decision record anywhere in this project ' +
      'corresponded to it. An approval nobody can point at is not one — that gap is now closed by ' +
      'D21 itself, not by the comment that claimed it.',
  },

  REUTERS: {
    engine: 'REUTERS',
    searxngEngineName: 'reuters',
    integrated: true,
    defaultEnabledForDiscovery: true,
    governanceStatus: 'PERMITTED',
    decisionId: 'D21',
    reviewedAt: '2026-09-22',
    reviewedBy: 'Faisal Ali, Product owner (D21, 2026-09-22)',
    usesPublisherDocumentedApi: false,
    evidenceNote:
      'GOVERNANCE READING: PERMITTED under D21, recorded 2026-09-22 by the product owner (Faisal ' +
      'Ali) for adverse-media discovery. That decision is an explicit, documented acceptance of the ' +
      'residual risk set out below — it is not a completed review of the publisher’s terms by ' +
      'counsel, and it does not claim to be. The limitations are unchanged and are precisely why ' +
      'the decision is recorded here rather than assumed. No review of Reuters’ terms against this ' +
      'use has been performed, and this is the engine where that matters most. SearXNG reads ' +
      'reuters.com/pf/api/v3/content/fetch/articles-by-search-v2 — the undocumented internal API ' +
      'behind their own site — with use_official_api: false. Reuters license their content ' +
      'commercially, so the question is a real one rather than a formality. This is also the engine ' +
      'whose results are worth the most: a tier-2 publisher whose hits are original article URLs, ' +
      'which is exactly the evidence shape FR-09 wants.',
  },

  WIKINEWS: {
    engine: 'WIKINEWS',
    searxngEngineName: 'wikinews',
    integrated: true,
    defaultEnabledForDiscovery: true,
    governanceStatus: 'PERMITTED',
    decisionId: 'D21',
    reviewedAt: '2026-09-22',
    reviewedBy: 'Faisal Ali, Product owner (D21, 2026-09-22)',
    usesPublisherDocumentedApi: true,
    evidenceNote:
      'GOVERNANCE READING: PERMITTED under D21, recorded 2026-09-22 by the product owner (Faisal ' +
      'Ali). This is the one engine of the five where the published evidence independently supports ' +
      'that reading, rather than it resting on risk acceptance. Three facts, all published by the ' +
      'Wikimedia Foundation rather than inferred. SearXNG reaches it through the generic mediawiki ' +
      'engine against {lang}.wikinews.org’s MediaWiki Action API — use_official_api: true — so this ' +
      'is the publisher’s own documented interface used for what it is documented for. Wikimedia ' +
      'publish an API etiquette that expressly contemplates automated clients and asks for a ' +
      'descriptive user agent and serial requests, which is what this connector does. And Wikinews ' +
      'content is CC BY 2.5, which permits commercial reuse with attribution, so there is no ' +
      'licence question of the kind D20 turned on. It remains a weak adverse-media source and ' +
      'nobody should pretend otherwise — a volunteer news wiki, not a wire service.',
  },
};

/** Every engine in the matrix, in declaration order. */
export const ALL_ENGINES: readonly DiscoveryEngine[] = Object.keys(
  ENGINE_GOVERNANCE,
) as readonly DiscoveryEngine[];

/**
 * Every engine the connector technically integrates.
 *
 * What `enginesConfigured` counts, and deliberately **not** filtered by governance or by any
 * tenant's switch: a diagnostic that only listed enabled engines could not answer "what happened
 * to Google?", which is the first question anybody asks of an adverse-media result.
 */
export function integratedEngines(): readonly EngineGovernanceRecord[] {
  return ALL_ENGINES.map((engine) => ENGINE_GOVERNANCE[engine]).filter(
    (record) => record.integrated,
  );
}

/** One engine's record, or null when the name is not one we integrate. */
export function engineRecord(engine: string): EngineGovernanceRecord | null {
  return (ENGINE_GOVERNANCE as Record<string, EngineGovernanceRecord | undefined>)[engine] ?? null;
}

/**
 * Our name for whatever the instance called the engine that produced a result.
 *
 * Null when the instance names an engine this matrix does not integrate. Null rather than a
 * fabricated value: an engine we cannot name is an engine nobody reviewed, and the caller treats
 * that as configuration drift rather than as an engine.
 */
export function engineFromSearxngName(name: string): DiscoveryEngine | null {
  const folded = name.trim().toLowerCase();
  return (
    ALL_ENGINES.find(
      (engine) => ENGINE_GOVERNANCE[engine].searxngEngineName.toLowerCase() === folded,
    ) ?? null
  );
}
