# Phase G — The control panel

**Gate:** G8 · **Status:** outline — expand before starting · **Prerequisite:** Phase F

> **Outline, not a brief.** Expand at the start of the phase.
>
> **Most of this phase happens in the `adverse-search-frontend` repository**, which has
> its own `CLAUDE.md`. Read that repository's README before starting.

## Goal

All twelve FR-14 pages against the real local API, with loading, empty, partial, error,
forbidden and retry states.

## Already built in the frontend

Toolchain, router, TanStack Query, and the hand-written API transport with BFF session, CSRF,
idempotency keys and typed errors that distinguish an entitlement denial from throttling, a
session expiry and a revision conflict.

`src/app/boundaries.test.ts` fails the build if domain logic is imported into the browser, if
anything but the API client calls `fetch`, if evidence is rendered as HTML, or if anything
writes to browser storage. Leave it in place; it is what keeps decision D-001 true as pages
land.

Every route currently renders a `NotImplemented` panel naming its gate and blocker. Replace
them page by page.

## The twelve pages

Sign-in and tenant selection · dashboard · new search · search progress · results · association
view · evidence detail · history and refresh comparison · source and taxonomy administration ·
client and webhook administration · audit and export · coverage matrix.

## The part that is easy to get wrong

**Never fabricate percentage progress.** Search progress shows meaningful stage counts, the
cascade rung reached, and warnings.

**Coverage summary is independent of match count.** They are separate dimensions and the page
must never imply one from the other.

The no-match statement must render with scope, sources, versions, date, archive horizon and
coverage state in **every** path that can produce it. The words "clear", "clean" and "no
adverse media" are never produced.

Stage display rules survive into the UI: "alleged" appears on every surface for a stage 1
finding, a settlement is never rendered as an admission, a civil claim never as a criminal
matter.

## Exit evidence

T50 to T52 pass. A human can configure scope, run, review, refresh and export a complete search
locally without calling hidden admin endpoints by hand. WCAG 2.2 AA verified manually as well
as automatically, as each role and both tenants.

## Decision to close

**D11 — whether procedural stage and outcome status render at the same visual weight as the
band.**

Recommendation on file: yes. A well-evidenced acquittal correctly bands `CORROBORATED`, because
the band states how well the evidence supports the connection and what is corroborated is an
acquittal. A reviewer scanning a results list quickly could misread that as confirmed adverse —
reintroducing at the presentation layer exactly the unfairness invariant I7 exists to prevent.

Cannot be deferred past the results page. Reasoning in `docs/decisions.md` D-008.
