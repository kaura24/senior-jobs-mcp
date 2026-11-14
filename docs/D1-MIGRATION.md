# D1 migration

## Current result

The original Blob export remains blocked, but a free official public-source recollection has now populated D1 with 718 real current postings using the existing Wrangler D1 connection. D1 readback, duplicate reprocessing and the real local MCP HTTP handler were verified. See [D1-PUBLIC-RECOLLECTION.md](D1-PUBLIC-RECOLLECTION.md) for the result, reproducible commands and the production authentication boundary. No paid conversion, new API token or permission expansion was performed.

## Prepared database

- Account: `0ae5b2a5dc0d07651d66b5e4db2b0d0c`
- Database: `senior-jobs-mcp`
- Database ID: `8df2c092-4e5a-4eb6-a3a2-2e5dd97d5125`
- Location hint: APAC; remote query served from NRT.
- CLI: Wrangler 4.162.0.
- Schema applied remotely: `migrations/0001_d1_storage.sql`.

`jobs` stores one source posting per row. `job_details` stores cached evidence. `storage_documents` stores snapshot metadata and the durable refresh checkpoint. SQL triggers publish a snapshot and its rows atomically. Revision checks prevent stale workers from overwriting newer data. Original snapshot hashes, source timestamps and cursor values remain intact.

## Import the original data

The existing private Blob store is `store_QUbkiYNTaevf5Ruq`. It contains `senior-jobs/current.json` and `senior-jobs/control.json`. On 2026-11-14 it was suspended after exhausting the Hobby advanced-operation quota, and the dashboard Download action was disabled. No latest source file has been downloaded or imported. The old bundled sample must not be used as a replacement for the latest collected data.

After both original files can be exported, keep them under the ignored `private/` directory and run:

```sh
node scripts/prepare-d1-migration.js private/current.json private/control.json private/d1-import.sql
npx wrangler@4.162.0 d1 execute senior-jobs-mcp --remote --file private/d1-import.sql
```

The import refuses to replace an existing current snapshot. It preserves source observation dates and the original checkpoint. The generated SQL contains posting data, not credentials, and must remain outside Git. The import uses small SQL statements to stay within D1's statement-size limit.

Verify the imported job count, reconstructed snapshot hash and checkpoint cursor against the original files before switching runtime storage.

## Runtime configuration

Vercel Production requires:

- `CLOUDFLARE_ACCOUNT_ID` = the account above.
- `D1_DATABASE_ID` = the database above.
- `CLOUDFLARE_D1_API_TOKEN` = a server-side D1 token for that account.
- Existing `DATA_GO_KR_SERVICE_KEY` and `CRON_SECRET` remain required.

Keep tokens in the server's secret manager. Do not copy a Wrangler OAuth access or refresh token into Vercel: the access token expires and a refresh token grants persistent access to the CLI session.

Setting `D1_DATABASE_ID` selects D1 for MCP reads and Queue refresh writes. Missing D1 credentials cause the deployment configuration check to fail. Without the D1 selector, the original Blob adapter remains available. Switching back to an older Blob snapshot would discard newer progress, so keep the original store until the D1 cutover is verified.

After successful import and deployment, use the existing authenticated Vercel Cron Run action to resume collection. The imported lease must have expired before starting. Daily scheduling remains 06:00 KST. Current-date and raw accepting-status checks remain enforced; moving storage does not fix upstream repeated pages.

## Validation

```sh
npm test
npx wrangler@4.162.0 d1 execute senior-jobs-mcp --remote --command "SELECT COUNT(*) AS imported_jobs FROM jobs;" --json
```

138 tests passed locally on Node 26, including real SQLite checks for snapshot hashes, row separation, stale-writer rejection, transactional rollback, Unicode import, checkpoint preservation, public-source merge and official source links. The remote D1 contains 718 verified public-source postings. The original Blob-source migration, authorized production runtime connection, production cutover and server-side automatic collection remain pending.
