# Source-date incremental policy

The initial national public-region baseline completed on 2026-11-14. Its 277 regions returned 879 rows: 158 duplicate observations and 3 ineligible rows, leaving 718 unique active postings. The operating pipeline reported 0 new jobs, 0 content updates and 0 failed records; the 876 unchanged observations include duplicates. This is a one-time baseline, not the daily refresh policy.

Completion was 2026-11-14 19:36:29 KST (`2026-11-14T10:36:29.401Z`), run `f151fd87-b962-44e9-af7a-6edfa051bc75`, with 286 successful source page calls. D1 readback returned 718 rows, 718 unique IDs and 718 active IDs. Source evidence retains 874 observed versions. The completed baseline snapshot hash was `31fefae5c18b2a870a39ade0a027e40f8f2a1244260c9b0767f0c5dcab7a19a0`.

## Daily schedule

Vercel Cron calls `/api/refresh` daily at `0 21 * * *` UTC. Scheduled maintenance updates D1 from the existing snapshot. It can resume a manual source collection already started on the same KST day.

Maintenance removes expired or otherwise ineligible IDs from the active scope using inclusive KST application dates and raw accepting status. It preserves original rows, source observation times and the last successful source scan time. Duplicate same-day deliveries leave the snapshot unchanged. Preserved historical rows are not automatically reactivated.

## Manual source refresh

Send `GET /api/refresh` without an Authorization header to start or resume the official public-region collection. The response reports queue acceptance. Check MCP `observedAt`, `referenceDayKst` and refresh state to verify publication and completion. The worker advances source observation time after a successful page, keeps prior eligible postings available during collection, and narrows the active scope to source-verified IDs when collection completes.

## Required upstream contract

The intended incremental contract is a verified source filter for records created or modified after the last successful watermark. A small overlap handles delayed delivery. ID plus content hash eliminates repeated observations. The watermark advances only after every required page is committed and read back; partial failure never advances it.

The current public regional listing exposes application and posting-period dates, but no source modification timestamp or verified modified-since filter. Its official sorting options are application start, application end, accepting only and all records; these are not modification order. The separate official SenuriService documentation lists `createDy` and `updDy` on details, but a source-date change-list filter has not been verified. The metadata catalog's own modification date is not a job modification date. Do not invent a date parameter, infer modification time from registration/application dates, or describe a partial rescan as complete incremental detection.

Until a source change-list contract is verified, `syncPolicy.mode` is `awaiting_verified_change_feed`, `automaticSourceRequests` and `automaticFullScan` are false, and `sourceWatermark` is null. New jobs, early closures and source edits will not be detected automatically in this mode. The MCP exposes the actual last source check and stale-source state instead of claiming live revalidation. Connecting a verified change feed is required before automatic source ingestion resumes.

## Job timestamps

- `sourceCreatedAt` / `sourceUpdatedAt`: values supplied by a verified matching official source only; otherwise null.
- `firstObservedAt`: first recorded source observation, or null for legacy rows without a verified first timestamp.
- `lastCheckedAt`: time this source record was actually observed. Local maintenance does not update it.
- `lastContentChangedAt`: application processing time stored when a new or changed normalized record is committed. Re-observing unchanged content preserves it. Unknown legacy change times remain null.
- `lastSuccessfulSourceScanAt`: actual successful source run, preserved during local maintenance.
- `lastLocalMaintenanceAt`: local expiry processing time; it is not a source update time.

The server uses rules and hashes, not a separate AI API. All writes and MCP reads continue to use the same project D1 through the Production-scoped OIDC Worker.

Official evidence: [current search page](https://www.seniorro.or.kr/noin/searchJob.do), [published search code](https://www.seniorro.or.kr/resources/js/noin/renewal/jobSearch.js), [official API schema](https://www.data.go.kr/data/15015153/openapi.do).
