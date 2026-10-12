# Adverse-search control panel

The React control panel for the Adverse Search Service service. It is the human interface to
the service described in `erly-sanction-service-backend` — running searches, reviewing
findings, inspecting coverage, and administering sources and taxonomy.

## Status

**Foundation only. None of the FR-14 pages is built.**

That is deliberate. The plan requires the panel to be backed by the real service API and
explicitly forbids mock screens — and the API does not exist yet (gate G3 in the backend).
Building screens against hard-coded data now would produce something that demonstrates well
and proves nothing, and a screening panel showing plausible fabricated findings is worse than
one showing nothing at all.

So every route currently states what it will be, which gate delivers it, and what is blocking
it. What _is_ built is the part that can be built and verified today: the toolchain, the API
transport seam, and the architectural guardrails that keep the panel honest as pages land.

| Built and verified                                                | Not built                                 |
| :---------------------------------------------------------------- | :---------------------------------------- |
| Vite + React 18 + TypeScript strict, production build passing     | All twelve FR-14 pages                    |
| Routing shell and TanStack Query setup                            | Authentication and tenant selection       |
| API transport: BFF session, CSRF, idempotency keys, typed errors  | The generated API client (needs G3)       |
| Architectural boundary tests enforcing decision D-001             | Playwright end-to-end suite (G8)          |
| Accessibility lint (`jsx-a11y`), focus styles, semantic landmarks | WCAG 2.2 AA verification of real journeys |

## Getting started

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm dev          # http://localhost:5173, proxies /v1 and /auth to the API
pnpm lint
pnpm typecheck
pnpm test:unit    # 27 tests
pnpm build
```

`pnpm test:e2e` and `pnpm api:generate` exit non-zero — they are not implemented, and they
say so rather than passing vacuously.

## Architecture

### One route to the service

Decision **D-001** in the backend's `docs/decisions.md`: the panel and external integrators
invoke the same application services, and there is no second matching engine in the browser.
Banding, identity resolution, procedural-stage logic and clustering live in the backend's
`packages/domain` and reach this code only as API responses.

In a single monorepo a shared build makes that hard to violate by accident. Across two
repositories it would be only a convention — so it is enforced twice:

- **A lint rule** (`no-restricted-imports` in `eslint.config.mjs`) blocks importing
  `@adverse-search/domain`, `@adverse-search/evaluation`, or anything reaching into backend
  domain paths.
- **A test** (`src/app/boundaries.test.ts`) walks the source tree and fails the build if any
  file imports domain code, if anything other than `src/lib/api/client.ts` calls `fetch`, if
  evidence is rendered with `dangerouslySetInnerHTML`, or if anything writes to
  `localStorage` / `sessionStorage`.

That last group is not stylistic. Fetched publisher content and extraction-model output are
untrusted (SEC-04), and FR-14 forbids sensitive browser storage — session state belongs in
the backend-for-frontend session cookie.

### Authentication

OIDC authorisation-code flow with PKCE, terminated by a **backend-for-frontend session**
(section 4.2). Provider tokens stay server-side; the browser carries a secure, HTTP-only
cookie. Nothing bearer-shaped ever appears in the bundle, and `src/lib/api/client.test.ts`
asserts it.

State-changing requests carry a CSRF token echoed from a readable companion cookie.

### Error handling that distinguishes what matters

`ApiError` separates the cases whose operator response differs completely:

| Case                  | Why it must be distinct                                                                         |
| :-------------------- | :---------------------------------------------------------------------------------------------- |
| `isEntitlementDenial` | A capability not enabled for a tenant is **not** throttling and **not** a coverage gap (REL-02) |
| `isSessionExpired`    | Recoverable by re-authenticating, without losing work                                           |
| `isRevisionConflict`  | A reviewer acted on a stale revision (FR-12); needs a recovery path, never a silent retry       |

Retries follow the service's own `retryable` flag. Mutations never auto-retry: review actions
carry idempotency keys and expected revisions, and retrying one automatically is the caller's
decision.

## Layout

```
src/
  app/            Application shell, router, query client, boundary tests
  components/     Shared components
  routes/         FR-14 pages                        (not implemented — G8)
  lib/api/        Transport (hand-written) + generated client (needs G3)
  styles/         Base styles, focus and colour tokens
scripts/          Operator scripts
```

`src/lib/api/client.ts` — transport, session, CSRF, idempotency and error typing — stays
hand-written. Only the operation and type definitions under `src/lib/api/generated/` are
generated from the backend's OpenAPI document, and they are committed so a contract change
appears as a reviewable diff rather than a runtime surprise.

## Accessibility

FR-14 targets WCAG 2.2 AA for implemented journeys, tested manually as well as automatically:
semantic controls, keyboard navigation, visible focus, and statuses never conveyed by colour
alone. The focus ring in `src/styles/global.css` is deliberately not removable.

This is not yet verified against real journeys, because there are no real journeys — that is
part of gate G8.

## Related

The backend repository holds the authoritative status and documentation:

- `docs/implementation-status.md` — gate-by-gate status and known gaps
- `docs/architecture.md` — pipeline, trust boundaries, threat model
- `docs/decisions.md` — decision D-001 and the rest
- `docs/open-decisions.md` — including **D11**, which must close before the results page
  (FR-14 page 5) can be signed off: whether procedural stage and outcome status must render
  at the same visual weight as the evidence band
