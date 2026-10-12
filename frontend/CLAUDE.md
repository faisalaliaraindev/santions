# Adverse-search control panel

React control panel for the Adverse Search Service service. The backend lives in the sibling
repository `erly-sanction-service-backend`.

## If you are starting a fresh session

The **backend repository holds the plan**. Read
`../erly-sanction-service-backend/docs/execution/START-HERE.md` to find the active phase.

Most phases do not touch this repository at all. The panel's work is **Phase G (gate G8)**, and
it is blocked until the API exists. If the active phase is not G, you are probably in the wrong
repository.

## Status

Foundation only. **None of the twelve FR-14 pages is built, deliberately** — the plan forbids
mock screens and the API does not exist yet. Every route renders a `NotImplemented` panel
naming its gate and blocker.

What is built: the toolchain, the hand-written API transport, the generated API client, and the
boundary tests.

## The rule this repository exists to enforce

**Decision D-001: there is no second matching engine in the browser.**

Banding, identity resolution, procedural-stage logic and clustering live in the backend's
`packages/domain` and reach this code only as API responses. Across two repositories that is
not enforced by a shared build, so it is enforced twice here:

- a `no-restricted-imports` lint rule in `eslint.config.mjs`;
- `src/app/boundaries.test.ts`, which walks the source tree and fails the build if any file
  imports the domain packages, if anything other than `src/lib/api/client.ts` calls `fetch`, if
  evidence is rendered with `dangerouslySetInnerHTML`, or if anything writes to `localStorage`
  or `sessionStorage`.

Do not weaken either. If a page seems to need domain logic, it needs an API field instead.

## Conventions

- `src/lib/api/client.ts` — transport, BFF session, CSRF, idempotency, error typing — stays
  **hand-written**. Only operations and types under `src/lib/api/generated/` are generated from
  the backend's OpenAPI document, and they are committed. Regenerate with `pnpm api:generate`,
  which reads `../erly-sanction-service-backend/openapi/openapi.json`; never hand-edit the
  output. Business routes go through the transport's `/v1` prefix, and the version-neutral
  auth and health routes pass an empty `basePath`.
- No bearer token ever reaches the browser. Authentication is a backend-for-frontend session
  cookie; `src/lib/api/client.test.ts` asserts it.
- Mutations never auto-retry. Review actions carry idempotency keys and expected revisions.
- Never fabricate percentage progress. Never imply coverage state from match count.
- WCAG 2.2 AA for implemented journeys. The focus ring in `global.css` is not removable.

## Commands

```
pnpm dev          # http://localhost:5173, proxies /v1 and /auth to the API
pnpm lint / typecheck
pnpm test:unit    # 35 tests, includes the boundary and generated-client tests
pnpm build
pnpm test:e2e     # not implemented (G8) — exits non-zero
pnpm api:generate # regenerate src/lib/api/generated/ from the backend OpenAPI document
```
