# Official public-source D1 recollection

## Verified result: 2026-11-14

The project database is `senior-jobs-mcp` (`8df2c092-4e5a-4eb6-a3a2-2e5dd97d5125`), account `0ae5b2a5dc0d07651d66b5e4db2b0d0c`.

The public website `https://www.seniorro.or.kr/noin/main.do` exposes its region lookup and job search without login or an API key. The request and field mapping were verified against the website's own `resources/js/noin/renewal/jobSearch.js`. The collector uses the published project-type filters A/C/B/E and the site's 30-row page size. It paces requests and records failures and repeated pages.

- 277 distinct public lookup regions completed; 0 failed regions.
- 879 returned rows; 158 duplicates removed using the official job/type/institution identifiers.
- 3 rows from an expired project year excluded; 0 malformed records or conflicting IDs.
- 718 postings met both the raw `접수중` status and the current KST application period.
- New: 718; updated: 0; failed imports: 0.
- D1 readback: 718 rows, 718 distinct IDs, 718 currently accepting, 718 original evidence records.
- Reprocessing the same collection: 0 new, 0 updated, 718 unchanged, 0 failures.
- Collection completed at 2026-11-14 09:53:45 KST.
- Initial import run: `d412ed7f-a41b-441c-b41f-6436c7f24c6f`.

This is the observed coverage of the public lookup and filters. It does not establish complete coverage of every Korean job source. The locked Blob's older SenuriService postings and checkpoint were not imported. Existing Blob objects were left untouched.

## Reproduce with existing credentials

```sh
node scripts/collect-public-jobs.js /private/tmp/senior-jobs-collection-UNIQUE.json
node scripts/import-public-d1.js /private/tmp/senior-jobs-collection-UNIQUE.json /private/tmp/senior-jobs-import-UNIQUE
node scripts/verify-d1-mcp.js
```

Choose unused output paths; output files refuse to overwrite existing files. The collector needs no authentication. Import and MCP verification use the existing Wrangler OAuth connection with its D1 scope. No API token is created. No paid plan or permission change is performed.

The import merges by the namespaced official identifier, retains existing IDs absent from the new collection and archives observed source versions before publishing changed rows. Snapshot publication uses the existing revision guard. It verifies the reconstructed snapshot hash and existing-ID preservation by reading D1 afterward. Original source observations and ingestion reports remain in D1; staged input rows are retained as import evidence.

## MCP verification and runtime boundary

`verify-d1-mcp.js` drives the real MCP HTTP handler locally with `D1_WRANGLER_READS=1`. Describe, search and detail all returned HTTP 200 from the real remote D1, with `snapshotOrigin: d1`, 718 matches and verified official source links. Detail documents, salary and other missing fields are not fabricated. The local Wrangler mode is read-only and explicitly rejects running inside Vercel.

The original manual-recollection verification did not switch the deployed connector. That boundary was subsequently resolved using the user's approved Worker deployment permission and existing Vercel Production OIDC. Production MCP and Cron/Queue now use the same D1 through the fixed-operation Worker, without a long-lived D1 API token. See [D1-MIGRATION.md](D1-MIGRATION.md) and [D1-OIDC-BRIDGE.md](D1-OIDC-BRIDGE.md) for the live deployment and checks.

The user's final correction excludes Blob recovery and migration entirely. Do not retry the old Blob, wait for its restoration, or make future collection depend on it.

## Checks

The original recollection passed 138 tests and real remote D1/local HTTP checks. The subsequent OIDC production release passed 149 tests, authenticated build checks, staged/public MCP reads and live Cron/Queue D1 writes. The original counts and timestamps above describe the manual collection, not a later live run's totals.
