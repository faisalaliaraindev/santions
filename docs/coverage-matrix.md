# Coverage matrix

Per-jurisdiction and per-language source coverage, measured recall and declared archive
horizon.

> **This document contains no measured figures.**
>
> It is a template. Every cell is populated at **G10 — live free-source verification**, by
> running contract tests against live endpoints and measuring end-to-end recall against the
> labelled dataset. No live source has been contacted.
>
> Per FR-03, a language is _enabled_ only when it carries a measured recall figure. No
> language currently carries one, so **no language is enabled**, and every run's coverage
> statement must say so. Per FR-05, "EU", "MENA" and "SEA" are never valid coverage entries —
> coverage is recorded per country.

## Source coverage

| Source            | Type | Tier | Countries | Languages | Access | Archive horizon | Availability | Block rate | Status |
| :---------------- | :--- | :--- | :-------- | :-------- | :----- | :-------------- | :----------- | :--------- | :----- |
| _(none measured)_ |      |      |           |           |        |                 |              |            |        |

## Per-language recall

Measured end-to-end recall on the held-out split, **including discovery misses**.

| Language          | Measured recall | Evaluation run | Enabled?            |
| :---------------- | :-------------- | :------------- | :------------------ |
| _(none measured)_ | —               | —              | **No — unmeasured** |

## Per-jurisdiction coverage

| Country           | Sources enabled | Officer data available | Rights approval | Status |
| :---------------- | :-------------- | :--------------------- | :-------------- | :----- |
| _(none approved)_ |                 |                        |                 |        |

## Candidate sources (from the plan, unverified)

Listed so the G10 work has a starting point. **Presence here is not approval, not a licence,
and not evidence that the endpoint behaves as documented.** Each requires its contract
verified, its rate limits measured, its robots position confirmed and its rights approval
recorded before activation.

### Primary (free, authoritative)

UK Companies House (free key) · SEC EDGAR (fair-use limits) · CourtListener (free) ·
prosecutor and law-enforcement newsroom feeds · financial and conduct regulator enforcement
registers · insolvency and gazette publications · development-bank debarment lists ·
public designation lists (**leads only**, never findings) · open structured knowledge bases

### Discovery (free, leads only)

Local index of polled publisher feeds · Google News RSS (**undocumented — requires a
scheduled contract test**, T84) · GDELT DOC 2.0 · Bing News RSS · self-hosted SearXNG ·
open web archives
