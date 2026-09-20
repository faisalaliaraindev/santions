import { sourceContentSchema, type SourceAccessPolicy } from '@erly/adverse-contracts';

export const WORLD_BANK_DEBARRED_SOURCE_ID = 'world-bank-debarred';
export const WORLD_BANK_DEBARRED_API_URL =
  'https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/ADOBE_EXPRNCE_MGR/FIRM/SANCTIONED_FIRM';
export const WORLD_BANK_DEBARRED_PAGE_URL =
  'https://www.worldbank.org/en/projects-operations/procurement/debarred-firms';
export const WORLD_BANK_CREDENTIAL_REF = 'WORLD_BANK_SANCTIONS_API_KEY';

const ACCESS_POLICY: SourceAccessPolicy = {
  requestCeilingPerSecond: null,
  pollFloorSeconds: 10_800,
  endpointUrl: WORLD_BANK_DEBARRED_API_URL,
  endpointKind: 'FIXED_FEED',
  queryParam: null,
  conditionalGet: true,
  userAgentRequired: false,
  policyUrl: WORLD_BANK_DEBARRED_PAGE_URL,
  policySummary:
    'The official World Bank page states that the ineligible-firms list updates every three ' +
    'hours and its own client loads Table 1 from this World Bank API gateway. The gateway ' +
    'requires an API key. A deployment-owned key, terms/robots evidence and named first-contact ' +
    'approval are required before activation; no third-party credential may be copied.',
  stopConditions: {
    haltOnStatuses: [401, 403],
    haltOnRateLimit: true,
    rateLimitCooldownSeconds: 3600,
    serverErrorStreakToHalt: 3,
    requiresFreshApprovalOnHalt: true,
  },
  firstContactApproval: null,
};

export const WORLD_BANK_DEBARRED_CONTENT = {
  sourceName: 'World Bank Listing of Ineligible Firms and Individuals',
  publisher: 'World Bank Group',
  connectorType: 'INDEXED_BULK_JSON',
  canonicalDomains: ['apigwext.worldbank.org'],
  authorityTier: 1,
  cascadeRung: 0,
  jurisdictionScope: 'GLOBAL',
  countries: [],
  languages: ['en'],
  credentialsRef: WORLD_BANK_CREDENTIAL_REF,
  freeTierHourlyBudget: 1,
  freeTierDailyBudget: 8,
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  parserVersion: 'world-bank-debarment-json-1',
  licenceTermsVersion: 'WORLD-BANK-TERMS-REVIEW-REQUIRED',
  licenceExpiresAt: null,
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'JSON',
  refreshPolicy: {
    intervalSeconds: 10_800,
    staleAfterSeconds: 43_200,
    minimumExpectedRows: 1_000,
  },
  accessPolicy: ACCESS_POLICY,
} as const;

export function worldBankDebarredContent(): Record<string, unknown> {
  return sourceContentSchema.parse(WORLD_BANK_DEBARRED_CONTENT);
}
