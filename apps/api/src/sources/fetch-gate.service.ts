/**
 * `FetchGateService` — the only thing that issues a `FetchAuthorisation`.
 *
 * Phase E step 2. It replaces an object the pipeline used to build inline:
 *
 * ```ts
 * authorisation: {
 *   sourceVersionId: 'fixture-source-v1',
 *   robotsPosition: 'HONOURED',
 *   jurisdictionEnabled: true,
 *   languageEnabled: true,
 *   urlPolicyPassed: true,
 *   ssrfValidated: true,
 *   relevanceScore: 0.9,
 * }
 * ```
 *
 * Not one field of which was derived from anything. Against `MockEvidenceFetchAdapter` that was
 * harmless — the mock reads the record and returns a fixture. Against the real adapter built in
 * step 1 it is a signed statement that five FR-06 gates were passed which were never run, sitting
 * in the one record whose entire purpose is to be audited afterwards. `urlPolicyPassed: true`
 * asserted that SEC-02 screening had happened on a URL nothing had screened.
 *
 * # What "derived" means here, field by field
 *
 * | Field | Where it comes from |
 * | :--- | :--- |
 * | `sourceVersionId` | the **active approved version** of the lead's source, read now |
 * | `licenceTermsVersion` | that version's recorded terms, checked unexpired against `now` |
 * | `jurisdictionEnabled` | the run's pinned scope ∩ the source's countries ∩ the pinned taxonomy |
 * | `languageEnabled` | the lead's declared language ∩ the taxonomy's ∩ the source's |
 * | `urlPolicyPassed` | `screenUrl` run on this exact URL, here |
 * | `ssrfValidated` | the literal half run here; the resolved half structural in the transport |
 * | `robotsPosition` | the approved version's recorded position, not an assumption |
 * | `relevanceScore` | computed from the lead's own text against the subject's name forms |
 *
 * Every refusal names which gate refused and says so in a sentence a reviewer reads. A refusal
 * is **never** a silent skip: the caller records the lead with the reason, and where the refusal
 * is a property of the source rather than of one URL, it is also a coverage gap.
 *
 * # Three judgements worth arguing with
 *
 * **`EXCEPTION_APPROVED` is refused, deliberately.** FR-06 requires a robots exception to be
 * approved by a named person, and `sourceContentSchema` has nowhere to record one — that is open
 * decision **D6**, and it is owned by a source admin, not by engineering. So while D6 is open no
 * exception can be applied at all, and a source that needs one is refused and says so. The safe
 * direction, recorded as provisional in `docs/open-decisions.md` so it cannot harden into the
 * answer by default.
 *
 * **A fixture is not a publisher.** The six mock sources are registered with
 * `robotsPosition: 'NOT_ESTABLISHED'`, which is true of them: nobody established a position for a
 * local fixture, because there is no publisher to establish one with. The old inline record
 * claimed `HONOURED` to get past the gate. This issues `FIXTURE_NOT_A_PUBLISHER` instead — only
 * in a mock-mode process, only for a `FIXTURE_MOCK` connector — and `HttpEvidenceFetchAdapter`
 * refuses that value outright, so a fixture authorisation cannot reach a real host.
 *
 * **The relevance score is preliminary, and says so.** FR-06's nine-signal relevance filter is
 * step 4, and its weights are to be set against the FR-16 labelled corpus rather than guessed
 * here. What this computes is a name-presence score over the lead's own title and snippet: real,
 * derived, deterministic — and carried with `relevanceMethod` naming it, so a reviewer can tell
 * it from the measured one that replaces it. **It does not gate.** A threshold chosen before the
 * corpus has been consulted would silently drop leads on a number nobody validated.
 *
 * # What this service does not do
 *
 * It does not fetch robots.txt — the adapter does that, per host, at the moment it fetches, and
 * caches it. The *position* here is what the registry recorded; the *verdict* is what the
 * publisher's live robots.txt says, and both have to pass.
 *
 * It does not check source health. That is `SourceHealthService`, called at the point of use by
 * the pipeline (rights and breaker, non-spending) and by the adapter (per request, spending).
 * Duplicating it here would spend the budget a third time or, worse, decide it twice.
 */

import { Injectable, Logger } from '@nestjs/common';

import { resolveEffectiveScope, screenUrl, type TaxonomyVersion } from '@erly/adverse-domain';

import { buildEgressIdentity, type EgressIdentityOptions } from './egress-identity.js';
import type { EgressIdentity, FetchAuthorisation } from './evidence-fetch.port.js';
import type { OperatingMode } from './source-adapter.js';
import type { ActiveSourceVersion, SourceVersionReader } from './source-version.service.js';

/** How the preliminary score was produced. Recorded on every authorisation this gate issues. */
export const PRELIMINARY_RELEVANCE_METHOD = 'PRELIMINARY_NAME_PRESENCE_v1';

/**
 * Recorded instead of a score when a source's **own endpoint** is polled.
 *
 * A feed is the list, not an item on it, so nothing has been judged relevant. `relevanceScore` is
 * null alongside this, rather than a 1 chosen to satisfy the type — see the field's comment in
 * `evidence-fetch.port.ts`.
 */
export const ENDPOINT_POLL_RELEVANCE_METHOD = 'NOT_APPLICABLE_ENDPOINT_POLL';

/** The issuer recorded on every authorisation. There is one, and this is it. */
export const FETCH_GATE_ISSUER = 'FetchGateService';

/**
 * Why a fetch was not authorised.
 *
 * A closed union rather than a message, because two of these are properties of the **source**
 * and the rest are properties of **one URL** — and the caller has to tell them apart to decide
 * whether the run has a coverage gap or merely a rejected lead. `sourceLevel` below is that
 * distinction, in one place rather than at each call site.
 */
export type FetchGateRefusal =
  | 'NO_ACTIVE_SOURCE_VERSION'
  | 'LICENCE_TERMS_NOT_RECORDED'
  | 'LICENCE_EXPIRED'
  | 'JURISDICTION_NOT_IN_RUN_SCOPE'
  | 'SOURCE_DOES_NOT_COVER_JURISDICTION'
  | 'JURISDICTION_NOT_ENABLED'
  | 'LANGUAGE_NOT_DECLARED_BY_LEAD'
  | 'LANGUAGE_NOT_ENABLED'
  | 'SOURCE_DOES_NOT_COVER_LANGUAGE'
  | 'URL_POLICY_REJECTED'
  | 'ROBOTS_POSITION_NOT_ESTABLISHED'
  | 'ROBOTS_EXCEPTION_NOT_APPROVABLE'
  | 'FIXTURE_SOURCE_IN_LIVE_MODE'
  | 'NO_FIRST_CONTACT_APPROVAL'
  | 'NO_ENDPOINT_RECORDED'
  | 'NO_EGRESS_IDENTITY';

/**
 * Is this refusal about the source, or about this one URL?
 *
 * A source-level refusal costs every lead from that source and belongs in the coverage statement:
 * a reviewer reading a narrow result needs to know a whole source was excluded. A URL-level one
 * is recorded against the lead, where it is the reason that lead went no further.
 */
export function isSourceLevelRefusal(refusal: FetchGateRefusal): boolean {
  switch (refusal) {
    case 'NO_ACTIVE_SOURCE_VERSION':
    case 'LICENCE_TERMS_NOT_RECORDED':
    case 'LICENCE_EXPIRED':
    case 'SOURCE_DOES_NOT_COVER_JURISDICTION':
    case 'SOURCE_DOES_NOT_COVER_LANGUAGE':
    case 'ROBOTS_POSITION_NOT_ESTABLISHED':
    case 'ROBOTS_EXCEPTION_NOT_APPROVABLE':
    case 'FIXTURE_SOURCE_IN_LIVE_MODE':
    case 'NO_FIRST_CONTACT_APPROVAL':
    case 'NO_ENDPOINT_RECORDED':
    case 'NO_EGRESS_IDENTITY':
      return true;
    case 'JURISDICTION_NOT_IN_RUN_SCOPE':
    case 'JURISDICTION_NOT_ENABLED':
    case 'LANGUAGE_NOT_DECLARED_BY_LEAD':
    case 'LANGUAGE_NOT_ENABLED':
    case 'URL_POLICY_REJECTED':
      return false;
  }
}

export type FetchGateDecision =
  | {
      readonly authorised: true;
      readonly authorisation: FetchAuthorisation;
      readonly egressIdentity: EgressIdentity;
      readonly sourceVersion: ActiveSourceVersion;
    }
  | {
      readonly authorised: false;
      readonly refusal: FetchGateRefusal;
      /** A sentence a reviewer reads, naming the gate and what it found. */
      readonly detail: string;
      /** Null when there was no active version to name. */
      readonly sourceVersion: ActiveSourceVersion | null;
    };

export interface FetchGateInput {
  /** The source whose approval would permit this fetch — for a lead, the discovery source. */
  readonly sourceId: string;
  readonly url: string;
  /** The planned query's jurisdiction. */
  readonly jurisdiction: string;
  /** The lead's declared language. Null when the source declared none — never guessed. */
  readonly language: string | null;
  /** The run's pinned requested scope. A jurisdiction outside it was never asked for. */
  readonly runJurisdictions: readonly string[];
  readonly runLanguages: readonly string[];
  /** The taxonomy version pinned to the run (FR-03), never the currently active one. */
  readonly taxonomy: TaxonomyVersion;
  /** Subject name and aliases, for the preliminary relevance score. */
  readonly subjectNameForms: readonly string[];
  /** The lead's own text. The snippet is whatever the source returned, never synthesised. */
  readonly leadTitle: string;
  readonly leadSnippet: string | null;
  readonly now: Date;
}

/**
 * What a poll of a source's own endpoint needs.
 *
 * Deliberately smaller than `FetchGateInput`: no lead, no subject name forms, no snippet, because
 * none of them exists yet. The URL is optional and defaults to the recorded endpoint — a caller
 * supplies one only to add the query parameter to a `QUERY_FEED`, and what it supplies is checked
 * against the recorded endpoint's origin by the connector before it gets here.
 */
export interface EndpointGateInput {
  readonly sourceId: string;
  /** The endpoint with the query parameter set, or omitted to poll it as recorded. */
  readonly url?: string | undefined;
  readonly jurisdiction: string;
  /** The language this poll is for — one the source declares, never one inferred. */
  readonly language: string;
  readonly runJurisdictions: readonly string[];
  readonly runLanguages: readonly string[];
  readonly taxonomy: TaxonomyVersion;
  readonly now: Date;
}

export interface ScheduledArtifactGateInput {
  readonly sourceId: string;
  readonly url: string;
  readonly now: Date;
}

@Injectable()
export class FetchGateService {
  private readonly logger = new Logger('FetchGate');
  private readonly egressIdentity: EgressIdentity | null;

  constructor(
    private readonly sourceVersions: SourceVersionReader,
    private readonly mode: OperatingMode,
    egress: EgressIdentityOptions,
  ) {
    this.egressIdentity = buildEgressIdentity(egress);
    if (this.egressIdentity === null) {
      this.logger.warn(
        'No egress identity: FETCH_CONTACT_URL is unset, so no request can be attributed to an ' +
          'identity that exists. Every fetch is refused rather than made anonymously (FR-06).',
      );
    }
  }

  /**
   * Authorise one fetch, or refuse it with a reason.
   *
   * The order is the order a refusal is cheapest to explain in, not the order of the FR-06 table:
   * the URL first, because a URL the policy rejects is refused whatever the registry says about
   * the source; then the approval, because everything after it is read off the approved version.
   */
  async authorise(input: FetchGateInput): Promise<FetchGateDecision> {
    return this.authoriseUrl(input, () => ({
      score: preliminaryRelevance({
        nameForms: input.subjectNameForms,
        title: input.leadTitle,
        snippet: input.leadSnippet,
      }),
      method: PRELIMINARY_RELEVANCE_METHOD,
    }));
  }

  /**
   * Authorise a poll of a source's **own endpoint** — its feed, its index — rather than a fetch
   * of a document discovered through it.
   *
   * Every gate `authorise` runs, runs here too, and that is the point of it being one function
   * underneath: a second path to a socket that checked four of the six things is how the weaker
   * path becomes the one that gets used. What differs is only what cannot apply:
   *
   * - **the URL is the recorded endpoint**, read off the approved version rather than supplied by
   *   a caller. A connector that could name its own URL would be a connector that could fetch
   *   anything under a source's approval (**D-043**).
   * - **relevance is null**, with `ENDPOINT_POLL_RELEVANCE_METHOD` saying why. The feed is the
   *   list; nothing on it has been judged yet.
   * - **the language is the source's**, not a lead's, because a feed has no per-item language
   *   until it has been parsed. The run's enabled languages must still intersect it.
   *
   * The query text, for a `QUERY_FEED`, is set by the **caller** as one search parameter on the
   * parsed endpoint — never spliced into a string here. See `RssNewsDiscoveryAdapter`.
   */
  async authoriseEndpoint(input: EndpointGateInput): Promise<FetchGateDecision> {
    const version = await this.sourceVersions.loadActive(input.sourceId);
    if (version === null) {
      return this.refuse(
        'NO_ACTIVE_SOURCE_VERSION',
        `Source ${input.sourceId} has no active approved version, so nothing authorises a ` +
          `request to it.`,
        null,
      );
    }
    if (version.endpointUrl === null) {
      return this.refuse(
        'NO_ENDPOINT_RECORDED',
        `${version.sourceName} records no endpoint, so there is no address a poll could read. ` +
          `A connector never invents one: the address is part of what an approver signed ` +
          `(D-043). Record accessPolicy.endpointUrl on the version.`,
        version,
      );
    }

    return this.authoriseUrl(
      {
        sourceId: input.sourceId,
        url: input.url ?? version.endpointUrl,
        jurisdiction: input.jurisdiction,
        // A feed's language is the source's declared one. Never guessed, and never a lead's,
        // because no item has been parsed yet.
        language: input.language,
        runJurisdictions: input.runJurisdictions,
        runLanguages: input.runLanguages,
        taxonomy: input.taxonomy,
        subjectNameForms: [],
        leadTitle: '',
        leadSnippet: null,
        now: input.now,
      },
      () => ({ score: null, method: ENDPOINT_POLL_RELEVANCE_METHOD }),
    );
  }

  /**
   * Authorise a scheduler-owned publisher artifact fetch.
   *
   * This deliberately has no tenant taxonomy or subject. Refreshing an approved shared dataset
   * is a platform operation; inventing a tenant scope merely to pass the document gate would put
   * false provenance on every refresh. The source-level controls remain identical.
   */
  async authoriseScheduledArtifact(
    input: ScheduledArtifactGateInput,
  ): Promise<FetchGateDecision> {
    const screening = screenUrl(input.url);
    if (!screening.allowed) {
      return this.refuse(
        'URL_POLICY_REJECTED',
        `The scheduled artifact URL was refused by the SEC-02 address policy ` +
          `(${screening.rejection ?? 'REJECTED'}): ${screening.detail ?? input.url}`,
        null,
      );
    }
    const version = await this.sourceVersions.loadActive(input.sourceId);
    if (version === null) {
      return this.refuse(
        'NO_ACTIVE_SOURCE_VERSION',
        `Source ${input.sourceId} has no active approved version.`,
        null,
      );
    }
    if (!version.connectorType.startsWith('INDEXED_')) {
      return this.refuse(
        'NO_ENDPOINT_RECORDED',
        `${version.sourceName} is not an indexed scheduled connector.`,
        version,
      );
    }
    if (version.endpointUrl === null || version.endpointUrl !== input.url) {
      return this.refuse(
        'NO_ENDPOINT_RECORDED',
        `${version.sourceName} does not record this exact scheduled artifact URL.`,
        version,
      );
    }
    if (version.licenceTermsVersion === null) {
      return this.refuse(
        'LICENCE_TERMS_NOT_RECORDED',
        `${version.sourceName} records no licence terms version.`,
        version,
      );
    }
    if (
      version.licenceExpiresAt !== null &&
      Date.parse(version.licenceExpiresAt) <= input.now.getTime()
    ) {
      return this.refuse(
        'LICENCE_EXPIRED',
        `The recorded licence terms for ${version.sourceName} expired at ${version.licenceExpiresAt}.`,
        version,
      );
    }
    if (version.firstContactApproval === null) {
      return this.refuse(
        'NO_FIRST_CONTACT_APPROVAL',
        `${version.sourceName} has no named first-contact approval for scheduled ingestion.`,
        version,
      );
    }
    const robots = this.robotsPositionFor(version, false);
    if (robots === null) {
      return this.refuse(
        version.robotsPosition === 'EXCEPTION_APPROVED'
          ? 'ROBOTS_EXCEPTION_NOT_APPROVABLE'
          : 'ROBOTS_POSITION_NOT_ESTABLISHED',
        `${version.sourceName} has no usable recorded robots decision for this artifact.`,
        version,
      );
    }
    if (this.egressIdentity === null) {
      return this.refuse(
        'NO_EGRESS_IDENTITY',
        'This process has no attributable outbound egress identity.',
        version,
      );
    }

    return {
      authorised: true,
      sourceVersion: version,
      egressIdentity: this.egressIdentity,
      authorisation: {
        sourceVersionId: version.versionId,
        licenceTermsVersion: version.licenceTermsVersion,
        robotsPosition: robots,
        robotsExceptionApprovedBy: null,
        requestCeilingPerSecond: version.requestCeilingPerSecond,
        jurisdictionEnabled: true,
        languageEnabled: true,
        urlPolicyPassed: true,
        ssrfValidated: true,
        relevanceScore: null,
        relevanceMethod: 'SCHEDULED_PUBLISHER_ARTIFACT',
        issuedBy: FETCH_GATE_ISSUER,
        issuedAt: input.now.toISOString(),
      },
    };
  }

  private async authoriseUrl(
    input: FetchGateInput,
    relevance: () => { readonly score: number | null; readonly method: string },
  ): Promise<FetchGateDecision> {
    const screening = screenUrl(input.url);
    if (!screening.allowed) {
      return this.refuse(
        'URL_POLICY_REJECTED',
        `The URL was refused by the SEC-02 address policy (${screening.rejection ?? 'REJECTED'}): ` +
          (screening.detail ?? input.url),
        null,
      );
    }

    const version = await this.sourceVersions.loadActive(input.sourceId);
    if (version === null) {
      return this.refuse(
        'NO_ACTIVE_SOURCE_VERSION',
        `Source ${input.sourceId} has no active approved version, so nothing authorises a ` +
          `request to it. An unapproved source is what the registry exists to prevent.`,
        null,
      );
    }

    if (version.licenceTermsVersion === null) {
      return this.refuse(
        'LICENCE_TERMS_NOT_RECORDED',
        `The active version of ${version.sourceName} records no licence terms version, so there ` +
          `are no terms this fetch could be made under.`,
        version,
      );
    }
    if (
      version.licenceExpiresAt !== null &&
      Date.parse(version.licenceExpiresAt) <= input.now.getTime()
    ) {
      return this.refuse(
        'LICENCE_EXPIRED',
        `The recorded licence terms for ${version.sourceName} (${version.licenceTermsVersion}) ` +
          `expired at ${version.licenceExpiresAt}. Fetching past recorded terms is the one thing ` +
          `the licence clock exists to stop (T36).`,
        version,
      );
    }

    // Fixture sources, both directions. In mock mode they are the only sources there are; in live
    // mode a fixture authorising a real request is the T55 hazard exactly.
    const isFixture = version.connectorType === 'FIXTURE_MOCK';
    if (isFixture && this.mode === 'LIVE') {
      return this.refuse(
        'FIXTURE_SOURCE_IN_LIVE_MODE',
        `${version.sourceName} is a FIXTURE_MOCK connector and this is a live process. Fixture ` +
          `data must never be servable as a live result (T55).`,
        version,
      );
    }

    // **D-042 — no live request to a publisher nobody accepted contact with.**
    //
    // D17 asked who approved the first deliberate live request and was answered for one source.
    // This generalises that answer rather than leaving it a one-off: every source needs a named
    // person recorded on its approved version before this service will speak to its publisher.
    //
    // It is deliberately separate from the version's own approval. Approving a registry entry
    // says the configuration is right — the domains, the countries, the budgets. This says
    // somebody accepted that we would begin making requests to a third party who did not ask to
    // hear from us, which is a different thing to be responsible for, and the difference is
    // invisible if one signature covers both.
    //
    // Mock mode is exempt because no publisher is involved; the fixture gate above has already
    // established that a fixture cannot be live.
    if (!isFixture && version.firstContactApproval === null) {
      return this.refuse(
        'NO_FIRST_CONTACT_APPROVAL',
        `${version.sourceName} has no recorded first-contact approval, so no named person has ` +
          `accepted that this service would begin making requests to this publisher. The source ` +
          `is configured and approved as a registry entry and is still not reachable — that ` +
          `separation is deliberate (D17, D-042). Record ` +
          `accessPolicy.firstContactApproval on the version through the approval lifecycle.`,
        version,
      );
    }

    if (!input.runJurisdictions.includes(input.jurisdiction)) {
      return this.refuse(
        'JURISDICTION_NOT_IN_RUN_SCOPE',
        `This search was scoped to ${input.runJurisdictions.join(', ') || 'no jurisdiction'} and ` +
          `this lead is attributed to ${input.jurisdiction}, which it never asked for.`,
        version,
      );
    }
    if (
      version.jurisdictionScope !== 'GLOBAL' &&
      !version.countries.includes(input.jurisdiction)
    ) {
      return this.refuse(
        'SOURCE_DOES_NOT_COVER_JURISDICTION',
        `${version.sourceName} is approved for ${version.countries.join(', ') || 'no country'} ` +
          `and this lead is attributed to ${input.jurisdiction}. Out-of-jurisdiction coverage is ` +
          `never inferred (FR-05).`,
        version,
      );
    }

    const scope = resolveEffectiveScope({
      taxonomy: input.taxonomy,
      country: input.jurisdiction,
      requestedLanguages: input.runLanguages,
    });
    if (scope.categories.length === 0) {
      return this.refuse(
        'JURISDICTION_NOT_ENABLED',
        `The taxonomy version pinned to this run enables no category for ${input.jurisdiction}, ` +
          `so there is nothing this fetch could be looking for there.`,
        version,
      );
    }

    // The lead's language, or the run's when the source declared none for the lead. Never
    // guessed from the text: a guessed language decides which lexicon a document is read under.
    const language = input.language;
    if (language === null) {
      return this.refuse(
        'LANGUAGE_NOT_DECLARED_BY_LEAD',
        `The discovery source declared no language for this lead. A language is never inferred ` +
          `from the text, because it decides which lexicon the document is read under (FR-03).`,
        version,
      );
    }
    if (!scope.languages.includes(language)) {
      return this.refuse(
        'LANGUAGE_NOT_ENABLED',
        `The taxonomy version pinned to this run declares no terms in ${language}, so a document ` +
          `in it cannot be read under this run's taxonomy (FR-03).`,
        version,
      );
    }
    if (!version.languages.includes(language)) {
      return this.refuse(
        'SOURCE_DOES_NOT_COVER_LANGUAGE',
        `${version.sourceName} is approved for ${version.languages.join(', ') || 'no language'} ` +
          `and this lead is in ${language}.`,
        version,
      );
    }

    const robots = this.robotsPositionFor(version, isFixture);
    if (robots === null) {
      return version.robotsPosition === 'EXCEPTION_APPROVED'
        ? this.refuse(
            'ROBOTS_EXCEPTION_NOT_APPROVABLE',
            `${version.sourceName} is recorded as EXCEPTION_APPROVED, and FR-06 requires a ` +
              `robots exception to name the person who approved it. There is nowhere in the ` +
              `registry to record that name — open decision D6, owned by a source admin — so no ` +
              `exception can be applied and this source is refused rather than fetched on an ` +
              `unattributed one.`,
            version,
          )
        : this.refuse(
            'ROBOTS_POSITION_NOT_ESTABLISHED',
            `${version.sourceName} has no established robots position, so nothing says this ` +
              `publisher permits being fetched. "Not established" is not permission.`,
            version,
          );
    }

    if (this.egressIdentity === null) {
      return this.refuse(
        'NO_EGRESS_IDENTITY',
        `This process has no egress identity, so a request could not be attributed to anyone. ` +
          `FR-06: an unattributable outbound request is a defect.`,
        version,
      );
    }

    const scored = relevance();

    return {
      authorised: true,
      sourceVersion: version,
      egressIdentity: this.egressIdentity,
      authorisation: {
        sourceVersionId: version.versionId,
        licenceTermsVersion: version.licenceTermsVersion,
        robotsPosition: robots,
        // Always null while D6 is open: the only path that would set it is refused above.
        robotsExceptionApprovedBy: null,
        requestCeilingPerSecond: version.requestCeilingPerSecond,
        jurisdictionEnabled: true,
        languageEnabled: true,
        urlPolicyPassed: true,
        // The literal half ran three hundred lines up, in `screenUrl`; the resolved half runs
        // inside the connection's own `lookup` on every hop (D-034). See the field's own comment
        // in `evidence-fetch.port.ts` for exactly what this asserts.
        ssrfValidated: true,
        relevanceScore: scored.score,
        relevanceMethod: scored.method,
        issuedBy: FETCH_GATE_ISSUER,
        issuedAt: input.now.toISOString(),
      },
    };
  }

  /**
   * The robots position to record, or `null` when the source has none that permits a fetch.
   *
   * `HONOURED` means the adapter will read and obey the publisher's live robots.txt — the
   * position is permission to *ask*, not permission to fetch any path.
   */
  private robotsPositionFor(
    version: ActiveSourceVersion,
    isFixture: boolean,
  ): FetchAuthorisation['robotsPosition'] | null {
    if (isFixture) {
      // Mock mode only; the live branch was refused above. There is no publisher behind a
      // fixture, so there is no position to honour, and saying `HONOURED` would be a statement
      // about a robots.txt that does not exist.
      return 'FIXTURE_NOT_A_PUBLISHER';
    }
    return version.robotsPosition === 'HONOURED' ? 'HONOURED' : null;
  }

  private refuse(
    refusal: FetchGateRefusal,
    detail: string,
    sourceVersion: ActiveSourceVersion | null,
  ): FetchGateDecision {
    this.logger.warn(`${refusal}: ${detail}`);
    return { authorised: false, refusal, detail, sourceVersion };
  }
}

/**
 * A preliminary relevance score: does the lead's own text name the subject?
 *
 * Deterministic, derived and **not a substitute for FR-06's nine signals** (step 4). It answers
 * one narrow question from what discovery actually returned, which is more than the constant
 * `0.9` it replaces answered.
 *
 * - 1 when a whole name form appears in the title or snippet.
 * - otherwise the best fraction of a name form's tokens that appear, over all name forms.
 * - 0 when the source returned a title and no snippet that names nobody — which is a real and
 *   common case, and one a reviewer should be able to see rather than have hidden behind a
 *   rounded-up default.
 *
 * Exported for the tests, because a scoring function nobody can call directly is a scoring
 * function nobody checks.
 */
export function preliminaryRelevance(input: {
  readonly nameForms: readonly string[];
  readonly title: string;
  readonly snippet: string | null;
}): number {
  const haystack = fold(`${input.title} ${input.snippet ?? ''}`);
  if (haystack === '') {
    return 0;
  }

  let best = 0;
  for (const form of input.nameForms) {
    const folded = fold(form);
    if (folded === '') {
      continue;
    }
    if (haystack.includes(folded)) {
      return 1;
    }
    const tokens = folded.split(' ').filter((token) => token.length > 1);
    if (tokens.length === 0) {
      continue;
    }
    const present = tokens.filter((token) => haystack.includes(token)).length;
    best = Math.max(best, present / tokens.length);
  }
  // Two decimals: the number is a score, not a measurement, and printing it to fifteen places
  // would suggest a precision the method does not have.
  return Math.round(best * 100) / 100;
}

/** Fold for comparison: diacritics stripped, case folded, whitespace collapsed. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
