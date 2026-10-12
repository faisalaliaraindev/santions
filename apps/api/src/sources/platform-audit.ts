/**
 * The audit trail a **shared** record's events are written to.
 *
 * # Why a reserved tenant id rather than the actor's own
 *
 * The audit log is hash-chained per tenant, and every chain has to be complete to be worth
 * anything. Most events belong to a tenant naturally: a search, a subject, a taxonomy version.
 * Some do not. Source configuration is shared (§6.3), domain health is shared, and an automatic
 * halt produced by a recorded stop condition has **no actor and no tenant at all** — nobody
 * asked for it; a publisher refused a request and the service stopped.
 *
 * Writing such an event under whichever tenant's run happened to observe it would put a
 * cross-tenant fact into one customer's trail, where a second customer reading their own trail
 * would never see it, and where the first customer would see an event about a publisher they do
 * not own. Dropping it is worse: an automatic suspension with no audit entry is a service that
 * stopped calling a source and cannot say why.
 *
 * So shared records get their own chain, under a reserved id that is not a tenant and can never
 * be one. **D16** is the open decision about who may administer shared source configuration;
 * this does not decide it, and does not pre-empt it — it decides only where the events are
 * written, which D16 leaves untouched either way.
 */

/**
 * The reserved audit-trail id for cross-tenant records.
 *
 * Not a valid tenant id, deliberately: tenant ids in this service are issued and this one is
 * not, so a lookup by tenant can never collide with it.
 */
export const PLATFORM_AUDIT_TENANT_ID = '__platform__';

/** The actor recorded when the service itself acted, with no person behind it. */
export const SYSTEM_ACTOR = 'system';
