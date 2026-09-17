# Phase I — Tenant self-service onboarding

**Status: I4, I1, I2 and I3 built, 2026-09-16. I5 and I6 are the remainder.** Written 2026-09-16, and the
three decisions it raised (D-051, D-052, D-053) are now all closed — see section 7.

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

### I1 — Tenant creation as an API, not a seed — **BUILT 2026-09-16**

Implemented as `POST /v1/signup`, with **D-055** (live access is a value on the tenant record,
not a condition in the issuing route) and **D-056** (signup is bounded per client address).

What was built, beyond what this section asked for:

- `buildTenantProvisioning` is the **one** definition of what a tenant is made of, and
  `scripts/bootstrap/seed-data.mjs` now imports it. The seed file no longer carries its own copy
  of the seventeen categories, the country list, the languages or the policy defaults, so the
  local stack cannot drift from what a real customer is provisioned with.
- `decideLiveAccess(tenant, entitlement)` is the only thing that decides whether a tenant may hold
  a live credential. Key issuance calls it; the signup response reports what it said. **A missing
  flag means allowed**, so the gate does not take live access away from tenants a person
  onboarded before the field existed.
- All four records carry `mode` (T55), not just the tenant.
- Fourteen tests in `tests/security/signup.test.ts` and thirteen in
  `apps/api/test/tenant-provisioning.test.ts`. Both load-bearing claims were proven by planting
  the violation: dropping the `decideLiveAccess` check makes the live-gate test fail, and writing
  the four records outside the session makes the rollback test fail.

**What I1 deliberately does not do.** It issues no credential and creates no user — that is I2 and
I3 — so a tenant that signs itself up still needs its first key from `pnpm key:issue`. And
**nothing yet sets `emailVerifiedAt`**, so a self-signed-up tenant cannot obtain a live key at
all until the verification flow lands with I2. That ordering is deliberate: with no per-tenant
live budget (D-052), one unverified tenant can spend the SEC's whole hour.

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

### I2 — Where the password lives — **BUILT 2026-09-16**

**Decided 2026-09-16: our own store, in our database. D-051 is closed, against the
recommendation below.**

Built as `apps/api/src/auth/password.ts` (argon2id and the policy), `user.service.ts` (the
records) and `account.service.ts` (what a customer experiences), with **D-057** (signup says an
address is taken; every other account route says nothing) and **D-058** (no mail transport is
configured, and production refuses to start rather than pretend).

What exists now:

- **Signup takes a password and creates the tenant's administrator in the same transaction** as
  the four tenant records. argon2id at OWASP's floor, parameters written out rather than
  inherited from a library default that a lock-file update could change.
- **The policy is length plus a known-bad list**, not composition rules — and it refuses a
  password containing the email address or the organisation name, which are the two strings an
  attacker holding a customer list already has. `P@ssw0rd-1234` is refused; the candidate folding
  that catches it is order-dependent and commented.
- **`POST /v1/signup/verify` sets `tenants.emailVerifiedAt`**, which is the value `decideLiveAccess`
  reads — so confirming the address is literally the moment a live key becomes issuable (D-052,
  D-055), and the response says so.
- **Single-use, expiring, hashed tokens.** Issuing a new one spends the old one. Every refusal —
  unknown, expired, spent, wrong purpose — is the same message.
- **Lockout**: ten wrong passwords, fifteen minutes, cleared by a successful sign-in or a reset.
  Temporary on purpose: a permanent lock is a denial of service anybody can trigger against a
  named customer.
- **Password reset ends every session that user holds**, and says how many.
- **An unconfirmed address still signs in.** D-052 gates the live key, not the account — signup
  promises sandbox works immediately, and a customer who cannot sign in until an email arrives
  cannot use what they were promised.

**Not in I2, and named rather than discovered:** _changing_ a password while signed in (it needs
I3's session identity; reset-by-email is the interim route), and **MFA**, which D-051 makes ours
to build and which nothing here pretends exists.

What that buys the estimate for this step: password reset, lockout and rate limiting on failed
attempts, rotation, MFA if it is ever wanted, and breach response for a credential store that now
exists. None of that is hard; all of it is work that has to be named rather than discovered.

**Passwords are stored as argon2id hashes, not encrypted.** The instruction said "encrypted", and
encryption is reversible — anything that can decrypt a password can produce it, and a store the
provider can read back is a store the provider can leak. That is the same reason API key secrets
are hashed here. Argon2id is the one-way version of the same intent, and the slow memory-hard hash
is right for low-entropy human input in a way it is not for a 32-byte random API secret.

The recommendation that was not taken, kept because the reasoning still describes what we now own:

**Recommendation was Keycloak, not us.**

This service has never stored a password. Human identity is OIDC end to end: `auth.controller.ts`
reads roles from `realm_access.roles` on a verified token, and the control panel holds no secrets
at all. Signup should create the user **in Keycloak** through its admin API and never see the
password.

The alternative — our own password store — means owning password reset, lockout, rotation, MFA
and breach response in a service whose entire security story is currently "we do not hold
credentials". That is a large new surface for a feature that is not our product.

**Recorded as open decision D-051.** It is genuinely a decision: self-hosting Keycloak for
customer identity has its own operational cost, and someone should say yes deliberately.

### I3 — Login and session — **BUILT 2026-09-16**

Implemented as **D-059**. `POST /v1/auth/login` takes an email address and a password and returns
a session token, presented afterwards as `Authorization: Session <token>`; `POST /v1/auth/logout`
ends it. Both were built on the second of the two options below — a token-returning login for API
consumers — but **without** becoming a second authentication system:

- the session is created by the **same `SessionService`** as the panel's cookie, with the same
  idle and absolute expiry, resolved by the same branch of `AuthGuard`, revoked by the same call;
- it gets **its own `Authorization` scheme**, for the reason `ApiKey` has one: a session token is
  never fed to the JWT verifier, and a rejection can still say which credential was meant;
- **every failure is one `401` with one sentence** — the four values `authenticate` returns are
  for the audit trail and the lockout counter, never for whoever is trying passwords;
- the session's **environment is derived** from `decideLiveAccess`, not requested, so an
  unconfirmed tenant signs into sandbox and confirming the address raises the next session to
  live;
- sign-in attempts are **bounded per origin** as well as per account. The limiter signup grew in
  I1 is now shared (`common/attempt-limiter.ts`, two buckets), because argon2id costs 19 MiB per
  attempt by design and an unbounded login route spends that with nothing but a socket.

**What this completes.** Signup → confirm → sign in → issue your own key now runs end to end with
nobody at Erly involved. There is a test that does exactly that.

`POST /auth/login` exists as an OIDC redirect for the panel. Machine-driven signup needs a session
the customer's own backend can obtain and use. Either:

- **reuse the existing session cookie flow** and document it for programmatic use, or
- **add a token-returning login** for API consumers.

The second is likelier to be what an integrator expects. It must not become a second
authentication system: one verifier, one session store, one set of rules.

### I4 — Enable and disable, distinct from revoke — **BUILT 2026-09-16**

Implemented as **D-054**. `POST /v1/tenant/api-keys/{keyId}/disable` and `.../enable` move a
reversible `disabledAt`; `DELETE` still sets the one-way `revokedAt`. `verify()` refuses a
disabled key exactly as it refuses a revoked one, the listing reports `DISABLED` as its own
status, and both events are audited with an actor and a mandatory reason. A revoked key answers
`409 ALREADY_TERMINAL` on both routes rather than coming back to life; a disabled key can still be
revoked, and can be rotated without being turned back on. Fifteen tests in
`tests/security/api-keys.test.ts`, and the two obvious ways to break it — dropping the `verify()`
check, and letting `enable` clear `revokedAt` — were each planted and watched to fail.

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

### The live path the phase was gating — **PROVEN 2026-09-17**

Not one of I1–I6, but the reason the phase mattered. A tenant created by `POST /v1/signup`, holding
**its own live key**, ran a real SEC-backed adverse search against the local stack and retrieved a
terminal result:

```
tenant      tenant-6a39fca2-f6a2-4068-8c18-3952b544aad4, created 2026-09-17T09:09:22.910Z
search      de734e90-4ded-4e05-b187-d5b9b0345571, environment live
            SUCCEEDED / NO_MATCHES_FOUND / INCOMPLETE, rung 6 reached
source      sec-litigation-releases at rung 1, COMPLETED, 1 candidate. No fixture source
            appears anywhere in the run's outcomes.
requests    1 to the feed URL; 3 against the source budget for the whole run.
```

`SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live` (`tests/live/sec-live-e2e.test.ts`) re-runs it.
Nothing else does: no default suite names the `live` project, and the suite refuses without that
variable. `pnpm sec:live-smoke --yes-contact-the-sec` is the cheaper first check — one request,
counted.

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
   _whole service_, and nothing bounds how many searches one tenant runs in an hour.
3. **Every first-contact approval was given on an assumption about use** that open signup
   changes.

**The instruction is to allow both sandbox and live from day one, and this plan does that.**

**Decided 2026-09-16 (D-052):** one of the two proposed mitigations is in.

- **Email verification before a live key — yes.** Sandbox immediately, live once the address is
  confirmed. Costs a real customer one click.
- **A per-tenant live budget — not in this phase.**

**So consequence 2 above is unmitigated.** It was written as though the fixed-feed fetch were the
cause — "one search spends about 41 of the SEC's 120 hourly requests". **Corrected 2026-09-17:
that figure was never measured and was wrong.** A search costs **one** poll of the feed (plus
`robots.txt` on a cold process and one fetch per candidate document); the fixed-feed work landed on
2026-09-17 and is in `apps/api/src/sources/feed-poll-cache.ts`, with
`apps/api/test/fixed-feed-amplification.test.ts` holding the line.

What is still unmitigated is the thing the fetch path cannot fix: **nothing bounds how many
searches one self-signed-up tenant runs**. The per-tenant live budget D-052 deferred is the
mitigation, and it belongs to production readiness rather than to this phase.

---

## 4. Order of work

| #   | Step                                          | Why here                                                              |
| :-- | :-------------------------------------------- | :-------------------------------------------------------------------- |
| 1   | ~~**I4** disable/enable~~ **done**            | Smallest, self-contained, valuable on its own. Warms up the key model |
| 2   | ~~**I1** tenant creation~~ **done**           | The core. Everything else needs a tenant to exist                     |
| 3   | ~~**I2** user creation~~ **done**             | D-051 closed: our database, argon2id hashes                           |
| 4   | ~~**I3** login returning a session~~ **done** | Needs I2                                                              |
| 5   | **I5/I6** both keys, one response             | Mostly assembly once the above stand                                  |
| 6   | Per-tenant live budget                        | The D-052 mitigation                                                  |

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
Held by the strict schema — there is no field — and tested both through the route and against the
generated id's shape.

---

## 6. Deliberately not in this phase

- **Metering and billing.** Still D-007. This phase issues credentials; it does not sell them.
- **Plan tiers.** Everyone gets the same entitlement at signup.
- **Payment before live.** The user's instruction is explicit: both keys now, gating later.
- **Removing `pnpm key:issue`.** It stays as the break-glass path for a tenant locked out of its
  own account.

---

## 7. Open decisions this phase raises

All three were closed on 2026-09-16. Full records in [`../decisions.md`](../decisions.md).

| ID        | Decision                     | Closed as                                                                          |
| :-------- | :--------------------------- | :--------------------------------------------------------------------------------- |
| **D-051** | Where the password lives     | **Our own database**, argon2id hashes. Not Keycloak, and not reversible encryption |
| **D-052** | Verification and live budget | **Email verification before a live key.** No per-tenant budget in this phase       |
| **D-053** | Open signup or invite-only   | **Open**, no invite code, both key kinds from day one                              |

**What I1 has to do so the later gate is not a retrofit.** Payment and live-key approval are
deliberately later. The expensive part of adding them afterwards is not the check — it is adding
it around tenants that already exist with live keys issued under no gate. So live-key issuance
reads its answer from tenant state (the entitlement, the verification flag) rather than being
unconditional in the route. Turning the gate on later is then writing a different value into that
state, not finding every tenant created while there was none.
