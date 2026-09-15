/**
 * `RssNewsDiscoveryAdapter` — the live `NewsDiscoveryPort`, Phase E step 3.
 *
 * # One connector, many sources
 *
 * This is **not** "the Google News adapter" or "the SEC adapter". It is the RSS connector, and
 * which publisher it reads is a row in the registry that somebody approved (**D-043**): the
 * address, the countries, the languages, the budgets, the stop conditions and the named
 * first-contact approval all come from the active source version, read fresh on every call.
 *
 * That is the load-bearing choice in this file. A connector with a URL compiled into it is a
 * request nobody approved, and it forces one connector per publisher — at which point the same
 * RSS parse exists three times and the third copy is the one that skips a gate. Here, adding a
 * publisher is an approval, not a deployment.
 *
 * # It has no HTTP path of its own
 *
 * Every byte this adapter reads comes through `EvidenceFetchPort` — the same transport, the same
 * SEC-02 screening inside the connection's own lookup, the same robots check with `UNKNOWN`
 * refusing, the same two byte budgets, the same per-source and per-domain breakers, the same
 * stop conditions. The phase brief is explicit about why: *"writing the discovery connectors
 * first means writing a second HTTP path that does some of that, and the weaker of two paths is
 * the one that eventually gets used for something it should not be."*
 *
 * So the only thing this file adds to the fetch path is **authorisation of its own poll**, which
 * it gets from `FetchGateService.authoriseEndpoint` — every gate a document fetch passes, on the
 * feed URL, before a socket opens.
 *
 * # Two kinds of feed, and why the difference is recorded rather than inferred
 *
 * A `FIXED_FEED` is a list the publisher maintains — the SEC's litigation releases, a gazette
 * index. It is polled whole and the planned query is matched against what came back.
 *
 * A `QUERY_FEED` takes the query as a parameter — Google News, Bing News — so every planned
 * query is a separate request to the publisher.
 *
 * The difference is the **rate**: a fixed feed costs one request per poll however many searches
 * are running; a query feed costs one per planned query, which for a bounded plan is dozens. A
 * connector that guessed would guess wrong in the expensive direction at somebody else's server,
 * so the kind is a field an approver signed.
 *
 * **The query is set as one search parameter, never spliced into a string.** The registry records
 * the parameter's *name*; this file parses the recorded endpoint, sets that one parameter, and
 * serialises. A query therefore cannot introduce a path segment, a host, a scheme, or a second
 * parameter — and the registry holds a name rather than a `{query}` template, which would be an
 * executable instruction in a record the schema deliberately keeps free of them.
 *
 * # What it will not do
 *
 * It does not classify. A `Lead` carries no category, no stage and no party role, and the type
 * makes that impossible rather than discouraged (`lead.ts`). A headline is a claim about an
 * article, not evidence from one.
 *
 * It does not report a parse failure as an empty result. A shape change on an undocumented feed
 * is the single most dangerous failure this product has — recall drops to zero while the service
 * keeps reporting clean results — so `parseFeed` distinguishes "no items" from "I did not
 * understand this", and so does this file. That is also what `contractProbe` is for.
 */

import { Logger } from '@nestjs/common';

import { canonicalise, screenUrl, type CountryCode, type PreciseDate } from '@erly/adverse-domain';

import type { EvidenceFetchPort, FetchAuthorisation } from './evidence-fetch.port.js';
import type { FetchGateService } from './fetch-gate.service.js';
import type { CascadeRung, DiscoveryQuery, Lead } from './lead.js';
import type { ContractProbeResult, NewsDiscoveryPort } from './news-discovery.port.js';
import { decodeXml, parseFeed, XML_PARSER_VERSION, type FeedItem } from './parse/xml.js';
import {
  bounded,
  failed,
  noResults,
  ok,
  stampProvenance,
  type AdapterDescriptor,
  type Clock,
  type SourceOutcome,
} from './source-adapter.js';
import type { ActiveSourceVersion, SourceVersionReader } from './source-version.service.js';

/**
 * The budget for one feed poll.
 *
 * Smaller than a document fetch's, because a feed is a list of headlines and a feed that is
 * megabytes long is a feed that has changed into something else. Redirects are allowed but few:
 * a publisher moving a feed once is normal, a chain is not.
 */
const FEED_BUDGET = {
  maxBytes: 4 * 1024 * 1024,
  maxDecompressedBytes: 16 * 1024 * 1024,
  maxRedirects: 2,
  timeoutMs: 20_000,
} as const;

/** What a caller must supply. Everything else is read from the approved source version. */
export interface RssNewsDiscoveryOptions {
  /** The registry source this adapter reads. One adapter per approved RSS source. */
  readonly sourceId: string;
  readonly versions: SourceVersionReader;
  readonly gate: FetchGateService;
  readonly fetch: EvidenceFetchPort;
  readonly clock?: Clock;
  /**
   * The conditional-GET state this adapter last saw for its endpoint, if any.
   *
   * Supplied by the caller rather than cached in the adapter: an ETag held in memory is lost on
   * every deploy, and the point of a conditional GET is that the publisher serves no body when
   * nothing changed. Persisting it is the scheduler's job (step 3's polling half).
   */
  readonly conditional?: { readonly etag: string | null; readonly lastModified: string | null };
}

export class RssNewsDiscoveryAdapter implements NewsDiscoveryPort {
  private readonly logger = new Logger('RssNewsDiscovery');
  private readonly clock: Clock;

  constructor(private readonly options: RssNewsDiscoveryOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.descriptor = {
      adapterId: 'rss-news-discovery',
      portKind: 'NEWS_DISCOVERY',
      sourceId: options.sourceId,
      parserVersion: XML_PARSER_VERSION,
      stabilityClass: 'UNDOCUMENTED_VOLATILE',
      mode: 'LIVE',
      jurisdictions: [],
    };
  }

  /**
   * The descriptor, as much of it as is knowable without reading the registry.
   *
   * `sourceId` is real; the rest describes **the parser**, not the publisher, and that is the
   * honest split. `stabilityClass` is `UNDOCUMENTED_VOLATILE` for every RSS source without
   * exception — including the SEC's, however documented the institution is — because the class is
   * a statement about a feed shape nobody has promised us, and claiming otherwise would exempt
   * the source from the scheduled contract test that detects a silent shape change (T84).
   *
   * `jurisdictions` is empty here and filled per call from the approved version: an adapter that
   * declared countries before reading the registry would be declaring them from code.
   */
  readonly descriptor: AdapterDescriptor;

  /**
   * The editions this adapter can address.
   *
   * Empty until the registry has been read, and deliberately not lazily cached: the planner asks
   * this to decide whether to issue a per-edition query, and a cached answer is one that keeps
   * claiming an edition after an administrator narrowed the source.
   */
  get editions(): readonly CountryCode[] {
    return [];
  }

  /** The editions this source is actually approved for, read now. */
  async approvedEditions(): Promise<readonly CountryCode[]> {
    const version = await this.options.versions.loadActive(this.options.sourceId);
    return version?.countries ?? [];
  }

  async discover(query: DiscoveryQuery): Promise<SourceOutcome<readonly Lead[]>> {
    const now = this.clock();
    const version = await this.options.versions.loadActive(this.options.sourceId);
    if (version === null) {
      return failed(
        this.descriptorFor(null),
        now,
        { policyRefusal: true },
        `Source ${this.options.sourceId} has no active approved version, so there is nothing ` +
          `authorising a request to it. An unapproved source is what the registry prevents.`,
      );
    }

    // The language this poll is for. The query's, when it named one; otherwise the source's own
    // first declared language — never a guess from text, and never "whatever the feed says",
    // because the language decides which lexicon a document is read under (FR-03).
    const language = query.language ?? version.languages[0] ?? null;
    if (language === null) {
      return failed(
        this.descriptorFor(version),
        now,
        { policyRefusal: true },
        `${version.sourceName} declares no language, so a poll of it could not say what ` +
          `language its items are in. A language is never inferred from the text (FR-03).`,
      );
    }

    const jurisdiction = query.country ?? version.countries[0] ?? null;
    if (jurisdiction === null) {
      return failed(
        this.descriptorFor(version),
        now,
        { policyRefusal: true },
        `${version.sourceName} declares no country, so this poll has no jurisdiction to be ` +
          `attributed to. "Worldwide" is not a jurisdiction and is never a source permission ` +
          `(FR-05, D-044).`,
      );
    }

    const endpoint = this.endpointFor(version, query);
    if (endpoint.kind === 'REFUSED') {
      return failed(this.descriptorFor(version), now, { policyRefusal: true }, endpoint.detail);
    }

    // Every gate a document fetch passes, on the feed URL, before a socket opens.
    const decision = await this.options.gate.authoriseEndpoint({
      sourceId: this.options.sourceId,
      url: endpoint.url,
      jurisdiction,
      language,
      runJurisdictions: query.run.jurisdictions,
      runLanguages: query.run.languages,
      taxonomy: query.run.taxonomy,
      now,
    });
    if (!decision.authorised) {
      return failed(
        this.descriptorFor(version),
        now,
        { policyRefusal: true },
        `${decision.refusal}: ${decision.detail}`,
      );
    }

    const result = await this.options.fetch.fetch({
      url: endpoint.url,
      attribution: {
        tenantId: query.tenantId,
        jobId: query.run.jobId,
        subjectId: query.run.subjectId,
        queryId: query.queryId,
        sourceId: this.options.sourceId,
        egressIdentityId: decision.egressIdentity.identityId,
      },
      authorisation: decision.authorisation satisfies FetchAuthorisation,
      budget: FEED_BUDGET,
      conditional: this.options.conditional ?? { etag: null, lastModified: null },
      // Deterministic per source, query and day, so a redelivered job re-uses the stored
      // response instead of asking the publisher the same thing twice (FR-06 idempotency).
      fetchKey: `${this.options.sourceId}:${query.queryId}:${now.toISOString().slice(0, 10)}`,
      allowRender: false,
    });

    if (result.status === 'FAILED') {
      // Passed through unchanged. The signal is what the FR-06 table classifies, and the fetch
      // adapter has already recorded it against source and domain health.
      return failed(this.descriptorFor(version), now, result.signal, result.detail);
    }
    if (result.status === 'NO_RESULTS' || !('data' in result)) {
      return noResults(this.descriptorFor(version), now);
    }

    if (result.data.notModified) {
      // A 304: the publisher says nothing has changed since we last read it. That is a
      // successful poll of a working source with no new items — emphatically not a failure, and
      // emphatically not evidence that nothing exists.
      this.logger.debug(`${version.sourceName}: 304, feed unchanged.`);
      return noResults(this.descriptorFor(version), now);
    }

    const body = result.data.body;
    if (body === null) {
      return failed(
        this.descriptorFor(version),
        now,
        { emptyBody: true, httpStatus: result.data.httpStatus },
        `${version.sourceName} answered ${String(result.data.httpStatus)} with no body.`,
      );
    }

    const parsed = parseFeed(decodeXml(body, charsetOf(result.data.contentType)));
    if (parsed.kind !== 'OK') {
      // Never `noResults`. A shape change, a DOCTYPE, an HTML error page served as XML — each of
      // them yields zero items, and reporting zero items would turn a broken source into clean
      // results for every subject searched through it (FR-05 volatility control, T84).
      this.logger.warn(`${version.sourceName}: ${parsed.kind} — ${parsed.detail}`);
      return failed(this.descriptorFor(version), now, parsed.signal, parsed.detail);
    }

    const rung = rungOf(version.cascadeRung);
    const leads = this.leadsFrom({
      items: parsed.feed.items,
      feedLanguage: parsed.feed.language ?? language,
      version,
      query,
      rung,
      now,
      // A fixed feed is the publisher's whole list, so the planned query has to be applied here.
      // A query feed already asked the publisher the question, and filtering their answer again
      // on our own string match would silently discard results they judged relevant.
      matchLocally: version.endpointKind === 'FIXED_FEED',
    });

    if (leads.length === 0) {
      // The feed parsed and had nothing for this query. A real, honest empty answer — the one
      // case where `noResults` is the truth.
      return noResults(this.descriptorFor(version), now);
    }

    if (leads.length > query.limit) {
      return bounded(this.descriptorFor(version), now, leads.slice(0, query.limit), {
        reason: 'SOURCE_PAGE_LIMIT',
        limit: query.limit,
        availableCount: leads.length,
      });
    }

    return ok(this.descriptorFor(version), now, leads);
  }

  /**
   * The scheduled contract test (FR-05 volatility control, T84).
   *
   * It runs **the same parser the live path uses** — a probe with its own copy of the parse
   * proves the copy still works — and it reports `shapeStable: false` when the envelope parses
   * and yields zero items, because that is exactly how this failure presents: HTTP 200, a body
   * that parses, nothing extracted, and no error anywhere.
   *
   * It goes through the gate like any other request. A probe that bypassed the gate would be a
   * scheduled job making unauthorised requests to a publisher, which is a worse problem than the
   * one it detects.
   */
  async contractProbe(): Promise<ContractProbeResult> {
    const now = this.clock();
    const version = await this.options.versions.loadActive(this.options.sourceId);
    const base: Omit<
      ContractProbeResult,
      'shapeStable' | 'fieldsMissing' | 'sampleParsedCount' | 'detail'
    > = {
      adapterId: this.descriptor.adapterId,
      parserVersion: this.descriptor.parserVersion,
      checkedAt: now.toISOString(),
    };

    if (version === null) {
      return {
        ...base,
        shapeStable: false,
        fieldsMissing: [],
        sampleParsedCount: 0,
        detail: `Source ${this.options.sourceId} has no active approved version to probe.`,
      };
    }

    const outcome = await this.discover({
      tenantId: 'contract-probe',
      run: {
        jobId: 'contract-probe',
        subjectId: 'contract-probe',
        jurisdictions: [...version.countries],
        languages: [...version.languages],
        // The probe checks the **shape**, not the taxonomy, so it runs against a taxonomy that
        // enables what the source is approved for. It is not a search and produces no findings.
        taxonomy: probeTaxonomy(version, now),
      },
      queryId: 'contract-probe',
      // A term that appears in almost any feed. The probe asks "does this still parse?", not
      // "does this source know about anyone".
      text: '',
      language: version.languages[0] ?? null,
      country: version.countries[0] ?? null,
      window: null,
      limit: 50,
    });

    if (outcome.status === 'FAILED') {
      return {
        ...base,
        shapeStable: false,
        fieldsMissing: [],
        sampleParsedCount: 0,
        detail: outcome.detail,
      };
    }

    const count = 'data' in outcome ? outcome.data.length : 0;
    const missing = 'data' in outcome ? missingFields(outcome.data) : ['item'];
    return {
      ...base,
      // Zero items is the failure, not a quiet success. See the method comment.
      shapeStable: count > 0 && missing.length === 0,
      fieldsMissing: missing,
      sampleParsedCount: count,
      detail:
        count === 0
          ? `${version.sourceName} answered and the parse extracted zero items. That is how a ` +
            `silent shape change presents: nothing throws, and recall goes to zero while the ` +
            `service keeps reporting clean results (T84).`
          : missing.length === 0
            ? ''
            : `Fields absent from every item: ${missing.join(', ')}.`,
    };
  }

  /**
   * The endpoint to read, built from the approved version.
   *
   * For a `QUERY_FEED` the planned query is set as **one search parameter** on the parsed
   * endpoint. Setting a parameter rather than building a string is what keeps a query from
   * introducing a path, a host or a second parameter — and the result is screened again by
   * `screenUrl` here, before the gate screens it a third time, because this is the one URL in
   * the system assembled from two sources rather than taken whole.
   */
  private endpointFor(
    version: ActiveSourceVersion,
    query: DiscoveryQuery,
  ): { kind: 'URL'; url: string } | { kind: 'REFUSED'; detail: string } {
    if (version.endpointUrl === null) {
      return {
        kind: 'REFUSED',
        detail:
          `${version.sourceName} records no endpoint, so there is no address to poll. A ` +
          `connector never invents one — the address is part of what an approver signed (D-043).`,
      };
    }

    if (version.endpointKind === 'FIXED_FEED') {
      return { kind: 'URL', url: version.endpointUrl };
    }

    if (version.queryParam === null) {
      return {
        kind: 'REFUSED',
        detail:
          `${version.sourceName} is recorded as a QUERY_FEED and names no query parameter, so ` +
          `this connector would have to guess where the query goes. A guess aimed at a third ` +
          `party's server is not one worth making.`,
      };
    }

    let url: URL;
    try {
      url = new URL(version.endpointUrl);
    } catch {
      return {
        kind: 'REFUSED',
        detail: `${version.sourceName} records an endpoint that is not a URL.`,
      };
    }
    url.searchParams.set(version.queryParam, query.text);

    const screening = screenUrl(url.toString());
    if (!screening.allowed) {
      return {
        kind: 'REFUSED',
        detail:
          `The endpoint built for ${version.sourceName} was refused by the SEC-02 address ` +
          `policy (${screening.rejection ?? 'REJECTED'}): ${screening.detail ?? url.toString()}`,
      };
    }
    return { kind: 'URL', url: url.toString() };
  }

  /** Turn parsed feed items into leads, dropping anything that cannot honestly become one. */
  private leadsFrom(input: {
    readonly items: readonly FeedItem[];
    readonly feedLanguage: string;
    readonly version: ActiveSourceVersion;
    readonly query: DiscoveryQuery;
    readonly rung: CascadeRung;
    readonly now: Date;
    readonly matchLocally: boolean;
  }): readonly Lead[] {
    const provenance = stampProvenance(this.descriptorFor(input.version), input.now);
    const leads: Lead[] = [];
    const seen = new Set<string>();

    for (const item of input.items) {
      if (item.link === null || item.title === null) {
        // A feed entry with no link is not a lead: there is nothing to fetch. Recording it with
        // a synthesised URL would put an address in the record that the publisher never gave.
        continue;
      }

      const screening = screenUrl(item.link);
      if (!screening.allowed || screening.canonical === null) {
        // Refused here rather than carried to the gate: a lead the policy will refuse is not a
        // lead, and carrying it would put a URL we may never fetch into the coverage view as
        // though it were a candidate.
        continue;
      }

      if (input.matchLocally && !matchesQuery(input.query.text, item)) {
        continue;
      }

      const canonical = canonicalise(new URL(screening.canonical));
      if (seen.has(canonical)) {
        // The same story twice in one feed. One lead, or axis D counts one story as two
        // independent sources (FR-10).
        continue;
      }
      seen.add(canonical);

      leads.push({
        leadId: `lead-${hash(canonical)}`,
        url: canonical,
        title: item.title,
        // Exactly what the feed said, or null. Never synthesised from the title: a snippet is
        // what a relevance filter scores, and a fabricated one would be scored as though the
        // publisher had written it.
        snippet: item.summary,
        publisher: input.version.sourceName,
        publisherDomain: new URL(canonical).hostname,
        publishedAt: parsePublished(item.publishedAtRaw),
        // The feed's declared language, or the source's. Never sniffed from the text.
        language: input.feedLanguage,
        rung: input.rung,
        queryId: input.query.queryId,
        provenance,
      });
    }

    return leads;
  }

  /**
   * The descriptor for a record produced under a given version.
   *
   * `jurisdictions` comes from the approved version rather than from this file, so a coverage
   * view grouping by country reads what an approver signed. `parserVersion` combines the XML
   * parser's version with the source's own recorded one, because both can change the parse and a
   * contract probe keyed on only one of them would miss the other.
   */
  private descriptorFor(version: ActiveSourceVersion | null): AdapterDescriptor {
    if (version === null) {
      return this.descriptor;
    }
    return {
      ...this.descriptor,
      jurisdictions: [...version.countries],
      parserVersion: `${XML_PARSER_VERSION}+${version.sourceId}`,
    };
  }
}

/** The FR-05 rung this source answers at, clamped to the eight the table defines. */
function rungOf(cascadeRung: number): CascadeRung {
  const rung = Math.trunc(cascadeRung);
  return (rung < 0 ? 0 : rung > 7 ? 7 : rung) as CascadeRung;
}

/** The charset from a `Content-Type`, for `decodeXml`. Null when the header names none. */
function charsetOf(contentType: string | null): string | null {
  if (contentType === null) {
    return null;
  }
  return /charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(contentType)?.[1] ?? null;
}

/**
 * Does this item match the planned query?
 *
 * Only ever applied to a `FIXED_FEED`, where the publisher was not asked the question and the
 * feed is their whole list. Deliberately dumb: every whitespace-separated term of the query must
 * appear, case- and accent-insensitively, in the title or the summary.
 *
 * **This is not relevance filtering and it is not a judgement about adversity.** It decides
 * whether a headline is about the person the query names, and nothing else. FR-06's nine-signal
 * relevance filter is step 4, and its weights are to be set against the labelled corpus rather
 * than guessed here.
 */
function matchesQuery(text: string, item: FeedItem): boolean {
  const terms = fold(text)
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) {
    // An empty query matches the whole feed. That is what the contract probe asks for, and a
    // planned query is never empty (`assertPlanIsEntityAnchored`).
    return true;
  }
  const haystack = `${fold(item.title ?? '')} ${fold(item.summary ?? '')}`;
  return terms.every((term) => haystack.includes(term));
}

/**
 * Case- and accent-folded, so `Solís` in a headline matches `Solis` in a query.
 *
 * Folding accents is the right direction here and the wrong one for identity matching: it widens
 * what is *considered*, and every candidate still goes through Axis A, which does not fold.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The publication date a feed declared, with its precision.
 *
 * FR-07: a missing date stays null rather than becoming the retrieval date, and an unparsable one
 * does too. Backfilling either would put a date on a finding that no publisher ever stated, and
 * the date is what an event's recency is judged on.
 *
 * Precision is `DAY` rather than a finer value even when the feed gives a time, because the day
 * is what a reviewer reasons about and claiming minute precision from an RSS `pubDate` — which
 * publishers routinely set to the time of *generation* — would be precision we do not have.
 */
function parsePublished(raw: string | null): PreciseDate {
  if (raw === null) {
    return { value: null, precision: 'UNKNOWN' };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return { value: null, precision: 'UNKNOWN' };
  }
  return { value: new Date(parsed).toISOString().slice(0, 10), precision: 'DAY' };
}

/** Which fields no item in the sample carried. The actionable half of a contract probe. */
function missingFields(leads: readonly Lead[]): readonly string[] {
  if (leads.length === 0) {
    return ['item'];
  }
  const missing: string[] = [];
  if (leads.every((lead) => lead.title.trim() === '')) {
    missing.push('item/title');
  }
  if (leads.every((lead) => lead.publishedAt.value === null)) {
    missing.push('item/pubDate');
  }
  return missing;
}

/**
 * A minimal taxonomy for the contract probe.
 *
 * The probe asks whether the feed still parses, not whether anything in it is adverse, so it runs
 * against a taxonomy that enables exactly what the source is approved for and declares no terms.
 * It produces no findings and is never stored — but it must pass the gate, because a probe that
 * bypassed the gate would be a scheduled job making unauthorised requests to a publisher.
 */
function probeTaxonomy(version: ActiveSourceVersion, now: Date): DiscoveryQuery['run']['taxonomy'] {
  return {
    taxonomyVersionId: `contract-probe:${version.sourceId}`,
    version: version.version,
    tenantId: 'contract-probe',
    categories: [
      {
        category: 'FRAUD_FINANCIAL_CRIME',
        severityWeight: 1,
        enabledCountries: [...version.countries],
      },
    ],
    lexicon: [],
    languages: version.languages.map((language) => ({
      language,
      measuredRecall: null,
      measuredByEvaluationRunId: null,
    })),
    status: 'ACTIVE',
    proposedBy: 'contract-probe',
    approvedBy: 'contract-probe',
    activatedAt: now.toISOString(),
  };
}

/**
 * A short, stable hash of a canonical URL, for a deterministic lead id.
 *
 * Deterministic within and across runs, so the same article found at rung 2 and again at rung 4
 * is one lead with two sightings. Not cryptographic and does not need to be: a collision costs
 * two articles sharing an id inside one run's deduplication, and the canonical URL is compared
 * as well.
 */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
