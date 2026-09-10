/**
 * API bootstrap.
 *
 * Security headers, CORS, body limits and versioning are set here rather than per-route, so
 * they cannot be forgotten on the route that matters.
 */

import 'reflect-metadata';

import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule, APP_CONFIG } from './app.module.js';
import { correlationMiddleware } from './common/correlation.js';
import type { AppConfig } from './config/config.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // The framework's default error output can echo request bodies. Ours never does.
    bodyParser: true,
  });

  const config = app.get<AppConfig>(APP_CONFIG);

  // All public routes are versioned under /v1 (section 6.1).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });

  app.use(correlationMiddleware);
  app.use(cookieParser());

  app.use(
    helmet({
      // The API serves JSON, never active content. A restrictive CSP costs nothing here and
      // matters if an error page ever renders.
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      // Evidence downloads are served as attachments with safe content types (SEC-03).
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  // Explicit allowlist. `credentials: true` is only safe with a fixed origin list — never
  // with a reflected origin, which would let any site drive an authenticated session (T08).
  app.enableCors({
    origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-CSRF-Token'],
    maxAge: 600,
  });

  // Bounded request size (section 6.1, 413).
  app.useBodyParser('json', { limit: '256kb' });

  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.log(`API listening on ${String(config.port)} (${config.nodeEnv}, mode=${config.mode})`);
  if (!config.isProduction) {
    logger.warn('Development configuration. Production startup rejects this setup (test T09).');
  }
}

bootstrap().catch((error: unknown) => {
  // A configuration failure must be loud and must stop the process. Starting with a
  // development issuer in production is worse than not starting at all.
  console.error('\nAPI failed to start.\n');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
