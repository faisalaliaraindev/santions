/**
 * `GdeltDiscoveryAdapter` — rung 3 of the FR-05 ladder.
 *
 * GDELT DOC 2.0 returns **JSON**, not a feed, so it needs its own parse where the RSS rungs share
 * one. Everything else it shares: the endpoint comes from the registry (**D-043**), the poll is
 * authorised by the same gate a document fetch passes, and every byte arrives through
 * `EvidenceFetchPort` — so it inherits the SEC-02 screening, robots, both byte budgets, both
 * breakers and the stop conditions rather than growing a second HTTP path.
 *
 * # The shape, and what happens when it is wrong
 *
 * GDELT's article list is documented as `{ "articles": [ { url, title, seendate, domain,
 * language, sourcecountry } ] }`. **That shape has not been verified against the live service by
 * this project** — no request has been made to GDELT — so the parser is written to treat a
 * mismatch as a *failure*, never as an empty result:
 *
 * - a body that is not JSON → `UNPARSABLE`
 * - JSON with no `articles` array → `UNRECOGNISED`
 * - `articles: []` → a genuine empty answer, which is the one case that is not a gap
 *
 * That distinction is the whole reason this adapter is not five lines. A parser that returned
 * zero articles for all three would turn "GDELT changed its response" into "this person is not in
 * the news", silently, for every subject searched afterwards (FR-05 volatility control, T84).
 *
 * # The parameters it sets itself
 *
 * `mode=artlist` and `format=json` are set by the connector, after the query, so a recorded
 * endpoint cannot override them into a format this cannot read. Everything else — the address,
 * the query parameter's name, the time window the approver recorded — comes from the registry.
 *
 * # What it does not do
 *
 * It does not classify. A `Lead` carries no category, stage or party role and the type makes that
 * impossible rather than discouraged. GDELT publishes its own tone and theme scores; they are
 * deliberately **not** read, because a discovery source's opinion about a document is not evidence
 * about a person, and FR-06 is explicit that filtering never decides adversity.
 */

import { Logger } from '@nestjs/common';

import type { CountryCode } from '@erly/adverse-domain';

import { buildEndpoint } from './discovery/endpoint.js';
import { leadsFrom, matchesQuery, type RawCandidate } from './discovery/lead-mapping.js';
import type { EvidenceFetchPort, FetchAuthorisation } from './evidence-fetch.port.js';
import type { FetchGateService } from './fetch-gate.service.js';
import type { CascadeRung, DiscoveryQuery, Lead } from './lead.js';
import type { ContractProbeResult, NewsDiscoveryPort } from './news-discovery.port.js';
import { decodeXml } from './parse/xml.js';
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

/** Bumped whenever the parse changes (FR-05 volatility control). */
export const GDELT_PARSER_VERSION = 'gdelt-doc-2.0-artlist-1';

/**
 * The budget for one GDELT query.
 *
 * An article list is a list of headlines. A response measured in megabytes is a response that has
 * become something else, and the budget says so before the memory does.
 */
const GDELT_BUDGET = {
  maxBytes: 8 * 1024 * 1024,
  maxDecompressedBytes: 32 * 1024 * 1024,
  maxRedirects: 2,
  timeoutMs: 30_000,
} as const;

/**
 * Parameters this connector requires, set after the query so a recorded endpoint cannot override
 * them into a format it cannot read.
 */
const REQUIRED_PARAMS: Readonly<Record<string, string>> = {
  mode: 'artlist',
  format: 'json',
};

export interface GdeltDiscoveryOptions {
  readonly sourceId: string;
  readonly versions: SourceVersionReader;
  readonly gate: FetchGateService;
  readonly fetch: EvidenceFetchPort;
  readonly clock?: Clock;
}

export type GdeltParseResult =
  | { readonly kind: 'OK'; readonly articles: readonly RawCandidate[] }
  | { readonly kind: 'UNPARSABLE'; readonly detail: string }
  | { readonly kind: 'UNRECOGNISED'; readonly detail: string };

export class GdeltDiscoveryAdapter implements NewsDiscoveryPort {
  private readonly logger = new Logger('GdeltDiscovery');
  private readonly clock: Clock;
  readonly descriptor: AdapterDescriptor;

  constructor(private readonly options: GdeltDiscoveryOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.descriptor = {
      adapterId: 'gdelt-discovery',
      portKind: 'NEWS_DISCOVERY',
      sourceId: options.sourceId,
      parserVersion: GDELT_PARSER_VERSION,
      // GDELT publishes an API description and still changes it without versioning the response,
      // which is exactly what this class is for. Claiming DOCUMENTED_STABLE would exempt it from
      // the scheduled contract test that detects a silent shape change.
      stabilityClass: 'UNDOCUMENTED_VOLATILE',
      mode: 'LIVE',
      jurisdictions: [],
    };
  }

  /** GDELT is global rather than per-edition, so it addresses no edition list. */
  get editions(): readonly CountryCode[] {
    return [];
  }

  async discover(query: DiscoveryQuery): Promise<SourceOutcome<readonly Lead[]>> {
    const now = this.clock();
    const version = await this.options.versions.loadActive(this.options.sourceId);
    if (version === null) {
      return failed(
        this.descriptor,
        now,
        { policyRefusal: true },
        `Source ${this.options.sourceId} has no active approved version, so there is nothing ` +
          `authorising a request to it.`,
      );
    }

    const language = query.language ?? version.languages[0] ?? null;
    const jurisdiction = query.country ?? version.countries[0] ?? null;
    if (language === null || jurisdiction === null) {
      return failed(
        this.descriptorFor(version),
        now,
        { policyRefusal: true },
        `${version.sourceName} declares no ${language === null ? 'language' : 'country'}, so a ` +
          `poll of it could not be attributed. Neither is ever inferred (FR-03, FR-05).`,
      );
    }

    const endpoint = buildEndpoint(version, query.text, REQUIRED_PARAMS);
    if (endpoint.kind === 'REFUSED') {
      return failed(this.descriptorFor(version), now, { policyRefusal: true }, endpoint.detail);
    }

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
      budget: GDELT_BUDGET,
      conditional: { etag: null, lastModified: null },
      fetchKey: `${this.options.sourceId}:${query.queryId}:${now.toISOString().slice(0, 10)}`,
      allowRender: false,
    });

    if (result.status === 'FAILED') {
      return failed(this.descriptorFor(version), now, result.signal, result.detail);
    }
    if (result.status === 'NO_RESULTS' || !('data' in result)) {
      return noResults(this.descriptorFor(version), now);
    }
    if (result.data.notModified) {
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

    const parsed = parseGdelt(decodeXml(body, null));
    if (parsed.kind !== 'OK') {
      // Never `noResults`. See the file header: a shape change that reads as "no articles" is
      // invisible, and turns a broken source into clean results for everybody.
      this.logger.warn(`${version.sourceName}: ${parsed.kind} — ${parsed.detail}`);
      return failed(
        this.descriptorFor(version),
        now,
        parsed.kind === 'UNPARSABLE' ? { unparsableBody: true } : { unexpectedContentType: true },
        parsed.detail,
      );
    }

    const rung = rungOf(version.cascadeRung);
    const leads = leadsFrom({
      candidates: parsed.articles,
      fallbackLanguage: language,
      publisherName: version.sourceName,
      rung,
      queryId: query.queryId,
      provenance: stampProvenance(this.descriptorFor(version), now),
      // GDELT was asked the question, so its answer is not filtered again here. Re-filtering a
      // search result on our own string match would discard what the publisher judged relevant.
      matches:
        version.endpointKind === 'FIXED_FEED'
          ? (candidate): boolean => matchesQuery(query.text, candidate)
          : undefined,
    });

    if (leads.length === 0) {
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

  /** The scheduled contract test (T84). Runs the same parse the live path uses, through the gate. */
  async contractProbe(): Promise<ContractProbeResult> {
    const now = this.clock();
    const version = await this.options.versions.loadActive(this.options.sourceId);
    const base = {
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
        taxonomy: probeTaxonomy(version, now),
      },
      queryId: 'contract-probe',
      // A term common enough that a working service returns something. Zero articles for it is
      // the signal, not a coincidence.
      text: 'fraud',
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
    return {
      ...base,
      shapeStable: count > 0,
      fieldsMissing: count === 0 ? ['articles'] : [],
      sampleParsedCount: count,
      detail:
        count === 0
          ? `${version.sourceName} answered and the parse extracted zero articles. That is how a ` +
            `silent shape change presents: nothing throws, and recall goes to zero while the ` +
            `service keeps reporting clean results (T84).`
          : '',
    };
  }

  private descriptorFor(version: ActiveSourceVersion): AdapterDescriptor {
    return {
      ...this.descriptor,
      jurisdictions: [...version.countries],
      parserVersion: `${GDELT_PARSER_VERSION}+${version.sourceId}`,
    };
  }
}

/**
 * Parse a GDELT DOC 2.0 article list.
 *
 * Three outcomes, and keeping them apart is the point — see the adapter's header.
 */
export function parseGdelt(text: string): GdeltParseResult {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      kind: 'UNPARSABLE',
      detail:
        `The response is not JSON: ${error instanceof Error ? error.message : 'unknown error'}. ` +
        `GDELT serves an HTML error page on some failures, which parses as neither.`,
    };
  }

  const root = asRecord(document);
  if (root === null) {
    return { kind: 'UNRECOGNISED', detail: 'The response is JSON but not an object.' };
  }

  const articles = root['articles'];
  if (!Array.isArray(articles)) {
    return {
      kind: 'UNRECOGNISED',
      detail:
        `The response is JSON and has no "articles" array — its keys are ` +
        `[${Object.keys(root).join(', ')}]. Reported as unrecognised rather than as zero ` +
        `articles: a shape change that reads as "no news" is invisible (T84).`,
    };
  }

  return {
    kind: 'OK',
    articles: (articles as readonly unknown[]).map((entry): RawCandidate => {
      const article = asRecord(entry) ?? {};
      return {
        title: stringOrNull(article['title']),
        link: stringOrNull(article['url']),
        // GDELT's article list carries no snippet. Null, never synthesised from the title — a
        // snippet is what a relevance filter scores.
        snippet: null,
        publishedAtRaw: gdeltDate(stringOrNull(article['seendate'])),
        language: stringOrNull(article['language']),
      };
    }),
  };
}

/**
 * GDELT's `seendate` is `YYYYMMDDTHHMMSSZ`, which `Date.parse` does not accept.
 *
 * Reshaped to ISO rather than parsed by hand. Anything that does not match the documented shape
 * returns null and the date stays unknown — FR-07 again: a date nobody published is never
 * invented, and a half-understood timestamp is exactly how one gets invented.
 */
export function gdeltDate(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw.trim());
  if (match === null) {
    return null;
  }
  // Indices 1-6 exist whenever the pattern matched; the fallbacks keep the types honest rather
  // than asserting non-null on a regex result.
  const [, y = '', m = '', d = '', hh = '', mm = '', ss = ''] = match;
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
}

function rungOf(cascadeRung: number): CascadeRung {
  const rung = Math.trunc(cascadeRung);
  return (rung < 0 ? 0 : rung > 7 ? 7 : rung) as CascadeRung;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

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
