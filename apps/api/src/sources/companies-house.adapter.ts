/**
 * The real `CompanyRegistryPort`: **UK Companies House**.
 *
 * # Read this before treating it as coverage
 *
 * D-010 enables **Costa Rica only**. This adapter covers **Great Britain only**. It is the
 * proving ground for the port and for the FR-02 graph — a real register, with a real contract,
 * real pagination and real failure modes — and it is **not enabled for Costa Rican searches**.
 * `jurisdictions` is `['GB']`, `assertJurisdictionCovered` throws on anything else, and the
 * throw is deliberate: asking a British register about Costa Rica is a programming error, not a
 * coverage gap, and reporting it as a gap would put a line in a coverage statement implying CR
 * officer data was attempted.
 *
 * The reason there is no Costa Rican adapter here is in `docs/sources/cr-dossier.md` (D0), and
 * it is not an engineering gap: the Registro Nacional publishes company representatives behind
 * free registration **and a CAPTCHA**, and FR-06 forbids bypassing CAPTCHAs — full stop, not
 * "unless it is inconvenient". `api.hacienda.go.cr` is free and machine-readable but returns
 * entity status and economic activity and nothing about directors. So FR-02 currently has **no
 * data source in the only enabled jurisdiction**, which is open decision **D14**, and the
 * capability coverage seeded for CR records `OFFICER_ASSOCIATIONS` accordingly. A UK adapter
 * does not change that, and this comment exists so that nobody reading the file list concludes
 * that it does.
 *
 * # The contract
 *
 * Documented and versioned by the publisher, so `DOCUMENTED_STABLE`. Authentication is an HTTP
 * Basic header with the free API key as the username and an empty password — which is the
 * publisher's documented scheme, not a workaround. The key is read from configuration as a
 * reference (SEC-04: the registry stores a `credentialsRef`, never the credential).
 *
 * # What it deliberately does not do
 *
 * It does not resolve, score or match. `findOfficers` returns everyone the register holds under
 * that name, with the partial date of birth the register publishes, and stops. Companies House
 * search is fuzzy — a query for "John Smith" returns people who are not called John Smith — so
 * an adapter that filtered by its own notion of a match would be making axis A's decision with
 * less information than axis A has, and would be doing it invisibly.
 */

import {
  assertJurisdictionCovered,
  bounded,
  failed,
  ok,
  noResults,
  type AdapterDescriptor,
  type Clock,
  type SourceOutcome,
} from './source-adapter.js';
import type {
  AppointmentsQuery,
  CompanyRegistryPort,
  Directorship,
  OfficerCandidate,
  OfficerIdentifier,
  OfficerSearchQuery,
  RegistryCompany,
} from './company-registry.port.js';
import type { FailureSignal, PreciseDate } from '@adverse-search/domain';

export const COMPANIES_HOUSE_BASE_URL = 'https://api.company-information.service.gov.uk';

export const COMPANIES_HOUSE_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'companies-house-gb',
  portKind: 'COMPANY_REGISTRY',
  sourceId: 'src-companies-house-gb',
  // Bumped whenever the field mapping below changes. FR-05's scheduled contract test keys off
  // this, and a mapping change that keeps the old version makes the alert compare the wrong
  // shape against the wrong expectation.
  parserVersion: 'ch-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'LIVE',
  // GB, and only GB. See the file header.
  jurisdictions: ['GB'],
};

export interface CompaniesHouseOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly clock?: Clock;
  /** Injected so tests do not reach the network and so an egress identity can be bound later. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The subset of the published response this adapter reads. Anything else is ignored. */
interface OfficerSearchItem {
  readonly title?: string;
  readonly appointment_count?: number;
  readonly date_of_birth?: { readonly month?: number; readonly year?: number };
  readonly address?: { readonly locality?: string; readonly postal_code?: string };
  readonly links?: { readonly self?: string };
}

interface OfficerSearchResponse {
  readonly total_results?: number;
  readonly items?: readonly OfficerSearchItem[];
}

interface AppointmentsResponse {
  readonly total_results?: number;
  readonly items?: readonly {
    readonly appointed_on?: string;
    readonly resigned_on?: string;
    readonly officer_role?: string;
    readonly appointed_to?: {
      readonly company_number?: string;
      readonly company_name?: string;
    };
  }[];
}

interface CompanyProfileResponse {
  readonly company_name?: string;
  readonly company_number?: string;
  readonly company_status?: string;
  readonly date_of_creation?: string;
}

export class CompaniesHouseAdapter implements CompanyRegistryPort {
  readonly descriptor = COMPANIES_HOUSE_DESCRIPTOR;

  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: CompaniesHouseOptions) {
    this.baseUrl = options.baseUrl ?? COMPANIES_HOUSE_BASE_URL;
    this.clock = options.clock ?? ((): Date => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async findOfficers(
    query: OfficerSearchQuery,
  ): Promise<SourceOutcome<readonly OfficerCandidate[]>> {
    assertJurisdictionCovered(this.descriptor, query.jurisdiction);

    const url = new URL('/search/officers', this.baseUrl);
    url.searchParams.set('q', query.name);
    // Asked for one more than the bound, so "exactly at the bound" and "more than the bound"
    // are distinguishable without a second call. `total_results` is also read, but it is not
    // always present and a bound check that depends on it silently stops working when it is not.
    url.searchParams.set('items_per_page', String(query.limit + 1));

    const response = await this.get(url);
    if (response.kind === 'FAILURE') {
      return failed(this.descriptor, this.clock(), response.signal, response.detail);
    }

    const body = response.body as OfficerSearchResponse;
    const items = body.items ?? [];
    if (items.length === 0) {
      // The register answered and holds nobody under this name. FR-02: that does not prove no
      // associations exist, and the outcome type is what keeps the difference visible.
      return noResults(this.descriptor, this.clock());
    }

    const candidates = items
      .map((item) => this.toCandidate(item))
      .filter((c): c is OfficerCandidate => c !== null)
      .toSorted((a, b) => a.officerRef.localeCompare(b.officerRef));

    if (candidates.length > query.limit) {
      return bounded(this.descriptor, this.clock(), candidates.slice(0, query.limit), {
        reason: 'BOUND_EXCEEDED',
        limit: query.limit,
        availableCount: body.total_results ?? null,
      });
    }

    return ok(this.descriptor, this.clock(), candidates);
  }

  async listAppointments(
    query: AppointmentsQuery,
  ): Promise<SourceOutcome<readonly Directorship[]>> {
    assertJurisdictionCovered(this.descriptor, query.jurisdiction);

    const url = new URL(
      `/officers/${encodeURIComponent(query.officerRef)}/appointments`,
      this.baseUrl,
    );
    url.searchParams.set('items_per_page', String(query.limit + 1));

    const response = await this.get(url);
    if (response.kind === 'FAILURE') {
      return failed(this.descriptor, this.clock(), response.signal, response.detail);
    }

    const body = response.body as AppointmentsResponse;
    const observedAt = this.clock().toISOString();
    const items = body.items ?? [];
    if (items.length === 0) {
      return noResults(this.descriptor, this.clock());
    }

    const directorships = items
      .map((item): Directorship | null => {
        const companyRef = item.appointed_to?.company_number;
        if (companyRef === undefined || companyRef === '') {
          // An appointment with no company number cannot be an edge in the graph — there is
          // nothing for it to point at. Dropped rather than given a synthetic identifier,
          // because a synthetic one would merge every such appointment into one company.
          return null;
        }
        return {
          officerRef: query.officerRef,
          companyRef,
          companyName: item.appointed_to?.company_name ?? companyRef,
          jurisdiction: 'GB',
          role: item.officer_role ?? 'unknown',
          tenure: {
            appointedOn: parseRegisterDate(item.appointed_on),
            // Absent means absent. Companies House omits `resigned_on` for a serving officer,
            // and FR-02 is explicit that an unknown end date does not prove current status —
            // so this must never become "today" or "open-ended until further notice".
            resignedOn: parseRegisterDate(item.resigned_on),
          },
          observedAt,
        };
      })
      .filter((d): d is Directorship => d !== null)
      .toSorted((a, b) => a.companyRef.localeCompare(b.companyRef));

    if (directorships.length > query.limit) {
      return bounded(this.descriptor, this.clock(), directorships.slice(0, query.limit), {
        reason: 'BOUND_EXCEEDED',
        limit: query.limit,
        availableCount: body.total_results ?? null,
      });
    }

    return ok(this.descriptor, this.clock(), directorships);
  }

  async getCompany(
    companyRef: string,
    jurisdiction: string,
  ): Promise<SourceOutcome<RegistryCompany>> {
    assertJurisdictionCovered(this.descriptor, jurisdiction);

    const url = new URL(`/company/${encodeURIComponent(companyRef)}`, this.baseUrl);
    const response = await this.get(url);
    if (response.kind === 'FAILURE') {
      // A 404 here means the register holds no such company — an answer, not an outage. It is
      // translated back to NO_RESULTS rather than left as a CONTENT_ERROR failure, which would
      // open a coverage gap for a question that was fully answered.
      if (response.signal.httpStatus === 404) {
        return noResults(this.descriptor, this.clock());
      }
      return failed(this.descriptor, this.clock(), response.signal, response.detail);
    }

    const body = response.body as CompanyProfileResponse;
    return ok(this.descriptor, this.clock(), {
      companyRef: body.company_number ?? companyRef,
      name: body.company_name ?? companyRef,
      jurisdiction: 'GB',
      status: normaliseCompanyStatus(body.company_status),
      incorporatedOn: parseRegisterDate(body.date_of_creation),
    });
  }

  /** Extract the register's officer id from the `links.self` path it publishes. */
  private toCandidate(item: OfficerSearchItem): OfficerCandidate | null {
    const self = item.links?.self;
    const officerRef = self === undefined ? null : extractOfficerId(self);
    if (officerRef === null || item.title === undefined) {
      return null;
    }

    const identifiers: OfficerIdentifier[] = [];
    const dob = item.date_of_birth;
    if (dob?.year !== undefined) {
      // Companies House publishes a month and a year, never a day. Recorded as partial so axis
      // A grades it as the moderate identifier it is rather than as a full date of birth.
      identifiers.push({
        kind: 'DATE_OF_BIRTH',
        value:
          dob.month === undefined
            ? String(dob.year)
            : `${String(dob.year)}-${String(dob.month).padStart(2, '0')}`,
        partial: true,
      });
    }
    const locality = item.address?.locality;
    if (locality !== undefined && locality !== '') {
      identifiers.push({ kind: 'ADDRESS_LOCALITY', value: locality, partial: true });
    }

    return {
      officerRef,
      name: item.title,
      jurisdiction: 'GB',
      identifiers,
      appointmentCount: item.appointment_count ?? null,
    };
  }

  /**
   * One GET, with the failure translated into an FR-06 signal rather than an exception.
   *
   * The adapter reports **facts** — a status code, a syscall name, a content type — and
   * `classifyFailure` decides what they mean. Deciding here would be the second failure
   * taxonomy that `failure-classification.ts` exists to prevent.
   */
  private async get(url: URL): Promise<
    | { kind: 'OK'; body: unknown }
    // `detail` rides with the signal because the sentence a reviewer reads is written where the
    // facts are, and reconstructing it from a classified failure two layers up loses the host,
    // the status and the path.
    | { kind: 'FAILURE'; signal: FailureSignal; detail: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          // The publisher's documented scheme: API key as the Basic username, empty password.
          authorization: `Basic ${Buffer.from(`${this.options.apiKey}:`).toString('base64')}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        return {
          kind: 'FAILURE',
          signal: {
            httpStatus: response.status,
            ...(retryAfter === null || Number.isNaN(Number(retryAfter))
              ? {}
              : { retryAfterSeconds: Number(retryAfter) }),
          },
          detail: `Companies House answered ${String(response.status)} for ${url.pathname}.`,
        };
      }

      const contentType = response.headers.get('content-type');
      if (contentType !== null && !contentType.includes('json')) {
        // A non-JSON 200 from a JSON API is the signature of an interstitial or an error page
        // served with the wrong status. Reported as an unexpected content type, which the
        // table treats as a content error — that is, not retried.
        return {
          kind: 'FAILURE',
          signal: { unexpectedContentType: true, httpStatus: 200 },
          detail:
            `Companies House answered 200 for ${url.pathname} with content type ` +
            `"${contentType}" rather than JSON, which is the signature of an error page or an ` +
            `interstitial served with the wrong status.`,
        };
      }

      try {
        // `unknown`, and each caller narrows it to the shape it reads. Typing this generically
        // would dress an unvalidated third-party body as a checked one.
        return { kind: 'OK', body: await response.json() };
      } catch {
        return {
          kind: 'FAILURE',
          signal: { unparsableBody: true, httpStatus: response.status },
          detail: `Companies House returned a body for ${url.pathname} that is not valid JSON.`,
        };
      }
    } catch (error) {
      const signal = networkSignal(error);
      return {
        kind: 'FAILURE',
        signal,
        detail: `Companies House could not be reached for ${url.pathname} (${signal.syscallCode ?? 'network error'}).`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A transport-level error, reduced to the facts the FR-06 table reads. */
function networkSignal(error: unknown): FailureSignal {
  if (error instanceof Error && error.name === 'AbortError') {
    return { syscallCode: 'ETIMEDOUT' };
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { syscallCode: code } : { syscallCode: 'ECONNRESET' };
}

/**
 * A register date, with its precision declared.
 *
 * Companies House publishes full ISO dates for appointments and a year-and-month or a year for
 * some other fields. Precision is read from the string's shape rather than assumed to be DAY,
 * because `labelTenure` widens a YEAR-precision date to the whole year and a wrongly declared
 * DAY turns an unknowable "during or after?" into a confident wrong answer.
 */
export function parseRegisterDate(raw: string | undefined): PreciseDate {
  if (raw === undefined || raw === '') {
    return { value: null, precision: 'UNKNOWN' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { value: raw, precision: 'DAY' };
  }
  if (/^\d{4}-\d{2}$/.test(raw)) {
    return { value: `${raw}-01`, precision: 'MONTH' };
  }
  if (/^\d{4}$/.test(raw)) {
    return { value: `${raw}-01-01`, precision: 'YEAR' };
  }
  // An unrecognised shape is unknown, not a best guess. A parsed-wrong date is worse than no
  // date: the first is believed, the second is visibly absent.
  return { value: null, precision: 'UNKNOWN' };
}

/** The register's status vocabulary, reduced to the port's. Anything unrecognised is UNKNOWN. */
export function normaliseCompanyStatus(raw: string | undefined): RegistryCompany['status'] {
  switch (raw) {
    case 'active':
      return 'ACTIVE';
    case 'dissolved':
      return 'DISSOLVED';
    case 'liquidation':
    case 'receivership':
    case 'administration':
    case 'insolvency-proceedings':
      return 'LIQUIDATION';
    case 'closed':
    case 'converted-closed':
      return 'INACTIVE';
    default:
      // Includes `undefined`. "We do not know this company's status" is a different statement
      // from "this company is dissolved", and merging them would report a live company as dead.
      return 'UNKNOWN';
  }
}

/** `/officers/{id}/appointments` → `{id}`. Null when the path is not that shape. */
export function extractOfficerId(selfLink: string): string | null {
  const match = /^\/officers\/([^/]+)\/appointments\/?$/.exec(selfLink);
  return match?.[1] ?? null;
}
