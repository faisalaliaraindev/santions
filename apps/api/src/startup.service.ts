import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { SessionService } from './auth/session.service.js';
import { AuditService, LocalAuditCheckpointWriter } from './persistence/audit.service.js';
import { InboxReceiptService } from './persistence/inbox-receipt.service.js';
import { OutboxService } from './persistence/outbox.service.js';
import { RetentionService } from './persistence/retention.service.js';
import { SourceDocumentService } from './persistence/source-document.service.js';
import { StageExecutionService } from './persistence/stage-execution.service.js';
import { IndexerService } from './search-index/indexer.service.js';
import { ApiKeyService } from './tenancy/api-key.service.js';
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
 *
 * **This is additive-only, and that is a decision rather than an omission.** Every index here
 * can be created against existing data without transforming a document. Anything that cannot —
 * a field renamed, a value re-shaped — needs a migration runner, and the reasoning for not
 * building one yet is in `docs/architecture.md` under "Migrations".
 */
@Injectable()
export class StartupService implements OnModuleInit {
  private readonly logger = new Logger('Startup');

  constructor(
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyService,
    private readonly subjects: SubjectsService,
    private readonly nameFrequency: NameFrequencyService,
    private readonly receipts: InboxReceiptService,
    private readonly searches: SearchesService,
    private readonly stages: StageExecutionService,
    private readonly outbox: OutboxService,
    private readonly documents: SourceDocumentService,
    private readonly retention: RetentionService,
    private readonly audit: AuditService,
    private readonly auditCheckpoints: LocalAuditCheckpointWriter,
    private readonly indexer: IndexerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.sessions.ensureIndexes(),
      this.apiKeys.ensureIndexes(),
      this.subjects.ensureIndexes(),
      this.nameFrequency.ensureIndexes(),
      this.receipts.ensureIndexes(),
      this.searches.ensureIndexes(),
      this.stages.ensureIndexes(),
      this.outbox.ensureIndexes(),
      this.documents.ensureIndexes(),
      this.retention.ensureIndexes(),
      this.audit.ensureIndexes(),
      this.auditCheckpoints.ensureIndexes(),
      this.indexer.ensureIndexes(),
    ]);
    this.logger.log('Indexes ensured.');
  }
}
