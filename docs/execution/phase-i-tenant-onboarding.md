# Phase I — Tenant self-service onboarding

**Status: planned, not started.** Written 2026-09-16 to be executed in a following session.

Today a tenant is created by editing `scripts/bootstrap/seed-data.mjs` and re-running the
bootstrap. That is provisioning by redeploy, and it is not an onboarding process.

This phase replaces it: a customer signs up through the API, sets a password, logs in, and issues
their own sandbox and live keys without anyone at Erly being involved.

---

## 1. The target flow

```
  1. POST /v1/signup            → tenant + admin user created, verification email sent
  2. (verify email)             → tenant becomes usable
  3. POST /auth/login           → session token
  4. POST /v1/tenant/api-keys   → sandbox key, and live key, both immediately active
  5. POST .../{id}/disable      → reversible off switch
  6. POST .../{id}/enable       → back on
  7. DELETE .../{id}            → permanent, for a leaked key
```

Steps 4–7 largely exist (D-050). **Steps 1–3 are the new work**, plus splitting "off" from
"destroyed" in step 5.

---

## 2. What has to be built

### I1 — Tenant creation as an API, not a seed

`POST /v1/signup` creates, **in one transaction**, the four records `local-bootstrap` writes today:

| Record                      | Holds                                      |
| :-------------------------- | :----------------------------------------- |
| `tenants`                   | The tenant                                 |
| `tenantEntitlementVersions` | Capabilities and environments they may use |
| `taxonomyVersions`          | Which categories are enabled, per country  |
| `policyVersions`            | Retention and handling                     |

All four or none. A tenant missing its taxonomy is one whose searches fail later with something
that reads like a bug in search rather than a half-finished signup.

**`local-bootstrap` keeps seeding `tenant-alpha` and `tenant-beta`** — the test suites reason
about them, and taking them away to prove a point would cost a day of unrelated breakage. What it
stops being is the _only_ way.

### I2 — Where the password lives

**Recommendation: Keycloak, not us.**

This service has never stored a password. Human identity is OIDC end to end: `auth.controller.ts`
reads roles from `realm_access.roles` on a verified token, and the control panel holds no secrets
at all. Signup should create the user **in Keycloak** through its admin API and never see the
password.

The alternative — our own password store — means owning password reset, lockout, rotation, MFA
and breach response in a service whose entire security story is currently "we do not hold
credentials". That is a large new surface for a feature that is not our product.

**Recorded as open decision D-051.** It is genuinely a decision: self-hosting Keycloak for
customer identity has its own operational cost, and someone should say yes deliberately.

### I3 — Login and session

`POST /auth/login` exists as an OIDC redirect for the panel. Machine-driven signup needs a session
the customer's own backend can obtain and use. Either:

- **reuse the existing session cookie flow** and document it for programmatic use, or
- **add a token-returning login** for API consumers.

The second is likelier to be what an integrator expects. It must not become a second
authentication system: one verifier, one session store, one set of rules.

### I4 — Enable and disable, distinct from revoke

Today `revokedAt` is one-way, and deliberately so: a leaked key must be permanently killable.

Add `disabledAt` as a **separate, reversible** state:

| Action  | Field        | Reversible | For                              |
| :------ | :----------- | :--------- | :------------------------------- |
| Disable | `disabledAt` | Yes        | Pausing an integration, rotation |
| Enable  | `disabledAt` | —          | Turning it back on               |
| Revoke  | `revokedAt`  | **No**     | A leaked or compromised secret   |

**Do not conflate them.** If disable and revoke are the same field, then either a leaked key can
be switched back on, or a routine pause is irreversible. Both are bad, in opposite directions.

`verify()` must refuse a disabled key exactly as it refuses a revoked one, and the listing must
show which it is.

### I5 — Sandbox and live keys side by side

Already true: a key is bound to one environment and cannot be promoted. What changes is that a
self-signed-up tenant may create **both**, which today requires an entitlement granting `live`.

So signup grants `environments: ['sandbox', 'live']`.

### I6 — Response shape

The user gets everything back in one response and stores it:

- tenant id
- admin user id
- both keys, **each secret shown once**
- what each key can do

Nothing in that response is recoverable afterwards, and it must say so in the body, not only in
the docs.

---

## 3. The thing to decide before writing code

**A self-signed-up tenant with a live key drives real traffic to real publishers under our
identity.**

Live mode sends requests with **our** contact URL in the user agent, to sources **we** had
approved by a named person, against a rate budget **shared across all tenants**. Today the only
people who can do that are ones we onboarded by hand.

After this phase, anyone with an email address can. Three consequences worth stating plainly:

1. **A publisher's complaint arrives at us**, not at the tenant, because it is our user agent in
   their logs.
2. **One tenant can exhaust a shared budget.** The SEC's free tier is 120 requests an hour for the
   _whole service_, and a single search currently spends about 41 of them.
3. **Every first-contact approval was given on an assumption about use** that open signup
   changes.

**The instruction is to allow both sandbox and live from day one, and this plan does that.** But
it should carry two cheap mitigations, neither of which blocks a legitimate customer:

- **Email verification before a live key** — sandbox immediately, live after the address is
  confirmed. Costs a real customer one click.
- **A per-tenant live budget** under the shared source budget, so one tenant cannot spend the
  whole hour.

Recorded as **D-052**. Not a blocker; a thing to say yes to on purpose.

---

## 4. Order of work

| #   | Step                                      | Why here                                                              |
| :-- | :---------------------------------------- | :-------------------------------------------------------------------- |
| 1   | **I4** disable/enable                     | Smallest, self-contained, valuable on its own. Warms up the key model |
| 2   | **I1** tenant creation in one transaction | The core. Everything else needs a tenant to exist                     |
| 3   | **I2** Keycloak user creation             | Blocked on D-051                                                      |
| 4   | **I3** login returning a session          | Needs I2                                                              |
| 5   | **I5/I6** both keys, one response         | Mostly assembly once the above stand                                  |
| 6   | Per-tenant live budget                    | The D-052 mitigation                                                  |

**I4 first is deliberate.** It is independently useful, ships without any of the signup
machinery, and proves the key-state changes before anything depends on them.

---

## 5. What must stay true

Existing properties this phase must not quietly break — each has a test today:

- A key carries only roles the caller already holds
- The tenant comes from the credential, never the body
- A secret is returned once and is not recoverable
- A sandbox credential cannot reach live
- Customers cannot see each other's work
- Creation, disabling and revocation are all audited with an actor

Signup adds one more: **a new tenant must not be able to name its own tenant id.** An
attacker-chosen id is how a signup ends up colliding with, or impersonating, an existing tenant.

---

## 6. Deliberately not in this phase

- **Metering and billing.** Still D-007. This phase issues credentials; it does not sell them.
- **Plan tiers.** Everyone gets the same entitlement at signup.
- **Payment before live.** The user's instruction is explicit: both keys now, gating later.
- **Removing `pnpm key:issue`.** It stays as the break-glass path for a tenant locked out of its
  own account.

---

## 7. Open decisions this phase raises

| ID        | Decision                                                                | Owner                 |
| :-------- | :---------------------------------------------------------------------- | :-------------------- |
| **D-051** | Keycloak for customer identity, or our own password store               | Engineering + product |
| **D-052** | Whether live access needs email verification, and the mitigations above | Product + compliance  |
| **D-053** | Whether signup is open to anyone, or invite-only at first               | Product               |

D-053 is worth ten minutes before I1 is written. "Open to anyone" and "invite-only" produce the
same endpoint with a different check, but they produce very different abuse surfaces, and
retrofitting the check after launch means retrofitting it around tenants that already exist.
