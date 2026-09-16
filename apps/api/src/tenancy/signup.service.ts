/**
 * `POST /v1/signup` — a tenant creates itself (phase I step I1, D-053).
 *
 * # All four records, or none
 *
 * `local-bootstrap` writes four records for every tenant, and a tenant holding three of them is
 * not a partial tenant — it is a broken one whose symptom appears somewhere else entirely. No
 * taxonomy version means the first search is refused with `INVALID_POLICY`, which reads as a
 * defect in search rather than as a signup that stopped halfway. So the four writes and the
 * audit entry go through `TransactionRunner` together: they commit as one thing or none of them
 * happens.
 *
 * # The tenant id is generated here and cannot be asked for
 *
 * A caller who can name their own tenant id can name somebody else's. The best case is a
 * duplicate-key error; the worst is a signup that lands on the boundary of another customer's
 * data. The request schema has no such field and is `.strict()`, so sending one is refused
 * rather than ignored — and this service ignores the body entirely when generating the id.
 *
 * # An unauthenticated write needs a bound
 *
 * This is the only route in the service that writes to the database without a credential. With
 * no bound, one script creates tenants until the collection is the problem. Attempts are counted
 * per client address in a small collection with a TTL, and the answer past the bound is a
 * `429`, which is the one error code in the contract that means "this exact request may work
 * later".
 *
 * That bound is not the whole answer to abuse and is not claimed to be: it is a floor under an
 * open door (D-053), not the per-tenant live budget D-052 deferred.
 */

import { createHmac, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import type { SignupInput, SignupResult } from '@erly/adverse-contracts';

import { AccountService } from '../auth/account.service.js';
import { assessPassword } from '../auth/password.js';
import { UserError, UserService, type SafeUser } from '../auth/user.service.js';
import { ApiException } from '../common/api-exception.js';
import { AuditService } from '../persistence/audit.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../tokens.js';
import type { EntitlementVersionRecord, TenantRecord } from './entitlements.service.js';
import { CREATED_VIA_SIGNUP, decideLiveAccess } from './live-access.js';
import { buildTenantProvisioning, INITIAL_VERSION } from './provisioning.js';

/**
 * A keyed digest of the address, never the address.
 *
 * A bare SHA-256 of an IPv4 address is not anonymisation — the whole space is four billion values
 * and a laptop walks it in seconds. Keying the digest with the deployment's own secret makes the
 * stored value useless to anyone who does not also hold that secret, while still being stable
 * enough to count against for an hour.
 *
 * Exported rather than private so that anything needing to find one origin's rows — an operator
 * asking why an address is being refused, a test clearing its own bucket without touching
 * another's — uses this function instead of reimplementing the keying beside it.
 */
export function signupOriginKey(secret: string, ip: string | undefined): string {
  return createHmac('sha256', secret)
    .update(ip ?? 'unknown')
    .digest('hex');
}

/** How long a signup attempt counts against its origin. */
export const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Signups permitted from one address per window.
 *
 * Generous by design. A real firm signs up once; five leaves room for a genuine second tenant,
 * a colleague on the same office address, and two mistakes, while still turning an unattended
 * script into a few rows rather than a few million.
 */
export const SIGNUP_MAX_PER_WINDOW = 5;

/** Why signup was refused before anything was written. */
export type SignupRejection = 'RATE_LIMITED' | 'WEAK_PASSWORD' | 'EMAIL_TAKEN';

export class SignupError extends Error {
  constructor(
    readonly rejection: SignupRejection,
    message: string,
    /** Safe to show the caller. A weak password has to say what was wrong with it. */
    readonly publicDetail?: string,
  ) {
    super(message);
    this.name = 'SignupError';
  }
}

interface SignupAttemptRecord {
  /** Keyed, never the address itself — see `originKey`. */
  readonly originKey: string;
  readonly at: Date;
}

export interface SignupRequestContext {
  /**
   * The remote address, as Express resolved it.
   *
   * Deliberately not `X-Forwarded-For`. Without a trusted proxy configured, that header is
   * whatever the caller typed, and a limiter keyed on a value the caller chooses is a limiter
   * the caller opts out of. A deployment behind a proxy sets `trust proxy` so that `req.ip`
   * becomes the real address; until then this is the socket, which is the honest value.
   */
  readonly ip: string | undefined;
  readonly correlationId: string | null;
}

@Injectable()
export class SignupService {
  private readonly logger = new Logger('Signup');

  private readonly tenants: Collection<TenantRecord>;
  private readonly entitlements: Collection<EntitlementVersionRecord>;
  private readonly taxonomies: Collection<Record<string, unknown>>;
  private readonly policies: Collection<Record<string, unknown>>;
  private readonly attempts: Collection<SignupAttemptRecord>;

  constructor(
    db: Db,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly users: UserService,
    private readonly accounts: AccountService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.tenants = db.collection<TenantRecord>('tenants');
    this.entitlements = db.collection<EntitlementVersionRecord>('tenantEntitlementVersions');
    this.taxonomies = db.collection('taxonomyVersions');
    this.policies = db.collection('policyVersions');
    this.attempts = db.collection<SignupAttemptRecord>('signupAttempts');
  }

  async ensureIndexes(): Promise<void> {
    // The generated id is 122 bits of randomness, so a collision is not the thing this guards
    // against — a second process, or a future code path, writing a tenant that already exists
    // is. `local-bootstrap` creates the same index; a database that was never bootstrapped, which
    // is what a real deployment is, would otherwise have signup as the only writer of this
    // collection and no constraint on it at all.
    await this.tenants.createIndex({ tenantId: 1 }, { unique: true });

    await this.attempts.createIndex({ originKey: 1, at: -1 });
    // The attempt log exists to bound a burst, not to build a record of who visited. Mongo
    // deletes each row an hour after it was written, so the collection never becomes a store
    // of addresses that somebody has to reason about under a retention policy.
    await this.attempts.createIndex(
      { at: 1 },
      { expireAfterSeconds: Math.floor(SIGNUP_WINDOW_MS / 1000) },
    );
  }

  /**
   * Create a tenant.
   *
   * The returned `liveAccess` is computed by the same function key issuance uses, against the
   * records this call just wrote — not restated from what signup intended. If the two could
   * disagree, the one the customer reads would be the wrong one.
   */
  async signUp(
    input: SignupInput,
    context: SignupRequestContext,
    now: Date = new Date(),
  ): Promise<SignupResult> {
    await this.recordAttempt(context, now);

    // Judged before a single record is written, and before the expensive hash is computed. The
    // two strings the request already contains are part of the check: a password that is the
    // organisation name or the email address is one an attacker holding a customer list guesses
    // first.
    const verdict = assessPassword(input.password, {
      email: input.contactEmail,
      organisationName: input.organisationName,
    });
    if (!verdict.ok) {
      throw new SignupError(
        'WEAK_PASSWORD',
        `password rejected: ${verdict.rejection}`,
        verdict.detail,
      );
    }

    // Generated. Not derived from the organisation name, which would leak one customer's
    // existence to another who guessed it, and would collide between two firms called the same
    // thing.
    const tenantId = `tenant-${randomUUID()}`;

    const provisioned = buildTenantProvisioning({
      tenantId,
      name: input.organisationName,
      // Both environments from day one (D-053). Live is not reachable yet for this tenant —
      // `decideLiveAccess` holds it behind the verified address D-052 requires — and that is
      // the point of granting it here: the grant is commercial state, the gate is tenant state,
      // and a later payment gate moves a value rather than rewriting a route.
      environments: ['sandbox', 'live'],
      provisionedBy: 'signup',
      decisionRef:
        'Provisioned by self-service signup (D-053: open signup, both key kinds). Categories: ' +
        'all seventeen (D-009). Languages es+en requested but NOT enabled until measured at G10.',
      now,
    });

    // Stamped on all four records, not only the tenant. T55: a fixture must never be able to
    // pass as a live result, and the cheapest way to keep that true is for the label to live on
    // the data rather than in a config flag somebody can flip. A taxonomy version written while
    // the service runs against fixtures is as mock as the tenant it belongs to.
    const mode = this.config.mode === 'live' ? 'LIVE' : 'MOCK';

    const tenant: TenantRecord = {
      ...provisioned.tenant,
      createdVia: CREATED_VIA_SIGNUP,
      // Not unique, and deliberately not indexed as such: one person may legitimately own two
      // tenants, and the thing that has to be unique is the *user* record I2 introduces — the
      // credential — not a contact address. Refusing a duplicate here would also tell an
      // anonymous caller which addresses are already customers.
      contactEmail: input.contactEmail,
      // D-052: a live key waits for this to be set. Nothing in this phase sets it — the
      // verification flow belongs to I2, which owns the credential store the email proves — so
      // a self-signed-up tenant has sandbox today and live once that lands. Deliberate: with no
      // per-tenant live budget yet, one unverified tenant can spend the SEC's whole hour.
      emailVerifiedAt: null,
      createdAt: now.toISOString(),
      mode,
    };

    let adminUser: SafeUser;

    try {
      adminUser = await this.transactions.run(
        async (session: ClientSession) => {
          await this.tenants.insertOne(tenant, { session });
          await this.entitlements.insertOne({ ...provisioned.entitlement, mode }, { session });
          await this.taxonomies.insertOne({ ...provisioned.taxonomy, mode }, { session });
          await this.policies.insertOne({ ...provisioned.policy, mode }, { session });

          // The administrator, in the same transaction as the tenant they administer (I2). A
          // tenant with no user is a tenant nobody can sign in to, and creating it in a second
          // call is creating something that can fail on its own.
          const user = await this.users.createInTransaction(
            {
              tenantId,
              email: input.contactEmail,
              password: input.password,
              // The tenant's first user administers it: they have to be able to issue the first
              // key and manage the ones after it. Narrower roles are theirs to hand out.
              roles: ['tenant_admin'],
              displayName: input.organisationName,
              now,
            },
            session,
          );

          // The tenant's first audit entry, sequence 1, inside the same transaction as the
          // records it describes. An audit entry that can fail separately from the action it
          // records is an action that can happen unrecorded.
          await this.audit.append(
            {
              tenantId,
              actor: { type: 'SYSTEM', subject: 'signup', clientId: null },
              action: 'tenant:signup',
              target: { type: 'TENANT', id: tenantId, version: INITIAL_VERSION },
              // SEC-05: the minimal permitted fact. The address is on the tenant record, which
              // has a retention policy; copying it into an append-only chain would not.
              reason: 'Self-service signup',
              correlationId: context.correlationId,
              result: 'ALLOWED',
              now,
            },
            session,
          );

          return user;
        },
        { name: 'tenancy.signup' },
      );
    } catch (error) {
      // The address is the sign-in identity, so it has to be unique — and signup is the one
      // route that cannot hide that fact, because it must answer with a tenant id. D-057 records
      // the trade and its mitigations: every *other* account route answers identically for a
      // known and an unknown address.
      if (error instanceof UserError && error.reason === 'EMAIL_TAKEN') {
        throw new SignupError(
          'EMAIL_TAKEN',
          error.message,
          'An account already exists for this email address. Sign in instead, or reset the ' +
            'password if it has been lost.',
        );
      }
      throw error;
    }

    this.logger.log(
      `Tenant ${tenantId} signed up (${input.organisationName}), admin ${adminUser.userId}.`,
    );

    const liveAccess = decideLiveAccess({ tenant, entitlement: provisioned.entitlement });

    // After the commit, never inside it. The transaction body may run more than once — that is
    // what the retry policy in `TransactionRunner` does on a write conflict — and an email sent
    // from inside it would be sent again on each attempt. Section 6.3 puts every side effect
    // outside the boundary for exactly this reason.
    const verification = await this.accounts.sendVerification(
      adminUser,
      input.organisationName,
      now,
    );

    return {
      tenantId,
      adminUserId: adminUser.userId,
      organisationName: tenant.name,
      contactEmail: input.contactEmail,
      createdAt: now.toISOString(),
      entitlement: {
        version: provisioned.entitlement.version,
        capabilities: [...provisioned.entitlement.capabilities],
        environments: [...provisioned.entitlement.environments],
      },
      taxonomyVersion: provisioned.taxonomy.version,
      policyVersion: provisioned.policy.version,
      liveAccess: {
        granted: liveAccess.granted,
        blockedBy: liveAccess.blockedBy,
        detail: liveAccess.detail,
      },
      verificationEmail: {
        sent: verification.sent,
        sentTo: input.contactEmail,
        detail: verification.detail,
      },
      nextSteps: [
        verification.sent
          ? 'Confirm the email address using the link just sent.'
          : 'Ask for the confirmation link again: POST /v1/signup/resend-verification.',
        'Issue a sandbox API key: POST /v1/tenant/api-keys. It works before the address is confirmed.',
        'A key secret is shown once, at creation, and cannot be recovered afterwards.',
        liveAccess.granted
          ? 'Live keys may be issued for this tenant now.'
          : 'A live key becomes available once the contact email address is confirmed.',
      ],
    };
  }

  /**
   * Count this origin's recent attempts, and refuse past the bound.
   *
   * The attempt is written **before** the check, so a caller whose signups keep failing is
   * counted too. Counting only successes would leave a loop that sends invalid bodies entirely
   * unbounded, which is the cheaper attack of the two.
   *
   * This is not inside the signup transaction. A row that vanished when a signup failed would
   * make the limiter forget exactly the attempts it exists to remember.
   */
  private async recordAttempt(context: SignupRequestContext, now: Date): Promise<void> {
    const originKey = this.originKey(context.ip);
    await this.attempts.insertOne({ originKey, at: now });

    const since = new Date(now.getTime() - SIGNUP_WINDOW_MS);
    const recent = await this.attempts.countDocuments({ originKey, at: { $gte: since } });

    if (recent > SIGNUP_MAX_PER_WINDOW) {
      throw new SignupError(
        'RATE_LIMITED',
        `${String(recent)} signup attempts from this address in the last hour.`,
      );
    }
  }

  private originKey(ip: string | undefined): string {
    return signupOriginKey(this.config.session.secret, ip);
  }
}

/**
 * The refusal a caller sees, from the reason signup stopped.
 *
 * Kept out of the service so the service stays free of HTTP, and kept in one place so the three
 * refusals cannot drift into three different shapes.
 */
export function signupRejectionToApiException(error: SignupError): ApiException {
  switch (error.rejection) {
    case 'RATE_LIMITED':
      // The only code in the contract marked retryable, and that is the correct promise here:
      // the same request, unchanged, succeeds once the window has passed.
      return new ApiException(
        'RATE_LIMITED',
        'Too many signups from this address. Try again later, or contact the provider if you ' +
          'need several tenants.',
        { internalDetail: error.message },
      );

    case 'WEAK_PASSWORD':
      // Says what was wrong. "Invalid password" with no reason is a form somebody submits four
      // more times before giving up, and the rule they broke is not a secret.
      return new ApiException(
        'VALIDATION_FAILED',
        error.publicDetail ?? 'That password cannot be used.',
        {
          internalDetail: error.message,
          // The path, never the value. A rejected password must not be echoed anywhere — not in
          // a response, not in a log, not in an error report somebody forwards.
          details: [{ path: 'password', message: error.publicDetail ?? 'Refused.' }],
        },
      );

    case 'EMAIL_TAKEN':
      return new ApiException(
        'EMAIL_ALREADY_REGISTERED',
        error.publicDetail ?? 'An account already exists for this email address.',
        { internalDetail: error.message },
      );
  }
}
