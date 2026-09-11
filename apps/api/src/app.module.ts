import { Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MongoClient, type Db } from 'mongodb';

import { AdminController } from './admin/admin.controller.js';
import { CapabilityCoverageService } from './admin/capability-coverage.service.js';
import { VersionedRecordService } from './admin/versioned-record.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard, PermissionGuard } from './auth/auth.guard.js';
import { CsrfGuard } from './auth/csrf.guard.js';
import { SessionService } from './auth/session.service.js';
import { TokenVerifier } from './auth/token-verifier.js';
import { ApiExceptionFilter } from './common/exception.filter.js';
import { ReservedController } from './common/reserved.controller.js';
import { loadConfig, type AppConfig } from './config/config.js';
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
import { TransactionRunner } from './persistence/transaction.runner.js';
import { IdempotencyService } from './searches/idempotency.service.js';
import { SearchesController } from './searches/searches.controller.js';
import { SearchesService } from './searches/searches.service.js';
import { NameFrequencyService } from './subjects/name-frequency.service.js';
import { SubjectsController } from './subjects/subjects.controller.js';
import { SubjectsService } from './subjects/subjects.service.js';
import { StartupService } from './startup.service.js';
import { ApiKeyService } from './tenancy/api-key.service.js';
import { EntitlementsService } from './tenancy/entitlements.service.js';

// Re-exported for convenience; defined in ./tokens.js to avoid a circular import.
export { APP_CONFIG, MONGO_CLIENT, MONGO_DB } from './tokens.js';

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
    SubjectsController,
    SearchesController,
    // ReservedController must be registered BEFORE AdminController. Nest matches routes in
    // registration order, and AdminController's `/v1/admin/:collection` would otherwise shadow
    // the reserved `/v1/admin/plans`, turning a documented 501 into a 403 from a permission
    // check on a route that was never meant to exist (FR-15, decision D-007).
    ReservedController,
    AdminController,
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
        new VersionedRecordService(db, t, a, config.mode),
      inject: [MONGO_DB, TransactionRunner, AuditService, APP_CONFIG],
    },
    {
      provide: CapabilityCoverageService,
      useFactory: (db: Db) => new CapabilityCoverageService(db),
      inject: [MONGO_DB],
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
      provide: JobConsumer,
      useFactory: (
        stages: StageExecutionService,
        receipts: InboxReceiptService,
        transactions: TransactionRunner,
        deadLetters: DeadLetterPort,
        searches: SearchesService,
        config: AppConfig,
      ) =>
        new JobConsumer(
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
        ),
      inject: [
        StageExecutionService,
        InboxReceiptService,
        TransactionRunner,
        DEAD_LETTER_PORT,
        SearchesService,
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
      ) => new SearchesService(db, e, s, t, a, o, i, st),
      inject: [
        MONGO_DB,
        EntitlementsService,
        SubjectsService,
        TransactionRunner,
        AuditService,
        OutboxService,
        IndexerService,
        StageExecutionService,
      ],
    },

    {
      provide: StartupService,
      useFactory: (
        sessions: SessionService,
        apiKeys: ApiKeyService,
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
      ) =>
        new StartupService(
          sessions,
          apiKeys,
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
        ),
      inject: [
        SessionService,
        ApiKeyService,
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
