import { sourceContentSchema, type SourceAccessPolicy } from '@adverse-search/contracts';

export const OFAC_SDN_SOURCE_ID = 'ofac-sdn';
export const OFAC_NON_SDN_SOURCE_ID = 'ofac-consolidated-non-sdn';
export const UKSL_SOURCE_ID = 'uk-sanctions-list';
export const UNSC_SOURCE_ID = 'unsc-consolidated';
export const EU_SANCTIONS_SOURCE_ID = 'eu-consolidated-financial-sanctions';

export const OFAC_SDN_XML_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
export const OFAC_NON_SDN_XML_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML';
export const UKSL_XML_URL = 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml';
export const UNSC_XML_URL = 'https://scsanctions.un.org/resources/xml/en/name/consolidated.xml';
/**
 * The XML 1.1 distribution, **as the Commission's own open-data catalogue publishes it**.
 *
 * The `token` is part of the published address, not a credential: it appears in the
 * `download_url` of the XML distribution on data.europa.eu's record for this dataset, alongside
 * the CSV and PDF distributions carrying the same value. The bare path without it answers
 * `403 Forbidden` with a JSON error body, which is what this constant used to point at and what
 * made the source mechanically unusable. Verified 2026-09-21 under D19: HTTP 200,
 * `application/xml`, 6,234 `sanctionEntity` elements.
 */
export const EU_SANCTIONS_XML_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';

/**
 * Free-tier budgets, **measured against what a refresh actually costs**.
 *
 * A refresh is not one request. It is `robots.txt` for the host (a request the publisher sees,
 * and one this service deliberately pays for rather than skipping), then the artifact, then — for
 * the publishers that redirect their documented address to their own delivery host — the artifact
 * again at the redirect target. Two to three requests, before any retry.
 *
 * The first controlled refreshes on 2026-09-21 hit `HARD_BLOCK: the hourly free-tier budget of 1
 * call(s) is spent` on three sources whose budgets had been set to 1 or 2 per hour. The source
 * could never complete a refresh under its own recorded budget, which reads as a publisher
 * problem and was ours.
 *
 * These are still self-imposed floors far below anything these publishers state: six an hour
 * against a six- or twenty-four-hour refresh cadence is headroom for one retry, not a rate.
 */
const HOURLY_BUDGET = 6;

const SOFT_STOP_CONDITIONS = {
  haltOnStatuses: [] as number[],
  haltOnRateLimit: true,
  rateLimitCooldownSeconds: 3600,
  serverErrorStreakToHalt: 3,
  requiresFreshApprovalOnHalt: true,
};

function artifactPolicy(input: {
  readonly endpointUrl: string;
  readonly policyUrl: string | null;
  readonly policySummary: string;
  readonly pollFloorSeconds: number;
  readonly userAgentRequired: boolean;
}): SourceAccessPolicy {
  return {
    requestCeilingPerSecond: null,
    pollFloorSeconds: input.pollFloorSeconds,
    endpointUrl: input.endpointUrl,
    endpointKind: 'FIXED_FEED',
    queryParam: null,
    conditionalGet: true,
    userAgentRequired: input.userAgentRequired,
    policyUrl: input.policyUrl,
    policySummary: input.policySummary,
    stopConditions: SOFT_STOP_CONDITIONS,
    // Mechanical integration is deliberately inert until governance records a named approval.
    firstContactApproval: null,
  };
}

const COMMON = {
  connectorType: 'INDEXED_BULK_XML',
  authorityTier: 1,
  cascadeRung: 0,
  jurisdictionScope: 'GLOBAL',
  countries: [] as string[],
  languages: ['en'],
  credentialsRef: null,
  stabilityClass: 'DOCUMENTED_STABLE',
  licenceExpiresAt: null,
  contentFormat: 'XML',
} as const;

export const GLOBAL_INDEXED_SOURCE_CONTENT = {
  [OFAC_SDN_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'OFAC Specially Designated Nationals List',
    publisher: 'US Department of the Treasury, Office of Foreign Assets Control',
    canonicalDomains: ['sanctionslistservice.ofac.treas.gov'],
    freeTierHourlyBudget: HOURLY_BUDGET,
    freeTierDailyBudget: 32,
    parserVersion: 'ofac-legacy-xml-1',
    licenceTermsVersion: 'US-GOVERNMENT-WORK-REVIEW-REQUIRED',
    robotsPosition: 'NOT_ESTABLISHED',
    refreshPolicy: {
      intervalSeconds: 21_600,
      staleAfterSeconds: 86_400,
      minimumExpectedRows: 10_000,
    },
    accessPolicy: artifactPolicy({
      endpointUrl: OFAC_SDN_XML_URL,
      pollFloorSeconds: 21_600,
      userAgentRequired: true,
      policyUrl: 'https://ofac.treasury.gov/sdn-list-data-formats-data-schemas',
      policySummary:
        'Official OFAC Sanctions List Service SDN XML distribution. Endpoint and schema are ' +
        'documented by OFAC. Robots position, reuse terms and named first-contact approval must ' +
        'be recorded before activation; no permission is inferred here.',
    }),
  },
  [OFAC_NON_SDN_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'OFAC Consolidated Non-SDN Sanctions List',
    publisher: 'US Department of the Treasury, Office of Foreign Assets Control',
    canonicalDomains: ['sanctionslistservice.ofac.treas.gov'],
    freeTierHourlyBudget: HOURLY_BUDGET,
    freeTierDailyBudget: 32,
    parserVersion: 'ofac-legacy-xml-1',
    licenceTermsVersion: 'US-GOVERNMENT-WORK-REVIEW-REQUIRED',
    robotsPosition: 'NOT_ESTABLISHED',
    refreshPolicy: {
      intervalSeconds: 21_600,
      staleAfterSeconds: 86_400,
      // Measured 2026-09-21: the published consolidated non-SDN list holds 481 entries. The
      // floor was 1,000 — an assertion that the list is twice the size it is, which refused
      // every correct parse. A floor is a guard against a truncated or emptied artifact, so it
      // belongs below the real size, not above it.
      minimumExpectedRows: 300,
    },
    accessPolicy: artifactPolicy({
      endpointUrl: OFAC_NON_SDN_XML_URL,
      pollFloorSeconds: 21_600,
      userAgentRequired: true,
      policyUrl: 'https://ofac.treasury.gov/consolidated-sanctions-list-non-sdn-lists',
      policySummary:
        'Official OFAC consolidated non-SDN XML distribution. It is a separate logical source ' +
        'because its list semantics differ from SDN, while the shared parser and scheduler avoid ' +
        'a separate architecture. Governance evidence is still required before activation.',
    }),
  },
  [UKSL_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'UK Sanctions List',
    publisher: 'UK Foreign, Commonwealth & Development Office',
    canonicalDomains: ['sanctionslist.fcdo.gov.uk'],
    freeTierHourlyBudget: HOURLY_BUDGET,
    freeTierDailyBudget: 32,
    parserVersion: 'uksl-xml-1',
    licenceTermsVersion: 'OPEN-GOVERNMENT-LICENCE-3.0-REVIEW-2026-09-18',
    robotsPosition: 'NOT_ESTABLISHED',
    refreshPolicy: {
      intervalSeconds: 21_600,
      staleAfterSeconds: 86_400,
      minimumExpectedRows: 1_000,
    },
    accessPolicy: artifactPolicy({
      endpointUrl: UKSL_XML_URL,
      pollFloorSeconds: 21_600,
      userAgentRequired: false,
      policyUrl: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
      policySummary:
        'FCDO publishes the current UK Sanctions List in XML and documents the schema and fields. ' +
        'The retired OFSI consolidated list is not used. GOV.UK states OGL v3.0 for page content; ' +
        'dataset reuse and robots evidence still require governance confirmation before contact.',
    }),
  },
  [UNSC_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'UN Security Council Consolidated List',
    publisher: 'United Nations Security Council',
    canonicalDomains: ['scsanctions.un.org'],
    freeTierHourlyBudget: HOURLY_BUDGET,
    freeTierDailyBudget: 12,
    parserVersion: 'unsc-consolidated-xml-1',
    licenceTermsVersion: 'UN-TERMS-REVIEW-REQUIRED',
    robotsPosition: 'NOT_ESTABLISHED',
    refreshPolicy: {
      intervalSeconds: 86_400,
      staleAfterSeconds: 259_200,
      minimumExpectedRows: 900,
    },
    accessPolicy: artifactPolicy({
      endpointUrl: UNSC_XML_URL,
      pollFloorSeconds: 86_400,
      userAgentRequired: false,
      policyUrl: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
      policySummary:
        'The Security Council publishes the consolidated list in XML and identifies permanent ' +
        'reference numbers as authoritative identifiers. Terms, redirects and robots evidence ' +
        'must be approved before the first controlled refresh.',
    }),
  },
  [EU_SANCTIONS_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'EU Consolidated Financial Sanctions List',
    publisher: 'European Commission, DG FISMA',
    canonicalDomains: ['webgate.ec.europa.eu'],
    freeTierHourlyBudget: HOURLY_BUDGET,
    freeTierDailyBudget: 12,
    parserVersion: 'eu-fsf-xml-1.1-1',
    licenceTermsVersion: 'EU-DATASET-LICENCE-REVIEW-REQUIRED',
    robotsPosition: 'NOT_ESTABLISHED',
    refreshPolicy: {
      intervalSeconds: 86_400,
      staleAfterSeconds: 259_200,
      minimumExpectedRows: 2_000,
    },
    accessPolicy: artifactPolicy({
      endpointUrl: EU_SANCTIONS_XML_URL,
      pollFloorSeconds: 86_400,
      userAgentRequired: false,
      policyUrl:
        'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en',
      policySummary:
        'The EU data catalogue identifies the Commission XML 1.1 distribution and daily update ' +
        'frequency, and publishes the tokenised download URL recorded here. That URL was loaded ' +
        'on 2026-09-21 under D19 and returned HTTP 200 application/xml with 6,234 sanction ' +
        'entities; the untokenised path answers 403. robots.txt on webgate.ec.europa.eu is ' +
        'absent (404), which restricts nothing.',
    }),
  },
} as const;

export function globalIndexedSourceContent(
  sourceId: keyof typeof GLOBAL_INDEXED_SOURCE_CONTENT,
): Record<string, unknown> {
  return sourceContentSchema.parse(GLOBAL_INDEXED_SOURCE_CONTENT[sourceId]);
}
