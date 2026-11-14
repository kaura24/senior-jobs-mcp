# Production OIDC bridge

The Cloudflare Worker `senior-jobs-mcp-storage` binds only the existing project D1 `senior-jobs-mcp` (`8df2c092-4e5a-4eb6-a3a2-2e5dd97d5125`). Its endpoint is `https://senior-jobs-mcp-storage.kaura24.workers.dev/storage`. The account's Workers Free plan was verified before deployment. No plan conversion or long-lived D1 API token was created.

On 2026-11-14 the user explicitly approved the Worker deployment permission increase. Wrangler login was renewed with only `user:read`, `account:read`, `workers_scripts:write`, existing `d1:write` and OAuth offline access. Local OAuth credentials remain local. They are not copied into Vercel or the Worker.

## Authentication

The existing Vercel project has OIDC enabled with the team issuer. The bridge verifies the signature against that issuer's fixed public JWKS, permits RS256 only, requires and checks exp/nbf/iat, limits token age to two hours and matches all of:

- Issuer: `https://oidc.vercel.com/kaura24-7661s-projects`
- Audience: `https://vercel.com/kaura24-7661s-projects`
- Subject: `owner:kaura24-7661s-projects:project:senior-jobs-poc-mcp:environment:production`
- Owner ID: `team_3iBzdDdHq3kkOXM9uhOYxwJu`
- Project ID: `prj_5r5fRoQPxE0Xo1VGNwY8BNyBW4FK`
- Owner/project names and `environment: production`

Preview and other project tokens fail before D1 access. Unauthenticated requests return 401. Neither token text nor raw authentication failures are logged. The production entry point cannot inject local test keys. Public Vercel MCP calls do not receive these service tokens.

## Storage boundary

The Worker accepts only four named operations: read a current/control document, revision-guarded document publication, archive official evidence, and record a completed ingestion run. SQL strings, arbitrary table names and database selectors are not accepted from HTTP requests. Queries come from the repository's fixed catalog. Types, sizes, snapshot digest, evidence hashes and official source links are checked.

The native D1 publication query additionally refuses to omit any existing job or detail ID. Job updates retain their prior evidence; failed/stale writes cannot advance the cursor. The Worker has no other database bindings, routes, scheduled triggers, KV storage or API tokens. Version preview URLs are disabled.

Vercel Production uses the existing Cron secret plus three non-secret configuration values: the known account ID, database ID and `D1_WORKER_URL`. `@vercel/functions/oidc` obtains the current short-lived token for each request. Both MCP reads and Queue collection writes use this bridge. Blob paths and bundled fallback remain excluded.

## Verification and release

Run `npm test`; the isolated bridge tests cover bad signatures, expiration, future activation, wrong issuer/audience/subject, preview, other projects, forbidden SQL, stale writes, deletion prevention, source failure, duplicate processing and D1 readback.

Deploy the Worker with `npx --offline wrangler@4.162.0 deploy`. Stage the existing Vercel project using `vercel deploy --prod --skip-domain`, which preserves the current production alias. The build checks real authenticated D1 reads and official source availability. Verify the staged MCP before promotion, then run the existing Cron and follow Queue progress to full public-region completion. Record actual deployment IDs and collection results only after those checks pass.

Official references: [Vercel OIDC API validation](https://vercel.com/docs/oidc/api), [Vercel claims reference](https://vercel.com/docs/oidc/reference), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
