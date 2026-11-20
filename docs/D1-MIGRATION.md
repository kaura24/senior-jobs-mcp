# D1 migration

## Current result

The official public source has populated the dedicated D1 with 718 real current postings using the existing Wrangler connection. A fresh collection completed at 2026-11-14 10:09:31 KST: 277 regions, 718 unchanged postings, zero new/updated/failed imports. All 718 existing IDs were preserved and the snapshot hash was read back successfully. Blob recovery is not a prerequisite and must not be attempted under the user's final instruction.

## Prepared database

- Account: `0ae5b2a5dc0d07651d66b5e4db2b0d0c`
- Database: `senior-jobs-mcp`
- Database ID: `8df2c092-4e5a-4eb6-a3a2-2e5dd97d5125`
- Location hint: APAC; remote query served from NRT.
- CLI: Wrangler 4.162.0.
- Schema applied remotely: `migrations/0001_d1_storage.sql`.

`jobs` stores one source posting per row. `job_details` stores cached evidence. `storage_documents` stores snapshot metadata and the durable refresh checkpoint. SQL triggers publish a snapshot and its rows atomically. Revision checks prevent stale workers from overwriting newer data. Original snapshot hashes, source timestamps and cursor values remain intact.

## Official-source collection

Collect the free official source directly and merge into D1 without deleting existing IDs:

```sh
node scripts/collect-public-jobs.js /private/tmp/senior-jobs-UNIQUE.json
node scripts/import-public-d1.js /private/tmp/senior-jobs-UNIQUE.json /private/tmp/senior-jobs-import-UNIQUE
```

Choose unused paths. The importer archives source evidence, merges by official identifier, guards snapshot publication by revision and verifies D1 readback. See [D1-PUBLIC-RECOLLECTION.md](D1-PUBLIC-RECOLLECTION.md) for source coverage.

## Runtime configuration

Vercel Production requires:

- `CLOUDFLARE_ACCOUNT_ID` = the account above.
- `D1_DATABASE_ID` = the database above.
- `D1_WORKER_URL` = `https://senior-jobs-mcp-storage.kaura24.workers.dev`.

The refresh endpoint accepts requests without an Authorization header. The official public source accepts requests without an API key.

The deployed connection uses existing Vercel Production OIDC, verified by a Worker bound only to this D1. It needs no long-lived Cloudflare API token in Vercel. Do not copy a Wrangler OAuth access or refresh token into Vercel. See [D1-OIDC-BRIDGE.md](D1-OIDC-BRIDGE.md) for exact identity checks and the four allowed storage operations.

Both account and database must match this project's identifiers. `lib/runtime-store.js` is the only production storage factory; MCP, Cron and Queue use D1 exclusively. Missing D1 credentials fail the build and runtime checks. Storage failures return explicit MCP errors without Blob or bundled-sample fallback. Legacy Blob code remains only for historical regression tests; production entry points do not import it.

`refresh/public-daily.js` stores the discovered region list, page cursor and accepted ID scope in the same D1 snapshot as its postings. Each delivery handles one page, so duplicate deliveries resume the durable cursor. A revision-guarded lease prevents concurrent publishers. Evidence precedes publication; failed publication preserves jobs and cursor. Absent/closed jobs remain stored but are excluded from the searchable scope. Application dates and raw accepting status are checked again at query time. Completed run reports are retained in `public_ingestion_runs`.

Daily scheduling remains `0 21 * * *` UTC (06:00 KST). The source/schema preflight must pass before deployment. `migrations/0002_public_collection.sql` is additive and creates the evidence/report tables if absent; those tables already exist in the project D1 from the verified import.

The user's subsequent instruction replaces daily full collection with source-date incremental ingestion. `refresh/scheduled.js` never starts a new national scan. After the explicitly started baseline, daily runs perform local expiry only, with zero source requests until a verified modified-since change feed is available. See [D1-SYNC-POLICY.md](D1-SYNC-POLICY.md) for timestamp meanings, watermark rules and current limitations.

On 2026-11-14 the user approved the Worker deployment permission increase. Existing Wrangler login now includes `workers_scripts:write` and the prior D1 scope. The account's Workers Free plan was verified; no paid conversion or long-lived API token was created. Vercel Production received only the account/database identifiers and Worker URL. GitHub main remains unchanged.

The completed source-baseline release is `dpl_EpJeNAtiMemv6VhaDM6n4U23e1BJ`, built from runtime commit `f61a337bb0f77a3f8f5ac410802d771495c80416` on `codex/d1-migration-20261114`. Real staged and public MCP reads returned D1 data. Dashboard Run dispatched the private Queue, and live workers wrote all 277 regions to the same D1. The subsequent scheduled-maintenance release keeps the existing public alias and Cron, while disabling new automatic source scans.

An actual official region response took 14.5 seconds. The source timeout is therefore 30 seconds; the previous 12-second deployment exhausted its bounded retries without losing its cursor. The corrected deployment resumed that cursor and passed the delayed region.

## Validation

```sh
npm test
node scripts/verify-public-pipeline.js /private/tmp/senior-jobs-UNIQUE.json
node scripts/verify-d1-mcp.js
npx wrangler@4.162.0 d1 execute senior-jobs-mcp --remote --command "SELECT COUNT(*) AS imported_jobs FROM jobs;" --json
```

The captured official 718 records passed through the operational collector in 25 isolated deliveries, producing 718 SQL jobs and 718 original evidence rows. The real MCP HTTP handler returned 718 matches using that same isolated SQL store; duplicate completion changed no snapshot. Both the staged Production deployment and public MCP alias also returned actual remote D1 data. Full live collection results must be read from the completed D1 run report, not inferred from trigger acceptance.

153 local tests cover zero-source daily maintenance, unchanged source timestamps, local expiry, idempotency, source/storage failure recovery, concurrent leases, preserved historical rows, fixed-query Worker behavior and signed OIDC rejection. A dependency check excludes the legacy Blob adapter from production entry points and build checks.
