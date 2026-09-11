import { Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MongoClient, type Db } from 'mongodb';

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
import { OutboxPublisher } from './jobs/outbox-publisher.js';
import { InMemoryQueueAdapter, QUEUE_PORT, type QueuePort } from './jobs/queue.port.js';
import { SqsQueueAdapter } from './jobs/sqs-queue.adapter.js';
import { AuditService, LocalAuditCheckpointWriter } from './persistence/audit.service.js';
import { InboxReceiptService } from './persistence/inbox-receipt.service.js';
import { OutboxService } from './persistence/outbox.service.js';
import { RetentionService } from './persistence/retention.service.js';
import { SourceDocumentService } from './persistence/source-document.service.js';
import { StageExecutionService } from './persistence/stage-execution.service.js';
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
    ReservedController,
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
      ) => new SearchesService(db, e, s, t, a, o),
      inject: [
        MONGO_DB,
        EntitlementsService,
        SubjectsService,
        TransactionRunner,
        AuditService,
        OutboxService,
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
