'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../lib/jobs');
const { respond } = require('../lib/protocol');
const handler = require('../api/mcp');
const now = new Date('2026-10-11T17:00:00Z');
const knownId = 'KJ21062610080016';

test('snapshot contains precisely the approved public scope', () => {
  assert.equal(jobs.snapshot.jobs.length, 314);
  assert.equal(new Set(jobs.snapshot.jobs.map(row => row.jobId)).size, 314);
  assert.deepEqual(Object.keys(jobs.snapshot.detailSummaries), [knownId]);
  assert.equal(jobs.context(now).fullDetailDocuments, 0);
  assert.equal(jobs.context(now).archiveRowsServed, 0);
});

test('both inclusive KST period and raw accepting status are required', () => {
  const row = { frDd: '20261008', toDd: '20261107', deadline: '접수중' };
  assert.equal(jobs.eligibility(row, new Date('2026-10-07T15:00:00Z')).eligible, true);
  assert.equal(jobs.eligibility(row, new Date('2026-10-07T14:59:59Z')).eligible, false);
  assert.equal(jobs.eligibility(row, new Date('2026-11-07T14:59:59.999Z')).eligible, true);
  assert.equal(jobs.eligibility(row, new Date('2026-11-07T15:00:00Z')).eligible, false);
  assert.equal(jobs.eligibility({ ...row, deadline: '마감' }, now).eligible, false);
  assert.equal(jobs.eligibility({ ...row, deadline: '' }, now).eligible, false);
  assert.equal(jobs.eligibility({ ...row, frDd: '20260230' }, now).eligible, false);
});

test('search filters all stored rows before paging', () => {
  const late = jobs.snapshot.jobs.find((row, index) => index > 250 && jobs.eligibility(row, now).eligible && row.workPlcNm);
  assert.ok(late);
  const expected = jobs.snapshot.jobs.filter(row => jobs.eligibility(row, now).eligible && String(row.workPlcNm || '').includes(late.workPlcNm));
  const result = jobs.searchJobs({ region: late.workPlcNm, limit: 1 }, now);
  assert.equal(result.totalMatches, expected.length);
  assert.equal(result.jobs[0].id, expected[0].jobId);
  assert.equal(jobs.searchJobs({ region: late.workPlcNm, offset: expected.length, limit: 1 }, now).jobs.length, 0);
});

test('options report missing coverage and unmeasured effectiveness', () => {
  const result = jobs.describeOptions({}, now);
  assert.equal(result.context.eligibleStoredJobs, 314);
  assert.equal(result.factors.region.providedJobs, 157);
  assert.equal(result.factors.occupation.providedJobs, 13);
  assert.equal(result.factors.salary.confirmationRequired, true);
  assert.equal(result.factors.employmentCode.effectivenessMeasured, false);
});

test('only known cached summary supplies raw public contact', () => {
  const result = jobs.getDetails({ id: knownId }, now);
  assert.equal(result.job.detailState, 'summary_only');
  assert.equal(result.contact.telephoneRaw, '031-8045-3268');
  assert.equal(result.fullDetailDocument, null);
  assert.equal(result.contact.connectivityVerified, false);
  const other = jobs.snapshot.jobs.find(row => row.jobId !== knownId);
  const missing = jobs.getDetails({ id: other.jobId }, now);
  assert.equal(missing.job.detailState, 'not_collected');
  assert.equal(missing.contact.state, 'not_collected');
  assert.equal(missing.cachedDetailSummary, null);
  assert.equal(jobs.getDetails({ id: 'unknown' }, now).found, false);
});

test('expired source is rechecked and static freshness is disclosed', () => {
  const future = new Date('2030-01-01T00:00:00Z');
  assert.equal(jobs.searchJobs({}, future).totalMatches, 0);
  assert.equal(jobs.getDetails({ id: knownId }, future).job.eligibility.eligible, false);
  assert.equal(jobs.context(future).sourceFreshness, 'stale_static_snapshot');
});

test('invalid input never turns into a live request', () => {
  assert.throws(() => jobs.searchJobs({ limit: 51 }, now));
  assert.throws(() => jobs.searchJobs({ keyword: {} }, now));
  assert.throws(() => jobs.searchJobs({ apiKey: 'unneeded' }, now));
  assert.throws(() => jobs.getDetails({ id: knownId, refresh: true }, now));
  assert.throws(() => jobs.describeOptions({ date: '2026-10-12' }, now));
});

test('MCP exposes exactly three read-only tools with successful cached results', () => {
  const call = (method, params) => respond({ jsonrpc: '2.0', id: 1, method, params }, now);
  assert.equal(call('initialize', { protocolVersion: '2025-06-18' }).result.protocolVersion, '2025-06-18');
  const list = call('tools/list').result.tools;
  assert.deepEqual(list.map(tool => tool.name), ['describe_search_options', 'search_jobs', 'get_job_details']);
  assert.ok(list.every(tool => tool.annotations.readOnlyHint));
  for (const [name, args] of [['describe_search_options', {}], ['search_jobs', { limit: 1 }], ['get_job_details', { id: knownId }]]) {
    const result = call('tools/call', { name, arguments: args }).result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.context.datasetState, 'partial_static_poc');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  assert.equal(call('tools/call', { name: 'refresh_dataset' }).error.code, -32602);
  assert.equal(call('tools/call', { name: 'search_jobs', arguments: { limit: 0 } }).result.isError, true);
  assert.equal(respond({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

async function invoke(method, body, extraHeaders = {}) {
  const result = { headers: {} };
  await handler({ method, body, headers: { 'content-type': 'application/json', ...extraHeaders } }, {
    setHeader(key, value) { result.headers[key] = value; },
    set statusCode(value) { result.status = value; },
    end(text) { result.body = text ? JSON.parse(text) : null; },
  });
  return result;
}

test('NoAuth HTTP initialize and notification work without a cookie or authorization', async () => {
  const result = await invoke('POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.serverInfo.name, 'senior-jobs-static-poc');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal((await invoke('POST', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});

test('HTTP rejects unsupported methods, malformed requests, and invalid Origin', async () => {
  assert.equal((await invoke('GET')).status, 405);
  assert.equal((await invoke('DELETE')).status, 405);
  assert.equal((await invoke('POST', '{')).status, 400);
  assert.equal((await invoke('POST', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await invoke('POST', {}, { origin: 'http://localhost:1234' })).status, 403);
  assert.equal((await invoke('POST', {}, { origin: 'https://chatgpt.com' })).status, 200);
});
