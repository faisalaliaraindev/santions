import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { SessionService } from './auth/session.service.js';
import { ApiKeyService } from './tenancy/api-key.service.js';
import { IdempotencyService } from './searches/idempotency.service.js';
import { SearchesService } from './searches/searches.service.js';
import { NameFrequencyService } from './subjects/name-frequency.service.js';
import { SubjectsService } from './subjects/subjects.service.js';

/**
 * Creates the indexes each service depends on, at startup.
 *
 * A dedicated provider rather than logic in the module class: module classes are awkward to
 * inject into and the failure mode is silent — an unresolved dependency shows up as a
 * `undefined.ensureIndexes()` at boot rather than as a wiring error.
 *
 * Index creation is idempotent, so a fresh database is usable without a manual step and a
 * restart against an existing one is a no-op.
 */
@Injectable()
export class StartupService implements OnModuleInit {
  private readonly logger = new Logger('Startup');

  constructor(
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyService,
    private readonly subjects: SubjectsService,
    private readonly nameFrequency: NameFrequencyService,
    private readonly idempotency: IdempotencyService,
    private readonly searches: SearchesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.sessions.ensureIndexes(),
      this.apiKeys.ensureIndexes(),
      this.subjects.ensureIndexes(),
      this.nameFrequency.ensureIndexes(),
      this.idempotency.ensureIndexes(),
      this.searches.ensureIndexes(),
    ]);
    this.logger.log('Indexes ensured.');
  }
}
