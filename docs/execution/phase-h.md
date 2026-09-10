# Phase H — Integration, live sources and hardening

**Gates:** G9, G10, G11 · **Status:** outline — expand before starting · **Prerequisite:** Phase G

> **Outline, not a brief.** This phase is three gates. Expand each into its own brief at the
> start of that gate; do not attempt it as one unit.

---

## G9 — Zquence contract and external-client proof

Typed Node client and runnable machine-client examples. A callback fixture that verifies
signatures and handles replay, duplicates and out-of-order delivery. Tests for external subject
references, tenant grants, token revocation, sandbox and live keys, and entitlement denials.

Document how Zquence displays sanctions.io results and adverse-search results as **separate,
clearly labelled sections**. A designation reported in media is a lead to verify against the
primary list — never rendered as a sanctions hit.

Zquence-side work needs separate workspace access. Until it is granted, the client, receiver
fixture and contract tests live in this repository.

**Exit:** a local client submits, polls or receives notification, retrieves scoped evidence and
handles failure. A disabled capability is rejected as an entitlement issue. No Zquence database
dependency exists.

---

## G10 — Live free-source verification

**The first live calls this project has ever made.** Everything before this gate is capability.
This gate is measurement, and it is where the honest answer to "does this actually find things"
arrives.

- Obtain the small number of free API keys needed (company register, filings system), config
  outside source control, with honest identification in the user agent.
- Contract tests against each live source, recording real response shapes, rate-limit behaviour
  and block rates.
- **Measure and publish the archive horizon per source**, plus per-country and per-language
  coverage, officer completeness and truncation behaviour.
- **Measure end-to-end recall of the live free stack against the labelled dataset**, published
  per language and per jurisdiction. End-to-end means including discovery misses.
- Populate `docs/coverage-matrix.md`, which is currently an empty template by design.
- **Disable every profile without an agreed and measured threshold.**
- Confirm robots decisions and their named approvers for every enabled source.

Plan for the possibility that measured recall is lower than hoped in some languages. The
correct response is to disable those profiles and publish the figure. Not to relax the
threshold, and not to enable a language on an unmeasured assumption.

An unreachable source blocks only its own activation and the coverage claims that depend on it.
Never substitute mock success for a missing live test.

**Decision to close:** D2 — declared archive horizon per source, published on every result.

---

## G11 — Hardening, production verification and handoff

Security review and scans. Performance and fairness tests. Failure injection. Dependency and
**model-weight licence** checks — the model weights are an open-source licence question like
any other component.

Infrastructure code, isolated environment configuration, backups, alert rules and runbooks.

Under authorised staging access: real S3, IAM and KMS, OIDC, queue, search index and regional
boundaries. Local emulation is **not** evidence that cloud policies work. Demonstrate restore,
deletion replay including search-index restriction propagation, migration compatibility and
rollback.

Then: clean-checkout local verification again, API and UI demos of the same five scenarios
compared against each other, operator, developer and integrator documentation, and
`docs/readiness-report.md` marking the three readiness labels **independently** — local
verified, live source verified, production approved.

Confirm every open decision D1 to D12 is closed and recorded, or explicitly carried with a
named owner.

**Never report "production-ready"** while source permissions, country coverage, measured
recall, performance targets or production security checks remain unresolved.
