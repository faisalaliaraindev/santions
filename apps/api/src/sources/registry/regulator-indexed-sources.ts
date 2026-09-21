import { sourceContentSchema, type SourceAccessPolicy } from '@erly/adverse-contracts';

export const DOJ_FRAUD_SOURCE_ID = 'doj-fraud-enforcement';
export const CFTC_ENFORCEMENT_SOURCE_ID = 'cftc-enforcement-press-releases';
export const FTC_CONSUMER_SOURCE_ID = 'ftc-consumer-protection-press-releases';
export const FCA_WARNINGS_SOURCE_ID = 'fca-warnings';

export const DOJ_FRAUD_RSS_URL =
  'https://www.justice.gov/news/rss?field_date=2026-04-01&field_topic%5B0%5D=34046&field_topic%5B1%5D=3926&field_topic%5B2%5D=3951&field_topic%5B3%5D=25351&field_topic%5B4%5D=54326&field_topic%5B5%5D=54331&field_topic%5B6%5D=40971&field_topic%5B7%5D=3936&require_all=0&search_api_language=en&show_public_archived=0&type%5B0%5D=blog_post&type%5B1%5D=image_gallery&type%5B2%5D=press_release&type%5B3%5D=youtube_video';
export const CFTC_ENFORCEMENT_RSS_URL = 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml';
export const FTC_CONSUMER_RSS_URL =
  'https://www.ftc.gov/feeds/press-release-consumer-protection.xml';
export const FCA_WARNINGS_RSS_URL = 'https://www.fca.org.uk/news/warnings/rss.xml';

const STOP_CONDITIONS = {
  haltOnStatuses: [] as number[],
  haltOnRateLimit: true,
  rateLimitCooldownSeconds: 3600,
  serverErrorStreakToHalt: 3,
  requiresFreshApprovalOnHalt: true,
};

function feedPolicy(input: {
  endpointUrl: string;
  policyUrl: string;
  policySummary: string;
  userAgentRequired?: boolean;
}): SourceAccessPolicy {
  return {
    requestCeilingPerSecond: null,
    pollFloorSeconds: 3600,
    endpointUrl: input.endpointUrl,
    endpointKind: 'FIXED_FEED',
    queryParam: null,
    conditionalGet: true,
    userAgentRequired: input.userAgentRequired ?? false,
    policyUrl: input.policyUrl,
    policySummary: input.policySummary,
    stopConditions: STOP_CONDITIONS,
    firstContactApproval: null,
  };
}

const COMMON = {
  connectorType: 'INDEXED_RSS',
  authorityTier: 1,
  cascadeRung: 0,
  jurisdictionScope: 'GLOBAL',
  countries: [] as string[],
  languages: ['en'],
  credentialsRef: null,
  // A refresh costs a robots.txt read plus the feed. Hourly against an hourly cadence leaves
  // room for exactly one retry; daily covers 24 refreshes at two requests each with headroom.
  freeTierHourlyBudget: 6,
  freeTierDailyBudget: 96,
  stabilityClass: 'UNDOCUMENTED_VOLATILE',
  licenceExpiresAt: null,
  robotsPosition: 'NOT_ESTABLISHED',
  contentFormat: 'XML_FEED',
  refreshPolicy: {
    intervalSeconds: 3600,
    staleAfterSeconds: 86_400,
    minimumExpectedRows: 1,
  },
} as const;

export const REGULATOR_INDEXED_SOURCE_CONTENT = {
  [DOJ_FRAUD_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'DOJ Fraud Enforcement News',
    publisher: 'United States Department of Justice',
    canonicalDomains: ['www.justice.gov'],
    parserVersion: 'official-feed-doj-fraud-1',
    licenceTermsVersion: 'US-DOJ-WEB-POLICY-REVIEW-REQUIRED',
    accessPolicy: feedPolicy({
      endpointUrl: DOJ_FRAUD_RSS_URL,
      policyUrl: 'https://www.justice.gov/fraud/fraud-enforcement-news',
      policySummary:
        'The official Fraud Enforcement News page links this RSS feed and describes the page as ' +
        'fraud prosecutions from across the Department. Robots, reuse terms and named first-contact ' +
        'approval remain required before activation.',
    }),
  },
  [CFTC_ENFORCEMENT_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'CFTC Enforcement Press Releases',
    publisher: 'US Commodity Futures Trading Commission',
    canonicalDomains: ['www.cftc.gov'],
    parserVersion: 'official-feed-cftc-enforcement-1',
    licenceTermsVersion: 'US-CFTC-WEB-POLICY-REVIEW-REQUIRED',
    accessPolicy: feedPolicy({
      endpointUrl: CFTC_ENFORCEMENT_RSS_URL,
      policyUrl: 'https://www.cftc.gov/RSS/index.htm',
      policySummary:
        'The CFTC RSS index links a dedicated Enforcement Press Releases feed. Access-policy, ' +
        'robots and first-contact evidence remain deliberately unasserted pending governance.',
    }),
  },
  [FTC_CONSUMER_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'FTC Consumer Protection Press Releases',
    publisher: 'US Federal Trade Commission',
    canonicalDomains: ['www.ftc.gov'],
    parserVersion: 'official-feed-ftc-consumer-1',
    licenceTermsVersion: 'US-FTC-WEB-POLICY-REVIEW-REQUIRED',
    accessPolicy: feedPolicy({
      endpointUrl: FTC_CONSUMER_RSS_URL,
      policyUrl: 'https://www.ftc.gov/stay-connected/rss',
      policySummary:
        'The FTC RSS page links the Consumer Protection Press Releases feed. This focused feed ' +
        'avoids broad administrative news and avoids duplicate ingestion from the general feed. ' +
        'Governance evidence is still required before contact.',
    }),
  },
  [FCA_WARNINGS_SOURCE_ID]: {
    ...COMMON,
    sourceName: 'FCA Warnings',
    publisher: 'UK Financial Conduct Authority',
    canonicalDomains: ['www.fca.org.uk'],
    parserVersion: 'official-feed-fca-warnings-1',
    licenceTermsVersion: 'FCA-COPYRIGHT-REVIEW-REQUIRED',
    accessPolicy: feedPolicy({
      endpointUrl: FCA_WARNINGS_RSS_URL,
      policyUrl: 'https://www.fca.org.uk/consumers/warning-list-unauthorised-firms',
      policySummary:
        'The FCA Warning List links this RSS feed for unauthorised firms and individuals. ' +
        'Copyright, robots and named first-contact approval require governance before activation.',
    }),
  },
} as const;

export function regulatorIndexedSourceContent(
  sourceId: keyof typeof REGULATOR_INDEXED_SOURCE_CONTENT,
): Record<string, unknown> {
  return sourceContentSchema.parse(REGULATOR_INDEXED_SOURCE_CONTENT[sourceId]);
}
