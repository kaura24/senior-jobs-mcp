'use strict';
const http = require('node:http');
const assert = require('node:assert/strict');

async function verify() {
  process.env.D1_WRANGLER_READS = '1';
  const handler = require('../api/mcp');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  async function call(name, args) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result.isError, false);
    assert.equal(data.result.structuredContent.context.snapshotOrigin, 'd1');
    return data.result.structuredContent;
  }
  try {
    const options = await call('describe_search_options', {});
    const searched = await call('search_jobs', { anyRegion: true, anyWork: true, limit: 3 });
    assert.ok(searched.totalMatches > 0);
    assert.ok(searched.jobs.every(job => job.eligibility.eligible && job.detailLink.url?.startsWith('https://www.seniorro.or.kr/noin/jobDetail.do?')));
    const detail = await call('get_job_details', { id: searched.jobs[0].id });
    const result = { transport: 'local_http_using_existing_wrangler_auth', status: 200, storage: 'd1',
      totalMatches: searched.totalMatches, observedAt: searched.context.observedAt,
      optionsReturned: !!options.factors, selectedId: searched.jobs[0].id,
      detailReturned: !!detail, jobs: searched.jobs.map(job => ({ id: job.id, title: job.title, region: job.region, url: job.detailLink.url })) };
    console.log(JSON.stringify(result)); return result;
  } finally { await new Promise(resolve => server.close(resolve)); }
}
if (require.main === module) verify().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { verify };
