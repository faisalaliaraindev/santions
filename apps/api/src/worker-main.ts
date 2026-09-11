/**
 * Worker bootstrap — the second entrypoint into the same application.
 *
 * **Why this is not a separate `apps/worker` package** (decision D-016). The worker needs the
 * same configuration, the same Mongo client, the same records, the same transaction runner and
 * the same ports as the API; a second package would either import all of that across an app
 * boundary or grow its own copy. A second copy of the wiring is a second place for the tenant
 * scoping, the fencing and the failure classification to drift, and the drift would not show
 * up in a test — it would show up as a worker doing something the API's tests say cannot
 * happen. One codebase, one DI graph, two entrypoints, one image, separate processes and
 * separate scaling.
 *
 * The HTTP server is never created here: `createApplicationContext` builds the providers and
 * nothing else. A worker that also listened would be an unaudited way into the API.
 *
 * **This exits non-zero today, deliberately.** No job handler exists yet — the pipeline is
 * Phase E — and a worker with no handlers does not idle: it receives every queued search and
 * dead-letters it as unroutable. Starting would look healthy while draining the queue into the
 * DLQ, so it refuses, says why, and consumes nothing.
 */

import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { WorkerRuntime } from './jobs/worker-runtime.service.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('WorkerBootstrap');

  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  // Note what is *not* started here: the outbox publisher. It polls only when told to, and it
  // is told to in `main.ts`. Two publishers over the same rows is contention for no benefit —
  // the outbox is already at-least-once, and a second poller doubles the read rate while
  // halving each one's useful batch.
  const runtime = app.get(WorkerRuntime);

  try {
    runtime.start();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    await app.close();
    process.exitCode = 1;
    return;
  }

  logger.log('Worker started. Draining on SIGTERM.');
}

void bootstrap();
