import { sourceContentSchema, type SourceAccessPolicy } from '@erly/adverse-contracts';

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
export const UNSC_XML_URL =
  'https://scsanctions.un.org/resources/xml/en/name/consolidated.xml';
export const EU_SANCTIONS_XML_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content';

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
    freeTierHourlyBudget: 2,
    freeTierDailyBudget: 8,
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
    freeTierHourlyBudget: 2,
    freeTierDailyBudget: 8,
    parserVersion: 'ofac-legacy-xml-1',
    licenceTermsVersion: 'US-GOVERNMENT-WORK-REVIEW-REQUIRED',
    robotsPosition: 'NOT_ESTABLISHED',
    refreshPolicy: {
      intervalSeconds: 21_600,
      staleAfterSeconds: 86_400,
      minimumExpectedRows: 1_000,
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
    freeTierHourlyBudget: 2,
    freeTierDailyBudget: 8,
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
    freeTierHourlyBudget: 1,
    freeTierDailyBudget: 2,
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
    freeTierHourlyBudget: 1,
    freeTierDailyBudget: 2,
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
        'frequency. The direct distribution URL remains mechanically unverified by this project; ' +
        'confirm it and record licence, robots and first-contact evidence before activation.',
    }),
  },
} as const;

export function globalIndexedSourceContent(
  sourceId: keyof typeof GLOBAL_INDEXED_SOURCE_CONTENT,
): Record<string, unknown> {
  return sourceContentSchema.parse(GLOBAL_INDEXED_SOURCE_CONTENT[sourceId]);
}
