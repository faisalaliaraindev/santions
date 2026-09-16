# SEC go-live Postman steps

This is the operator checklist for folder **11 - SEC go-live (four eyes)** in
`erly-adverse-search-full.postman_collection.json`.

Do not paste real API keys into committed files. Use
`postman/local.ready.postman_environment.json`; it is ignored by git.

## Current local state

This database already has `sec-litigation-releases` version 5 at `ACTIVE`.
The go-live folder now fails fast on step 1 when it sees that state, so it will not send another
approval or activation by accident.

For a clean database, version 5 should be `AWAITING_APPROVAL`, `revision: 2`, and
`content.robotsPosition: HONOURED`.

## Environment variables

Set these before running folder 11:

| Variable       | Purpose                                                 |
| :------------- | :------------------------------------------------------ |
| `apiKey`       | Normal collection key. It is not used by folder 11.     |
| `proposerKey`  | Key that proposed version 5. Kept for traceability.     |
| `approverKey`  | The second-person `source_admin` key used by folder 11. |
| `approverName` | Real approver name. Must not be `CHANGE ME`.            |
| `approverRole` | Real approver role. Must not be `CHANGE ME`.            |
| `secVersion`   | `5` for this go-live attempt.                           |
| `secRevision`  | Starts as `2`; step 1 refreshes it from the API.        |

Folder 11 disables inherited collection auth and sends `Authorization: ApiKey {{approverKey}}`
itself. That matters: the collection-level `apiKey` may be a smoke key and must not satisfy the
four-eyes approval.

## API sequence

| Step | Request                                                                                                          | What it completes                                                                                                                            |
| :--- | :--------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `GET /v1/admin/sources/sec-litigation-releases/versions/{{secVersion}}`                                          | Confirms the version is still awaiting approval, has `robotsPosition: HONOURED`, and captures the latest revision into `secRevision`.        |
| 2    | `POST /v1/admin/sources/sec-litigation-releases/versions/{{secVersion}}/transitions` with `{"action":"APPROVE"}` | The four-eyes approval. This must be run by the second person holding `approverKey`, with their real name and role in the reason.            |
| 3    | `POST /v1/admin/sources/sec-litigation-releases/versions/{{secVersion}}/activate`                                | Runs the SEC-05 rights gate. If allowed, the version becomes `ACTIVE`; if refused, it returns the clearance and leaves the version readable. |
| 4    | `GET /v1/admin/sources/sec-litigation-releases/versions/{{secVersion}}`                                          | Confirms the version is `ACTIVE`. Only then can live mode fetch the SEC feed.                                                                |

After activation, run live mode with `pnpm dev:live`. A live search only proves the feed can be
polled and matched locally; it does not prove recall. The extractor is still rule-based and
unbenchmarked.

## Cleanup

Versions 1-4 are stale `AWAITING_APPROVAL` drafts with `robotsPosition: NOT_ESTABLISHED`. Do not
approve them. Clear them with `REQUEST_CHANGES` if you want the admin list tidy.
