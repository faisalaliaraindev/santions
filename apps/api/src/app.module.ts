import { Module } from '@nestjs/common';
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
import { IdempotencyService } from './searches/idempotency.service.js';
import { SearchesController } from './searches/searches.controller.js';
import { SearchesService } from './searches/searches.service.js';
import { NameFrequencyService } from './subjects/name-frequency.service.js';
import { SubjectsController } from './subjects/subjects.controller.js';
import { SubjectsService } from './subjects/subjects.service.js';
import { StartupService } from './startup.service.js';
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
      provide: EntitlementsService,
      useFactory: (db: Db) => new EntitlementsService(db),
      inject: [MONGO_DB],
    },
    {
      provide: IdempotencyService,
      useFactory: (db: Db) => new IdempotencyService(db),
      inject: [MONGO_DB],
    },
    {
      provide: SearchesService,
      useFactory: (db: Db, e: EntitlementsService, s: SubjectsService) =>
        new SearchesService(db, e, s),
      inject: [MONGO_DB, EntitlementsService, SubjectsService],
    },

    {
      provide: StartupService,
      useFactory: (
        sessions: SessionService,
        subjects: SubjectsService,
        nameFrequency: NameFrequencyService,
        idempotency: IdempotencyService,
        searches: SearchesService,
      ) => new StartupService(sessions, subjects, nameFrequency, idempotency, searches),
      inject: [
        SessionService,
        SubjectsService,
        NameFrequencyService,
        IdempotencyService,
        SearchesService,
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
