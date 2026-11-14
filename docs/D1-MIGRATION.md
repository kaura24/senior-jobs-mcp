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
- `CLOUDFLARE_D1_API_TOKEN` = a server-side D1 token for that account.
- Existing `CRON_SECRET` remains required. Public-source collection does not use `DATA_GO_KR_SERVICE_KEY`.

Keep tokens in the server's secret manager. Do not copy a Wrangler OAuth access or refresh token into Vercel: the access token expires and a refresh token grants persistent access to the CLI session.

Both account and database must match this project's identifiers. `lib/runtime-store.js` is the only production storage factory; MCP, Cron and Queue use D1 exclusively. Missing D1 credentials fail the build and runtime checks. Storage failures return explicit MCP errors without Blob or bundled-sample fallback. Legacy Blob code remains only for historical regression tests; production entry points do not import it.

`refresh/public-daily.js` stores the discovered region list, page cursor and accepted ID scope in the same D1 snapshot as its postings. Each delivery handles one page, so duplicate deliveries resume the durable cursor. A revision-guarded lease prevents concurrent publishers. Evidence precedes publication; failed publication preserves jobs and cursor. Absent/closed jobs remain stored but are excluded from the searchable scope. Application dates and raw accepting status are checked again at query time. Completed run reports are retained in `public_ingestion_runs`.

Daily scheduling remains `0 21 * * *` UTC (06:00 KST). The source/schema preflight must pass before deployment. `migrations/0002_public_collection.sql` is additive and creates the evidence/report tables if absent; those tables already exist in the project D1 from the verified import.

The existing Vercel Production environment was rechecked: source secret, Cron secret and legacy Blob configuration only, with no D1 runtime credential. Therefore this code is not deployed and automatic D1 refresh is not active. No new credential, permission expansion or paid plan is authorized. Do not transfer local Wrangler OAuth credentials to Vercel. GitHub main updates require prior user approval.

## Validation

```sh
npm test
node scripts/verify-public-pipeline.js /private/tmp/senior-jobs-UNIQUE.json
node scripts/verify-d1-mcp.js
npx wrangler@4.162.0 d1 execute senior-jobs-mcp --remote --command "SELECT COUNT(*) AS imported_jobs FROM jobs;" --json
```

The captured official 718 records passed through the operational collector in 25 isolated deliveries, producing 718 SQL jobs and 718 original evidence rows. The real MCP HTTP handler returned 718 matches using that same isolated SQL store; duplicate completion changed no snapshot. The real remote D1 also returned 718 matches through the local MCP HTTP handler. Production cutover and server-side automatic collection remain blocked by the missing authorized D1 runtime connection.

145 local tests passed, including source/storage failure recovery, concurrent delivery leases, duplicate completion, preserved historical rows, hidden closed postings, explicit MCP storage errors and a dependency check excluding the legacy Blob adapter from every production entry point and build preflight.
