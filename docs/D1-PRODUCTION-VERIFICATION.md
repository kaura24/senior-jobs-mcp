# D1 production verification — 2026-11-14

## Deployed targets

- Existing Vercel project: `senior-jobs-poc-mcp` (`prj_5r5fRoQPxE0Xo1VGNwY8BNyBW4FK`).
- Existing public MCP: `https://senior-jobs-poc-mcp.vercel.app/api/mcp`.
- Final Production deployment: `dpl_68FNUD2hSuEQ735cywDqgQcJ14Ct`, READY.
- Deployment URL: `https://senior-jobs-poc-eouiipqvh-kaura24-7661s-projects.vercel.app`.
- Runtime source commit: `c891d228e99e57faa51b3a0ace0ece592a48f208`, branch `codex/d1-migration-20261114`.
- Worker: `https://senior-jobs-mcp-storage.kaura24.workers.dev`, version `a7dc08f3-76fc-4f45-92a3-72f448514789`.
- Only binding: D1 `senior-jobs-mcp`, ID `8df2c092-4e5a-4eb6-a3a2-2e5dd97d5125`.
- Existing Cron: `/api/refresh`, `0 21 * * *` UTC (06:00 KST), active and pointed at the final deployment.

Production was staged without domain assignment, checked with existing browser authentication, and then promoted. Public MCP and the connected MCP tool returned actual D1 data. No protection-bypass credential was created.

## Initial source baseline

The real Production Cron dispatched the existing private Queue. Its workers finished 277/277 official public regions and 286 successful page calls. Completion: 2026-11-14 19:36:29 KST (`2026-11-14T10:36:29.401Z`). Run: `f151fd87-b962-44e9-af7a-6edfa051bc75`.

- Source rows: 879.
- Duplicate observations: 158.
- Ineligible rows excluded: 3.
- Final unique active postings: 718.
- New jobs: 0; content updates: 0; failed records: 0.
- Unchanged observations: 876, including duplicates.
- D1 readback: 718 stored jobs, 718 distinct IDs, 718 active IDs, 874 archived source versions.

The first 12-second release exhausted five retries at a slow source region while retaining its cursor. A direct official-source request took 14.5 seconds. The corrected 30-second release resumed that cursor, passed the region and completed the baseline. The final run's failed-record count is zero; it does not mean that no earlier request timed out.

Coverage is the official public region lookup and A/C/B/E filters, not every Korean job board or every historical SenuriService record. Blob recovery was not attempted.

## Final scheduled policy and live verification

As the user instructed, no new daily national source scan is started. Until a verified source-date change feed exists, the existing daily Cron performs local expiry only. See [D1-SYNC-POLICY.md](D1-SYNC-POLICY.md).

Live Cron/Queue maintenance completed at 2026-11-14 19:46:39 KST. D1 recorded `sourceRequests: 0`, `expiredFromActive: 0`, `activeJobs: 718`, `automaticFullScan: false`, `automaticSourceRequests: false`, and `sourceWatermark: null`. The original source observation time and 286 source page-call counter were unchanged.

The raw jobs hash remained `b680d3a6d0b7f05321f4255ea75a77e948c55abf86ab72b164a4ad4c70be8fa2`. The maintenance snapshot hash was `eac9ffd6dffbb8a03f0d97b6843838f79ea6e7cd121160413707a1df3360d610`.

A second real Cron invocation at 19:48 KST reached the same Queue worker and returned `already_completed`. D1 revision `92f56908-ec02-4bd5-b77a-0ea047423c4c`, snapshot hash, raw jobs hash and source call count were all unchanged.

The connected MCP tool returned `snapshotOrigin: d1`, 718 matches and `local_maintenance_completed`, together with the disabled-source-collection policy. Per-job `lastCheckedAt` remained the actual source observation time. Unavailable source creation/modification and legacy content-change times remain null; maintenance does not fabricate or advance them.

## Checks and limits

153 local tests passed. They include signed OIDC authentication failures, preview/other-project rejection, fixed operations, forbidden SQL, write/readback, stale-writer and deletion prevention, source failure recovery, duplicate processing, zero-source maintenance and timestamp preservation. Live Worker unauthenticated requests returned 401. Live MCP options/search/details and real Cron/Queue writes were verified separately.

The account's Workers Free plan was observed before deployment. No paid plan change, long-lived Cloudflare API token, other database/project change, existing-data deletion or GitHub main update was performed. The user approved the minimal Worker deployment OAuth scope; the existing local credentials remain local.

Date-based automatic source ingestion is deliberately pending: the current public listing lacks a verified modified-since query. The separate official API documents detail `createDy`/`updDy`, but that alone is not a change-list contract. Early closures, new jobs and edits will not be discovered automatically until such a feed is verified and connected. Local expiry remains automatic.
