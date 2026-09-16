import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { Inject } from '@nestjs/common';

import { CapabilityCoverageService } from './admin/capability-coverage.service.js';
import { AttemptLimiter } from './common/attempt-limiter.js';
import type { AppConfig } from './config/config.js';
import { APP_CONFIG } from './tokens.js';
import { VersionedRecordService } from './admin/versioned-record.service.js';
import { MailboxNotificationAdapter } from './auth/notification.port.js';
import { SessionService } from './auth/session.service.js';
import { UserService } from './auth/user.service.js';
import { AuditService, LocalAuditCheckpointWriter } from './persistence/audit.service.js';
import { InboxReceiptService } from './persistence/inbox-receipt.service.js';
import { OutboxService } from './persistence/outbox.service.js';
import { RetentionService } from './persistence/retention.service.js';
import { SourceDocumentService } from './persistence/source-document.service.js';
import { StageExecutionService } from './persistence/stage-execution.service.js';
import { IndexerService } from './search-index/indexer.service.js';
import { ApiKeyService } from './tenancy/api-key.service.js';
import { SignupService } from './tenancy/signup.service.js';
import { SearchesService } from './searches/searches.service.js';
import { DomainHealthService } from './sources/domain-health.service.js';
import { assertOutboundUserAgent } from './sources/egress-identity.js';
import { SourceHealthService } from './sources/source-health.service.js';
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
    private readonly users: UserService,
    private readonly limiter: AttemptLimiter,
    private readonly mailbox: MailboxNotificationAdapter,
    private readonly apiKeys: ApiKeyService,
    private readonly signups: SignupService,
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
    private readonly adminRecords: VersionedRecordService,
    private readonly capabilities: CapabilityCoverageService,
    private readonly sourceHealth: SourceHealthService,
    private readonly domainHealth: DomainHealthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    // Before any index, because this one can refuse the boot. FR-06 requires the outbound user
    // agent to identify this service honestly with a contact URL, and a process that cannot
    // build one must stop here — where somebody is watching — rather than at the first search,
    // where the only symptom is a capability quietly reported as unavailable.
    const userAgent = assertOutboundUserAgent({
      mode: this.config.mode === 'mock' ? 'MOCK' : 'LIVE',
      contactUrl: this.config.sources.fetchContactUrl,
    });
    this.logger.log(`Outbound user agent: ${userAgent}`);

    await Promise.all([
      this.sessions.ensureIndexes(),
      this.users.ensureIndexes(),
      this.limiter.ensureIndexes(),
      this.mailbox.ensureIndexes(),
      this.apiKeys.ensureIndexes(),
      this.signups.ensureIndexes(),
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
      this.adminRecords.ensureIndexes(),
      this.capabilities.ensureIndexes(),
      this.sourceHealth.ensureIndexes(),
      this.domainHealth.ensureIndexes(),
    ]);
    this.logger.log('Indexes ensured.');
  }
}
