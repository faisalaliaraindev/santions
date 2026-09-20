import { Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MongoClient, type Db } from 'mongodb';

import { AdminController } from './admin/admin.controller.js';
import { AssociationGraphService } from './associations/association-graph.service.js';
import { TaxonomyService } from './admin/taxonomy.service.js';
import { FindingsService } from './pipeline/findings.service.js';
import { SearchJobHandler } from './pipeline/search-job.handler.js';
import { CascadeService } from './pipeline/cascade.service.js';
import { LadderBuilder } from './pipeline/ladder.builder.js';
import { DiscoveryRequestLog } from './sources/discovery-request-log.js';
import { FixedFeedPollCache } from './sources/feed-poll-cache.js';
import { SearchPipeline } from './pipeline/search-pipeline.service.js';
import { FetchGateService } from './sources/fetch-gate.service.js';
import { SourceVersionService } from './sources/source-version.service.js';
import { IndexedSourceRepository } from './sources/indexed/indexed-source.repository.js';
import {
  INDEXED_SOURCE_SCHEDULES,
  IndexedSourceRefreshService,
  type IndexedSourceSchedule,
} from './sources/indexed/indexed-source-refresh.service.js';
import {
  SCHEDULED_ARTIFACT_TRANSPORT,
  type ScheduledArtifactTransport,
} from './sources/indexed/indexed-source.types.js';
import { ScheduledArtifactTransportAdapter } from './sources/indexed/scheduled-artifact-transport.adapter.js';
import { IndexedSourceScheduler } from './sources/indexed/indexed-source-scheduler.service.js';
import { IndexedSourceSearchService } from './sources/indexed/indexed-source-search.service.js';
import { OfacXmlParser } from './sources/indexed/parsers/ofac-xml.parser.js';
import { UkslXmlParser } from './sources/indexed/parsers/uksl-xml.parser.js';
import { UnscXmlParser } from './sources/indexed/parsers/unsc-xml.parser.js';
import { EuSanctionsXmlParser } from './sources/indexed/parsers/eu-sanctions-xml.parser.js';
import { OfficialFeedParser } from './sources/indexed/parsers/official-feed.parser.js';
import { WorldBankDebarmentParser } from './sources/indexed/parsers/world-bank-debarment.parser.js';
import {
  EU_SANCTIONS_SOURCE_ID,
  EU_SANCTIONS_XML_URL,
  OFAC_NON_SDN_SOURCE_ID,
  OFAC_NON_SDN_XML_URL,
  OFAC_SDN_SOURCE_ID,
  OFAC_SDN_XML_URL,
  UKSL_SOURCE_ID,
  UKSL_XML_URL,
  UNSC_SOURCE_ID,
  UNSC_XML_URL,
} from './sources/registry/global-indexed-sources.js';
import {
  CFTC_ENFORCEMENT_RSS_URL,
  CFTC_ENFORCEMENT_SOURCE_ID,
  DOJ_FRAUD_RSS_URL,
  DOJ_FRAUD_SOURCE_ID,
  FCA_WARNINGS_RSS_URL,
  FCA_WARNINGS_SOURCE_ID,
  FTC_CONSUMER_RSS_URL,
  FTC_CONSUMER_SOURCE_ID,
} from './sources/registry/regulator-indexed-sources.js';
import {
  WORLD_BANK_DEBARRED_API_URL,
  WORLD_BANK_DEBARRED_SOURCE_ID,
} from './sources/registry/world-bank-indexed-source.js';
import { CapabilityCoverageService } from './admin/capability-coverage.service.js';
import { VersionedRecordService } from './admin/versioned-record.service.js';
import { AccountController } from './auth/account.controller.js';
import { AccountService } from './auth/account.service.js';
import { AuthController } from './auth/auth.controller.js';
import { LoginController } from './auth/login.controller.js';
import {
  MailboxNotificationAdapter,
  NOTIFICATION_PORT,
  UnconfiguredNotificationAdapter,
  type NotificationPort,
} from './auth/notification.port.js';
import { UserService } from './auth/user.service.js';
import { AuthGuard, PermissionGuard } from './auth/auth.guard.js';
import { CsrfGuard } from './auth/csrf.guard.js';
import { SessionService } from './auth/session.service.js';
import { TokenVerifier } from './auth/token-verifier.js';
import { AttemptLimiter } from './common/attempt-limiter.js';
import { ApiExceptionFilter } from './common/exception.filter.js';
import { ReservedController } from './common/reserved.controller.js';
import { loadConfig, type AppConfig } from './config/config.js';
import { DevMailboxController } from './dev/dev-mailbox.controller.js';
import { APP_CONFIG, MONGO_CLIENT, MONGO_DB } from './tokens.js';
import { HealthController } from './health/health.controller.js';
import {
  DEAD_LETTER_PORT,
  InMemoryDeadLetterSink,
  SqsDeadLetterAdapter,
  type DeadLetterPort,
} from './jobs/dead-letter.port.js';
import { DEFAULT_CONSUMER_OPTIONS, JobConsumer } from './jobs/job-consumer.js';
import { OutboxPublisher } from './jobs/outbox-publisher.js';
import { WorkerRuntime } from './jobs/worker-runtime.service.js';
import { InMemoryQueueAdapter, QUEUE_PORT, type QueuePort } from './jobs/queue.port.js';
import { SqsQueueAdapter } from './jobs/sqs-queue.adapter.js';
import { AuditService, LocalAuditCheckpointWriter } from './persistence/audit.service.js';
import { InboxReceiptService } from './persistence/inbox-receipt.service.js';
import { OutboxService } from './persistence/outbox.service.js';
import { RetentionService } from './persistence/retention.service.js';
import { SourceDocumentService } from './persistence/source-document.service.js';
import { StageExecutionService } from './persistence/stage-execution.service.js';
import { IndexerService } from './search-index/indexer.service.js';
import { EvidenceStagingService } from './storage/evidence-staging.service.js';
import { RetentionSweeper } from './storage/retention-sweeper.service.js';
import { S3ObjectStoreAdapter } from './storage/s3-object-store.adapter.js';
import {
  InMemoryObjectStore,
  OBJECT_STORE_PORT,
  type ObjectStorePort,
} from './storage/object-store.port.js';
import { MeilisearchAdapter } from './search-index/meilisearch.adapter.js';
import {
  InMemorySearchIndex,
  SEARCH_INDEX_PORT,
  type SearchIndexPort,
} from './search-index/search-index.port.js';
import {
  buildSourceAdapters,
  SOURCE_ADAPTERS,
  type SourceAdapterSet,
} from './sources/sources.registry.js';
import { DomainHealthService } from './sources/domain-health.service.js';
import { SourceHealthService } from './sources/source-health.service.js';
import { TransactionRunner } from './persistence/transaction.runner.js';
import { IdempotencyService } from './searches/idempotency.service.js';
import { ScreenController } from './searches/screen.controller.js';
import { ScreenService } from './searches/screen.service.js';
import { SearchesController } from './searches/searches.controller.js';
import { SearchesService } from './searches/searches.service.js';
import { NameFrequencyService } from './subjects/name-frequency.service.js';
import { SubjectsController } from './subjects/subjects.controller.js';
import { SubjectsService } from './subjects/subjects.service.js';
import { StartupService } from './startup.service.js';
import { ApiKeyService } from './tenancy/api-key.service.js';
import { SignupController } from './tenancy/signup.controller.js';
import { SignupService } from './tenancy/signup.service.js';
import { TenantApiKeysController } from './tenancy/tenant-api-keys.controller.js';
import { EntitlementsService } from './tenancy/entitlements.service.js';
import { PolicyService } from './tenancy/policy.service.js';

// Re-exported for convenience; defined in ./tokens.js to avoid a circular import.
export { APP_CONFIG, MONGO_CLIENT, MONGO_DB } from './tokens.js';

function indexedSchedule(
  sourceId: string,
  artifactUrl: string,
  parser: IndexedSourceSchedule['parser'],
  intervalSeconds: number,
  staleAfterSeconds: number,
  minimumExpectedRows: number,
  acceptedContentTypes: readonly string[] = [
    'application/xml',
    'text/xml',
    'application/octet-stream',
  ],
): IndexedSourceSchedule {
  return {
    sourceId,
    artifactUrl,
    parser,
    refreshIntervalMs: intervalSeconds * 1000,
    staleAfterMs: staleAfterSeconds * 1000,
    minimumExpectedRows,
    acceptedContentTypes,
  };
}

/**
 * Controllers that exist only on a non-production stack.
 *
 * `DevMailboxController` reads verification and password-reset tokens out of the local mailbox
 * (D-058) so the onboarding flow can be completed from Postman without a Mongo shell. In
 * production the path must not exist at all.
 *
 * **Registration is the gate, deliberately.** The alternative — always register it and check
 * `isProduction` inside the handler — puts an unauthenticated token oracle one inverted boolean
 * away from being live. Here, getting it wrong produces a route that is missing on a developer's
 * machine, which is loud and harmless, rather than a route that is present on a customer's,
 * which is neither.
 *
 * Read from `process.env` rather than from the injected `AppConfig` because Nest evaluates this
 * when the module is *defined*, before any provider — including a test's `overrideProvider` —
 * exists. `NODE_ENV` is the same value `loadConfig` derives `isProduction` from, and the
 * controller's constructor asserts the two agree.
 */
const DEV_ONLY_CONTROLLERS = process.env['NODE_ENV'] === 'production' ? [] : [DevMailboxController];

/**
 * Guard order is deliberate and enforced by registration order:
 *
 *   1. AuthGuard        — who is calling, from a validated credential
 *   2. CsrfGuard        — for state-changing cookie-authenticated requests
 *   3. PermissionGuard  — may they do this, in this tenant
 *
 * All three are global. A new route is protected by default and must opt out explicitly with
 * `@Public()`; the opposite arrangement ships unguarded routes, because the one somebody
 * forgets to decorate is the one that leaks.
 */
@Module({
  controllers: [
    HealthController,
    AuthController,
    LoginController,
    AccountController,
    SubjectsController,
    ScreenController,
    SearchesController,
    // ReservedController must be registered BEFORE AdminController. Nest matches routes in
    // registration order, and AdminController's `/v1/admin/:collection` would otherwise shadow
    // the reserved `/v1/admin/plans`, turning a documented 501 into a 403 from a permission
    // check on a route that was never meant to exist (FR-15, decision D-007).
    SignupController,
    TenantApiKeysController,
    ReservedController,
    AdminController,
    // Absent in production, rather than present and guarded. See DEV_ONLY_CONTROLLERS.
    ...DEV_ONLY_CONTROLLERS,
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(process.env),
    },
    {
      provide: MONGO_CLIENT,
      useFactory: async (config: AppConfig): Promise<MongoClient> => {
        const client = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 10_000 });
        await client.connect();
        return client;
      },
      inject: [APP_CONFIG],
    },
    {
      provide: MONGO_DB,
      useFactory: (client: MongoClient): Db => client.db(),
      inject: [MONGO_CLIENT],
    },
    {
      provide: TokenVerifier,
      useFactory: (config: AppConfig): TokenVerifier =>
        new TokenVerifier({ issuer: config.oidc.issuer, audience: config.oidc.audience }),
      inject: [APP_CONFIG],
    },
    { provide: SessionService, useFactory: (db: Db) => new SessionService(db), inject: [MONGO_DB] },
    {
      // One limiter, two buckets: the unauthenticated signup and login routes. A second copy of
      // this is the one that drifts, and a limiter that drifts is one that stops limiting.
      provide: AttemptLimiter,
      useFactory: (db: Db, config: AppConfig) => new AttemptLimiter(db, config),
      inject: [MONGO_DB, APP_CONFIG],
    },
    {
      provide: UserService,
      useFactory: (db: Db, t: TransactionRunner, a: AuditService, s: SessionService) =>
        new UserService(db, t, a, s),
      inject: [MONGO_DB, TransactionRunner, AuditService, SessionService],
    },
    {
      // The mailbox adapter on a local stack; a refusal in production, because no real transport
      // has been chosen and a silent no-op would leave every customer unreachable and unverified
      // while signup looked healthy.
      provide: NOTIFICATION_PORT,
      useFactory: (db: Db, config: AppConfig): NotificationPort =>
        config.isProduction
          ? new UnconfiguredNotificationAdapter()
          : new MailboxNotificationAdapter(db),
      inject: [MONGO_DB, APP_CONFIG],
    },
    {
      provide: MailboxNotificationAdapter,
      useFactory: (db: Db) => new MailboxNotificationAdapter(db),
      inject: [MONGO_DB],
    },
    {
      provide: AccountService,
      useFactory: (
        users: UserService,
        entitlements: EntitlementsService,
        notifications: NotificationPort,
        config: AppConfig,
      ) => new AccountService(users, entitlements, notifications, config),
      inject: [UserService, EntitlementsService, NOTIFICATION_PORT, APP_CONFIG],
    },
    {
      provide: NameFrequencyService,
      useFactory: (db: Db) => new NameFrequencyService(db),
      inject: [MONGO_DB],
    },
    {
      provide: SubjectsService,
      useFactory: (db: Db, nf: NameFrequencyService) => new SubjectsService(db, nf),
      inject: [MONGO_DB, NameFrequencyService],
    },
    {
      provide: ApiKeyService,
      useFactory: (db: Db) => new ApiKeyService(db),
      inject: [MONGO_DB],
    },
    {
      provide: EntitlementsService,
      useFactory: (db: Db) => new EntitlementsService(db),
      inject: [MONGO_DB],
    },
    {
      provide: SignupService,
      useFactory: (
        db: Db,
        transactions: TransactionRunner,
        audit: AuditService,
        limiter: AttemptLimiter,
        users: UserService,
        accounts: AccountService,
        config: AppConfig,
      ) => new SignupService(db, transactions, audit, limiter, users, accounts, config),
      inject: [
        MONGO_DB,
        TransactionRunner,
        AuditService,
        AttemptLimiter,
        UserService,
        AccountService,
        APP_CONFIG,
      ],
    },
    {
      provide: InboxReceiptService,
      useFactory: (db: Db) => new InboxReceiptService(db),
      inject: [MONGO_DB],
    },
    {
      provide: IdempotencyService,
      useFactory: (receipts: InboxReceiptService) => new IdempotencyService(receipts),
      inject: [InboxReceiptService],
    },
    {
      provide: StageExecutionService,
      useFactory: (db: Db) => new StageExecutionService(db),
      inject: [MONGO_DB],
    },
    {
      provide: OutboxService,
      useFactory: (db: Db) => new OutboxService(db),
      inject: [MONGO_DB],
    },
    {
      provide: SourceDocumentService,
      useFactory: (db: Db) => new SourceDocumentService(db),
      inject: [MONGO_DB],
    },
    {
      provide: RetentionService,
      useFactory: (db: Db) => new RetentionService(db),
      inject: [MONGO_DB],
    },
    {
      provide: LocalAuditCheckpointWriter,
      useFactory: (db: Db) => new LocalAuditCheckpointWriter(db),
      inject: [MONGO_DB],
    },
    {
      // The checkpoint writer is injected as a port, not constructed inline: SEC-06 requires
      // production to supply one whose credentials this process does not hold, and a seam that
      // only exists in a comment is a seam nobody can substitute at.
      provide: AuditService,
      useFactory: (db: Db, checkpoints: LocalAuditCheckpointWriter) =>
        new AuditService(db, checkpoints),
      inject: [MONGO_DB, LocalAuditCheckpointWriter],
    },
    {
      provide: VersionedRecordService,
      useFactory: (db: Db, t: TransactionRunner, a: AuditService, config: AppConfig) =>
        new VersionedRecordService(db, t, a, config.mode, config.disableSourceFourEyesForTesting),
      inject: [MONGO_DB, TransactionRunner, AuditService, APP_CONFIG],
    },
    {
      provide: CapabilityCoverageService,
      useFactory: (db: Db) => new CapabilityCoverageService(db),
      inject: [MONGO_DB],
    },
    {
      // Phase D step D5. The mutable observation document that sits *beside* the immutable
      // source version — breaker, budgets and kill switch. See `sources/source-health.service.ts`
      // for why it is a separate collection and why it is shared rather than tenant-owned.
      provide: SourceHealthService,
      useFactory: (db: Db, audit: AuditService, transactions: TransactionRunner) =>
        new SourceHealthService(db, audit, transactions),
      inject: [MONGO_DB, AuditService, TransactionRunner],
    },
    {
      // The per-domain half of FR-06's reliability controls (D-040). Separate from source
      // health because a discovery source is one agreement and a hundred publishers: when one
      // of those publishers refuses us, the fact belongs to the publisher, and the per-source
      // breaker has nowhere to put it that is not a lie about the feed.
      provide: DomainHealthService,
      useFactory: (db: Db, audit: AuditService, transactions: TransactionRunner) =>
        new DomainHealthService(db, audit, transactions),
      inject: [MONGO_DB, AuditService, TransactionRunner],
    },
    {
      provide: TransactionRunner,
      useFactory: (client: MongoClient) => new TransactionRunner(client),
      inject: [MONGO_CLIENT],
    },
    {
      // The queue is a port. SQS when one is configured; an in-process queue otherwise, which
      // is a development convenience and is logged as one — never a silent fallback that makes
      // a misconfigured production process look healthy while dropping every job.
      provide: QUEUE_PORT,
      useFactory: (config: AppConfig): QueuePort => {
        if (config.jobs.queueUrl === null) {
          new Logger('Queue').warn(
            'JOBS_QUEUE_URL is not set: using an in-process queue. Jobs do not survive a ' +
              'restart and are not visible to any other process.',
          );
          return new InMemoryQueueAdapter();
        }
        return new SqsQueueAdapter({
          queueUrl: config.jobs.queueUrl,
          region: config.jobs.region,
          ...(config.jobs.endpoint === null ? {} : { endpoint: config.jobs.endpoint }),
          ...(config.jobs.staticCredentials === null
            ? {}
            : { credentials: config.jobs.staticCredentials }),
        });
      },
      inject: [APP_CONFIG],
    },
    {
      // The index is a port for one reason: D12 is open, and C4's measurement may send this to
      // OpenSearch. Index-specific code outside this directory is what would make that
      // migration expensive enough to skip — which would decide D12 by inertia.
      provide: SEARCH_INDEX_PORT,
      useFactory: (config: AppConfig): SearchIndexPort => {
        switch (config.searchIndex.kind) {
          case 'meilisearch':
            return new MeilisearchAdapter({
              host: config.searchIndex.host ?? 'http://127.0.0.1:28700',
              apiKey: config.searchIndex.apiKey,
            });
          case 'opensearch':
            // Failing loudly is correct until D12 selects it. Silently falling back to
            // Meilisearch would make the configuration a lie.
            throw new Error(
              'SEARCH_INDEX_KIND=opensearch is not implemented. D12 closed at C4 in favour of ' +
                'Meilisearch on measured recall and latency (docs/decisions.md D-002). If a ' +
                're-open trigger fires, write OpenSearchAdapter next to MeilisearchAdapter.',
            );
          case 'in-memory':
            new Logger('SearchIndex').warn(
              'Using the in-process search index. It is a wiring stand-in, not an index: ' +
                'results are a substring scan and nothing survives a restart.',
            );
            return new InMemorySearchIndex();
        }
      },
      inject: [APP_CONFIG],
    },
    {
      // The six FR-05 source seams (Phase D step D2). One factory rather than six providers:
      // the mode rule — a mock is unreachable in live mode — is a single rule, and six
      // factories would be six places to get it right. See `sources/sources.registry.ts`.
      provide: SOURCE_ADAPTERS,
      useFactory: (
        config: AppConfig,
        sourceHealth: SourceHealthService,
        domainHealth: DomainHealthService,
      ): SourceAdapterSet =>
        buildSourceAdapters({
          mode: config.mode === 'mock' ? 'MOCK' : 'LIVE',
          companiesHouseApiKey: config.sources.companiesHouseApiKey,
          fetchContactUrl: config.sources.fetchContactUrl,
          // The live fetch adapter checks access immediately before every external call, which
          // is what makes the D5 kill switch effective mid-run (T36). Without it the adapter is
          // not constructed at all.
          sourceAccess: sourceHealth,
          // And the per-domain breaker, on the same rule: without it the adapter cannot notice
          // a publisher refusing it, so it is not constructed either (D-040).
          domainAccess: domainHealth,
        }),
      inject: [APP_CONFIG, SourceHealthService, DomainHealthService],
    },
    {
      provide: IndexerService,
      useFactory: (db: Db, index: SearchIndexPort, documents: SourceDocumentService) =>
        new IndexerService(db, index, documents),
      inject: [MONGO_DB, SEARCH_INDEX_PORT, SourceDocumentService],
    },
    {
      // The evidence object store. Behind a port for the same reason the index is, though not
      // for the same decision: there is no open question about S3 here. The seam exists so the
      // staging service can be tested against a store that can be made to fail on demand —
      // making a real bucket corrupt bytes means breaking it.
      provide: OBJECT_STORE_PORT,
      useFactory: (config: AppConfig): ObjectStorePort => {
        switch (config.storage.kind) {
          case 's3':
            return new S3ObjectStoreAdapter({
              bucket: config.storage.bucket ?? 'adverse-search-evidence-local',
              region: config.storage.region,
              ...(config.storage.endpoint === null ? {} : { endpoint: config.storage.endpoint }),
              ...(config.storage.staticCredentials === null
                ? {}
                : { credentials: config.storage.staticCredentials }),
            });
          case 'in-memory':
            new Logger('ObjectStore').warn(
              'Using the in-process evidence store. Nothing survives a restart, so committed ' +
                'references will outlive the bytes they name. Development only.',
            );
            return new InMemoryObjectStore();
        }
      },
      inject: [APP_CONFIG],
    },
    {
      provide: EvidenceStagingService,
      useFactory: (
        store: ObjectStorePort,
        documents: SourceDocumentService,
        retention: RetentionService,
        config: AppConfig,
      ) => new EvidenceStagingService(store, documents, retention, config.storage.region),
      inject: [OBJECT_STORE_PORT, SourceDocumentService, RetentionService, APP_CONFIG],
    },
    {
      provide: RetentionSweeper,
      useFactory: (
        store: ObjectStorePort,
        retention: RetentionService,
        documents: SourceDocumentService,
      ) => new RetentionSweeper(store, retention, documents),
      inject: [OBJECT_STORE_PORT, RetentionService, SourceDocumentService],
    },
    {
      // The dead-letter queue. In-process only when none is configured, and warned about in
      // the same terms as the other stand-ins: a message held in memory is a message lost at
      // restart, and this is the one class of message whose loss destroys evidence.
      provide: DEAD_LETTER_PORT,
      useFactory: (config: AppConfig): DeadLetterPort => {
        if (config.jobs.deadLetterQueueUrl === null) {
          new Logger('DeadLetter').warn(
            'JOBS_DEAD_LETTER_QUEUE_URL is not set: dead letters are held in process memory ' +
              'and lost at restart.',
          );
          return new InMemoryDeadLetterSink();
        }
        return new SqsDeadLetterAdapter({
          queueUrl: config.jobs.deadLetterQueueUrl,
          region: config.jobs.region,
          ...(config.jobs.endpoint === null ? {} : { endpoint: config.jobs.endpoint }),
          ...(config.jobs.staticCredentials === null
            ? {}
            : { credentials: config.jobs.staticCredentials }),
        });
      },
      inject: [APP_CONFIG],
    },
    {
      provide: TaxonomyService,
      useFactory: (db: Db) => new TaxonomyService(db),
      inject: [MONGO_DB],
    },
    {
      provide: FindingsService,
      useFactory: (db: Db) => new FindingsService(db),
      inject: [MONGO_DB],
    },
    {
      provide: SourceVersionService,
      useFactory: (db: Db) => new SourceVersionService(db),
      inject: [MONGO_DB],
    },
    {
      provide: IndexedSourceRepository,
      useFactory: (db: Db, transactions: TransactionRunner) =>
        new IndexedSourceRepository(db, transactions),
      inject: [MONGO_DB, TransactionRunner],
    },
    {
      provide: INDEXED_SOURCE_SCHEDULES,
      useFactory: (): ReadonlyMap<string, IndexedSourceSchedule> => {
        const ofac = new OfacXmlParser();
        return new Map<string, IndexedSourceSchedule>([
          [
            OFAC_SDN_SOURCE_ID,
            indexedSchedule(
              OFAC_SDN_SOURCE_ID,
              OFAC_SDN_XML_URL,
              ofac,
              21_600,
              86_400,
              10_000,
            ),
          ],
          [
            OFAC_NON_SDN_SOURCE_ID,
            indexedSchedule(
              OFAC_NON_SDN_SOURCE_ID,
              OFAC_NON_SDN_XML_URL,
              ofac,
              21_600,
              86_400,
              1_000,
            ),
          ],
          [
            UKSL_SOURCE_ID,
            indexedSchedule(
              UKSL_SOURCE_ID,
              UKSL_XML_URL,
              new UkslXmlParser(),
              21_600,
              86_400,
              1_000,
            ),
          ],
          [
            UNSC_SOURCE_ID,
            indexedSchedule(
              UNSC_SOURCE_ID,
              UNSC_XML_URL,
              new UnscXmlParser(),
              86_400,
              259_200,
              900,
            ),
          ],
          [
            EU_SANCTIONS_SOURCE_ID,
            indexedSchedule(
              EU_SANCTIONS_SOURCE_ID,
              EU_SANCTIONS_XML_URL,
              new EuSanctionsXmlParser(),
              86_400,
              259_200,
              2_000,
            ),
          ],
          [
            DOJ_FRAUD_SOURCE_ID,
            indexedSchedule(
              DOJ_FRAUD_SOURCE_ID,
              DOJ_FRAUD_RSS_URL,
              new OfficialFeedParser({
                parserId: 'official-feed',
                parserVersion: 'official-feed-doj-fraud-1',
                publisherUrl: 'https://www.justice.gov/fraud/fraud-enforcement-news',
                category: 'FRAUD_FINANCIAL_CRIME',
                defaultStage: 'ALLEGATION',
                includeItem: (item) => item.link?.includes('/pr/') ?? false,
              }),
              3_600,
              86_400,
              1,
              ['application/rss+xml', 'application/xml', 'text/xml'],
            ),
          ],
          [
            CFTC_ENFORCEMENT_SOURCE_ID,
            indexedSchedule(
              CFTC_ENFORCEMENT_SOURCE_ID,
              CFTC_ENFORCEMENT_RSS_URL,
              new OfficialFeedParser({
                parserId: 'official-feed',
                parserVersion: 'official-feed-cftc-enforcement-1',
                publisherUrl: 'https://www.cftc.gov/RSS/index.htm',
                category: 'MARKET_ABUSE',
                defaultStage: 'REGULATORY_ACTION_FINE',
              }),
              3_600,
              86_400,
              1,
              ['application/rss+xml', 'application/xml', 'text/xml'],
            ),
          ],
          [
            FTC_CONSUMER_SOURCE_ID,
            indexedSchedule(
              FTC_CONSUMER_SOURCE_ID,
              FTC_CONSUMER_RSS_URL,
              new OfficialFeedParser({
                parserId: 'official-feed',
                parserVersion: 'official-feed-ftc-consumer-1',
                publisherUrl: 'https://www.ftc.gov/stay-connected/rss',
                category: 'CONSUMER_HARM_MISSELLING',
                defaultStage: 'REGULATORY_ACTION_FINE',
              }),
              3_600,
              86_400,
              1,
              ['application/rss+xml', 'application/xml', 'text/xml'],
            ),
          ],
          [
            FCA_WARNINGS_SOURCE_ID,
            indexedSchedule(
              FCA_WARNINGS_SOURCE_ID,
              FCA_WARNINGS_RSS_URL,
              new OfficialFeedParser({
                parserId: 'official-feed',
                parserVersion: 'official-feed-fca-warnings-1',
                publisherUrl:
                  'https://www.fca.org.uk/consumers/warning-list-unauthorised-firms',
                category: 'CONSUMER_HARM_MISSELLING',
                defaultStage: 'ALLEGATION',
              }),
              3_600,
              86_400,
              1,
              ['application/rss+xml', 'application/xml', 'text/xml'],
            ),
          ],
          [
            WORLD_BANK_DEBARRED_SOURCE_ID,
            indexedSchedule(
              WORLD_BANK_DEBARRED_SOURCE_ID,
              WORLD_BANK_DEBARRED_API_URL,
              new WorldBankDebarmentParser(),
              10_800,
              43_200,
              1_000,
              ['application/json', 'text/json'],
            ),
          ],
        ]);
      },
    },
    {
      provide: SCHEDULED_ARTIFACT_TRANSPORT,
      useFactory: (
        gate: FetchGateService,
        adapters: SourceAdapterSet,
        config: AppConfig,
      ): ScheduledArtifactTransport => {
        if (adapters.evidenceFetch === null) {
          return {
            fetch: (): Promise<never> =>
              Promise.reject(
                new Error('No live evidence-fetch adapter is configured for source refresh.'),
              ),
          };
        }
        return new ScheduledArtifactTransportAdapter(
          gate,
          adapters.evidenceFetch,
          (): Date => new Date(),
          (sourceId): Readonly<Record<string, string>> => {
            if (sourceId !== WORLD_BANK_DEBARRED_SOURCE_ID) {
              return {};
            }
            if (config.sources.worldBankSanctionsApiKey === null) {
              throw new Error(
                'WORLD_BANK_SANCTIONS_API_KEY is not configured; publisher contact was not attempted.',
              );
            }
            return { apikey: config.sources.worldBankSanctionsApiKey };
          },
        );
      },
      inject: [FetchGateService, SOURCE_ADAPTERS, APP_CONFIG],
    },
    {
      provide: IndexedSourceRefreshService,
      useFactory: (
        repository: IndexedSourceRepository,
        versions: SourceVersionService,
        transport: ScheduledArtifactTransport,
        schedules: ReadonlyMap<string, IndexedSourceSchedule>,
      ) => new IndexedSourceRefreshService(repository, versions, transport, schedules),
      inject: [
        IndexedSourceRepository,
        SourceVersionService,
        SCHEDULED_ARTIFACT_TRANSPORT,
        INDEXED_SOURCE_SCHEDULES,
      ],
    },
    IndexedSourceScheduler,
    {
      provide: IndexedSourceSearchService,
      useFactory: (
        repository: IndexedSourceRepository,
        versions: SourceVersionService,
        schedules: ReadonlyMap<string, IndexedSourceSchedule>,
      ) => new IndexedSourceSearchService(repository, versions, [...schedules.keys()]),
      inject: [IndexedSourceRepository, SourceVersionService, INDEXED_SOURCE_SCHEDULES],
    },
    {
      // The FR-06 fetch gate (Phase E step 2): the only issuer of a `FetchAuthorisation`, and
      // the holder of this process's one egress identity. In live mode with no contact URL it
      // has no identity and refuses every fetch, which is the same rule `buildSourceAdapters`
      // applies to the adapter itself — an unattributable request is a defect, not a fallback.
      provide: FetchGateService,
      useFactory: (versions: SourceVersionService, config: AppConfig) =>
        new FetchGateService(versions, config.mode === 'mock' ? 'MOCK' : 'LIVE', {
          mode: config.mode === 'mock' ? 'MOCK' : 'LIVE',
          contactUrl: config.sources.fetchContactUrl,
          region: config.jobs.region,
        }),
      inject: [SourceVersionService, APP_CONFIG],
    },
    {
      // The FR-04 → FR-11 pipeline (Phase E). Every judgement it makes is a pure function from
      // `@erly/adverse-domain`; this provider only supplies it the I/O it sequences.
      provide: SearchPipeline,
      useFactory: (
        subjects: SubjectsService,
        associations: AssociationGraphService,
        taxonomies: TaxonomyService,
        policies: PolicyService,
        adapters: SourceAdapterSet,
        evidence: EvidenceStagingService,
        findings: FindingsService,
        sourceHealth: SourceHealthService,
        fetchGate: FetchGateService,
        config: AppConfig,
        ladder: LadderBuilder,
        cascade: CascadeService,
        requestLog: DiscoveryRequestLog,
        indexedSources: IndexedSourceSearchService,
      ) =>
        new SearchPipeline(
          subjects,
          associations,
          taxonomies,
          policies,
          adapters,
          evidence,
          findings,
          sourceHealth,
          fetchGate,
          config.mode,
          ladder,
          cascade,
          requestLog,
          indexedSources,
        ),
      inject: [
        SubjectsService,
        AssociationGraphService,
        TaxonomyService,
        PolicyService,
        SOURCE_ADAPTERS,
        EvidenceStagingService,
        FindingsService,
        SourceHealthService,
        FetchGateService,
        APP_CONFIG,
        LadderBuilder,
        CascadeService,
        DiscoveryRequestLog,
        IndexedSourceSearchService,
      ],
    },
    // What the live discovery connectors put on the wire (D-060). A singleton for the same
    // reason the poll cache is one: it measures traffic the publisher sees, which is a property
    // of the process. A diagnostic — nothing reads it back to decide anything.
    DiscoveryRequestLog,
    // The fixed-feed poll floor. A singleton because what it bounds is the number of requests
    // the publisher sees, which is a property of the process rather than of any one run.
    FixedFeedPollCache,
    {
      // What sits on the FR-05 ladder, read from the registry on every run (D-045). Not cached:
      // a cached ladder keeps asking a source an administrator retired.
      provide: LadderBuilder,
      useFactory: (
        db: Db,
        adapters: SourceAdapterSet,
        config: AppConfig,
        versions: SourceVersionService,
        gate: FetchGateService,
        pollCache: FixedFeedPollCache,
        requestLog: DiscoveryRequestLog,
      ) =>
        new LadderBuilder(db, adapters, {
          mode: config.mode === 'mock' ? 'MOCK' : 'LIVE',
          versions,
          gate,
          // The one fetch path. A live RSS connector reads its feed through the same adapter a
          // document fetch uses, so it inherits the SEC-02 screening, robots, both byte budgets,
          // both breakers and the D17 stop conditions rather than growing a weaker copy.
          evidenceFetch: adapters.evidenceFetch,
          // One per process, so a fixed feed costs one request per poll floor however many
          // queries or searches are matched against it.
          pollCache,
          // So a QUERY_FEED's per-query request count and a FIXED_FEED's collapsed one are both
          // numbers on the response rather than claims in a comment.
          requestLog,
        }),
      inject: [
        MONGO_DB,
        SOURCE_ADAPTERS,
        APP_CONFIG,
        SourceVersionService,
        FetchGateService,
        FixedFeedPollCache,
        DiscoveryRequestLog,
      ],
    },
    {
      // Walking it. Separate from the builder so the walk is testable against a ladder of stubs
      // with no database at all.
      provide: CascadeService,
      useFactory: (health: SourceHealthService) => new CascadeService(health),
      inject: [SourceHealthService],
    },
    {
      provide: SearchJobHandler,
      useFactory: (
        db: Db,
        pipeline: SearchPipeline,
        findings: FindingsService,
        transactions: TransactionRunner,
      ) => new SearchJobHandler(db, pipeline, findings, transactions),
      inject: [MONGO_DB, SearchPipeline, FindingsService, TransactionRunner],
    },
    {
      provide: JobConsumer,
      useFactory: (
        stages: StageExecutionService,
        receipts: InboxReceiptService,
        transactions: TransactionRunner,
        deadLetters: DeadLetterPort,
        searches: SearchesService,
        searchHandler: SearchJobHandler,
        config: AppConfig,
      ) => {
        const consumer = new JobConsumer(
          stages,
          receipts,
          transactions,
          deadLetters,
          // Bound to the search run's own loader. Note what is *not* passed: a tenant. See
          // `jobs/job-ownership.ts` for why a tenant-scoped loader defeats the check (SEC-01).
          async (aggregateId: string) => searches.loadOwnership(aggregateId),
          {
            ...DEFAULT_CONSUMER_OPTIONS,
            consumerName: 'search-worker',
            leaseMs: config.jobs.leaseMs,
            maxExecutionMs: config.jobs.maxExecutionMs,
            maxDeliveries: config.jobs.maxDeliveries,
          },
        );
        // The registration that lets the worker start at all. Until Phase E there was no
        // handler, and `WorkerRuntime.start()` refused rather than dead-lettering every
        // queued search as unroutable (decision D-016).
        consumer.register(searchHandler);
        return consumer;
      },
      inject: [
        StageExecutionService,
        InboxReceiptService,
        TransactionRunner,
        DEAD_LETTER_PORT,
        SearchesService,
        SearchJobHandler,
        APP_CONFIG,
      ],
    },
    {
      provide: WorkerRuntime,
      useFactory: (queue: QueuePort, consumer: JobConsumer, stages: StageExecutionService) =>
        new WorkerRuntime(queue, consumer, stages),
      inject: [QUEUE_PORT, JobConsumer, StageExecutionService],
    },
    {
      provide: OutboxPublisher,
      useFactory: (outbox: OutboxService, queue: QueuePort) => new OutboxPublisher(outbox, queue),
      inject: [OutboxService, QUEUE_PORT],
    },
    {
      // The pinned policy version: the FR-02 traversal bounds and the historical-scope
      // approval (Phase D step D4). Read by version, never "the current one" — a run must be
      // explainable under the rules it actually ran with.
      provide: PolicyService,
      useFactory: (db: Db) => new PolicyService(db),
      inject: [MONGO_DB],
    },
    {
      // FR-02 (Phase D step D3). Given the whole adapter set rather than one registry, because
      // which register answers depends on the jurisdiction the search asked for, and that is a
      // per-search question rather than a wiring one.
      provide: AssociationGraphService,
      useFactory: (
        db: Db,
        subjects: SubjectsService,
        adapters: SourceAdapterSet,
        capabilities: CapabilityCoverageService,
        transactions: TransactionRunner,
        audit: AuditService,
        policies: PolicyService,
        config: AppConfig,
      ) =>
        new AssociationGraphService(
          db,
          subjects,
          adapters,
          capabilities,
          transactions,
          audit,
          policies,
          config.mode,
        ),
      inject: [
        MONGO_DB,
        SubjectsService,
        SOURCE_ADAPTERS,
        CapabilityCoverageService,
        TransactionRunner,
        AuditService,
        PolicyService,
        APP_CONFIG,
      ],
    },
    {
      provide: SearchesService,
      useFactory: (
        db: Db,
        e: EntitlementsService,
        s: SubjectsService,
        t: TransactionRunner,
        a: AuditService,
        o: OutboxService,
        i: IndexerService,
        st: StageExecutionService,
        ag: AssociationGraphService,
        fs2: FindingsService,
        tx: TaxonomyService,
        sh: SourceHealthService,
        config: AppConfig,
      ) => new SearchesService(db, e, s, t, a, o, i, st, ag, fs2, tx, sh, config.mode),
      inject: [
        MONGO_DB,
        EntitlementsService,
        SubjectsService,
        TransactionRunner,
        AuditService,
        OutboxService,
        IndexerService,
        StageExecutionService,
        AssociationGraphService,
        FindingsService,
        TaxonomyService,
        SourceHealthService,
        APP_CONFIG,
      ],
    },
    {
      provide: ScreenService,
      useFactory: (
        searches: SearchesService,
        searchHandler: SearchJobHandler,
        stages: StageExecutionService,
      ) => new ScreenService(searches, searchHandler, stages),
      inject: [SearchesService, SearchJobHandler, StageExecutionService],
    },

    {
      provide: StartupService,
      useFactory: (
        sessions: SessionService,
        users: UserService,
        limiter: AttemptLimiter,
        mailbox: MailboxNotificationAdapter,
        apiKeys: ApiKeyService,
        signups: SignupService,
        subjects: SubjectsService,
        nameFrequency: NameFrequencyService,
        receipts: InboxReceiptService,
        searches: SearchesService,
        stages: StageExecutionService,
        outbox: OutboxService,
        documents: SourceDocumentService,
        retention: RetentionService,
        audit: AuditService,
        checkpoints: LocalAuditCheckpointWriter,
        indexer: IndexerService,
        adminRecords: VersionedRecordService,
        capabilities: CapabilityCoverageService,
        sourceHealth: SourceHealthService,
        domainHealth: DomainHealthService,
        indexedSources: IndexedSourceRepository,
        config: AppConfig,
      ) =>
        new StartupService(
          sessions,
          users,
          limiter,
          mailbox,
          apiKeys,
          signups,
          subjects,
          nameFrequency,
          receipts,
          searches,
          stages,
          outbox,
          documents,
          retention,
          audit,
          checkpoints,
          indexer,
          adminRecords,
          capabilities,
          sourceHealth,
          domainHealth,
          indexedSources,
          config,
        ),
      inject: [
        SessionService,
        UserService,
        AttemptLimiter,
        MailboxNotificationAdapter,
        ApiKeyService,
        SignupService,
        SubjectsService,
        NameFrequencyService,
        InboxReceiptService,
        SearchesService,
        StageExecutionService,
        OutboxService,
        SourceDocumentService,
        RetentionService,
        AuditService,
        LocalAuditCheckpointWriter,
        IndexerService,
        VersionedRecordService,
        CapabilityCoverageService,
        SourceHealthService,
        DomainHealthService,
        IndexedSourceRepository,
        APP_CONFIG,
      ],
    },

    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
/* eslint-disable-next-line @typescript-eslint/no-extraneous-class --
   A NestJS module is a decorator carrier by design: it has no members and needs none. */
export class AppModule {}
