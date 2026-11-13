'use strict';
const { createSource } = require('../refresh/source');
async function verify() {
  const source = createSource(process.env.DATA_GO_KR_SERVICE_KEY, fetch, { timeoutMs: 30000,
    onEvent: event => { if (event.state !== 'started') console.log(JSON.stringify({ event: 'source_preflight_request', ...event })); } });
  const first = await source.list(1, 1000);
  const second = first.totalCount > 1000 ? await source.list(2, 1000) : null;
  const ids = page => [...new Set(page.items.map(row => row.jobId))].sort().join(',');
  const repeated = !!second && ids(first) === ids(second);
  console.log(JSON.stringify({ proofKind: 'live_source_preflight', sourceRequests: source.diagnostics().requests,
    totalCount: first.totalCount, firstPageItems: first.items.length, secondPageItems: second?.items.length || 0,
    repeatedPages: repeated, observedAt: new Date().toISOString() }));
  if (repeated) throw new Error('SOURCE_PAGINATION_REPEATED');
}
verify().catch(cause => { console.error(cause.code || (cause.message === 'SOURCE_PAGINATION_REPEATED' ? cause.message : 'SOURCE_PREFLIGHT_FAILED')); process.exitCode = 1; });
