'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createD1Store } = require('../lib/d1-store');
const { runPublicChunk } = require('../refresh/public-daily');
const { posting, PublicSourceError } = require('../refresh/public-source');
const { productionStore, loadDataset, configured, accountId, databaseId } = require('../lib/runtime-store');
const at = '2026-11-14T01:00:00Z', now = () => new Date(at);
function raw(id, title = '격리 검증용 공고') {
  return { JOB_ID: id, PROJ_TYPE: 'A', INSTN_ID: 'fixture', RECRT_TITLE: title, PROJ_YEAR: '2026',
    DEADLINE: '접수중', FR_DD: '20261101', TO_DD: '20261231', WORK_PLC_NM: '서울특별시/강남구' };
}
function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const migration of ['0001_d1_storage.sql', '0002_public_collection.sql']) {
    db.exec(fs.readFileSync(require.resolve('../migrations/' + migration), 'utf8'));
  }
  const store = createD1Store(async (sql, params) => db.prepare(sql).all(...params));
  return { db, store };
}
function source(pages) {
  return { posting, discoverRegions: async () => ({ regions: pages.map((_, index) => ({ province: 'fixture', district: String(index) })) }),
    fetchRegionPage: async region => {
      const rows = pages[Number(region.district)];
      if (rows instanceof Error) throw rows;
      return { rows, total: rows.length, observedAt: at };
    } };
}
async function drain(store, upstream) {
  let result;
  for (let n = 0; n < 10; n++) {
    result = await runPublicChunk({ store, source: upstream, now });
    if (!result.continue) return result;
  }
  assert.fail('fixture did not terminate');
}
function handler(store) {
  const sandbox = { module: { exports: {} }, Buffer, URL, console, process: { env: {} },
    require: name => {
      if (name === '../lib/runtime-store') return { productionStore: async () => store, loadDataset };
      if (name === '../lib/protocol') {
        const protocol = require('../lib/protocol');
        return { ...protocol, respond: message => protocol.respond(message, now()) };
      }
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/mcp'), 'utf8'), sandbox);
  return sandbox.module.exports;
}
async function search(store) {
  let data;
  const res = { setHeader() {}, end(body) { data = JSON.parse(body); } };
  await handler(store)({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 1,
    method: 'tools/call', params: { name: 'search_jobs', arguments: { anyRegion: true, anyWork: true, limit: 3 } } } }, res);
  assert.equal(res.statusCode, 200);
  return data.result;
}
test('operational public collection commits to SQL, resumes each page and serves the same D1 through MCP', async t => {
  const { db, store } = setup(t), upstream = source([[raw('1')], [raw('1'), raw('2')]]);
  const result = await drain(store, upstream);
  assert.equal(result.state, 'public_collection_completed'); assert.equal(result.counts.new, 2);
  assert.equal(result.counts.duplicates, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_observations').get().n, 2);
  const response = await search(store);
  assert.equal(response.isError, false); assert.equal(response.structuredContent.context.snapshotOrigin, 'd1');
  assert.equal(response.structuredContent.totalMatches, 2);
  assert.match(response.structuredContent.jobs[0].detailLink.url, /^https:\/\/www.seniorro.or.kr\/noin\/jobDetail.do/);
  upstream.fetchRegionPage = () => assert.fail('completed delivery must not fetch again');
  assert.equal((await drain(store, upstream)).state, 'already_completed');
});
test('next-day refresh preserves prior rows and history while hiding absent and freshly closed jobs', async t => {
  const { db, store } = setup(t);
  await drain(store, source([[raw('1'), raw('2')]]));
  const tomorrow = () => new Date('2026-11-15T01:00:00Z');
  const upstream = source([[raw('2', '공식 변경')], [{ ...raw('2'), DEADLINE: '접수마감' }, raw('3')]]);
  let result;
  do { result = await runPublicChunk({ store, source: upstream, now: tomorrow }); } while (result.continue);
  const current = await store.readCurrent();
  assert.equal(current.value.snapshot.jobs.length, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_observations WHERE job_id=?').get('SR_A_2_fixture').n, 4);
  assert.equal(db.prepare("SELECT count(*) AS n FROM source_observations WHERE json_extract(source_json,'$.DEADLINE')='접수마감'").get().n, 1);
  assert.deepEqual(current.value.snapshot.metadata.refresh.queryableIds, ['SR_A_3_fixture']);
  const response = await search(store);
  assert.equal(response.structuredContent.totalMatches, 1);
});
test('source failure and publish failure preserve the committed cursor and jobs for bounded retry', async t => {
  for (const failPublish of [false, true]) {
    const { store } = setup(t), upstream = source([[raw('1')], [raw('2')]]);
    await runPublicChunk({ store, source: upstream, now });
    await runPublicChunk({ store, source: upstream, now });
    const before = await store.readCurrent();
    if (failPublish) {
      const write = store.writeCurrent;
      store.writeCurrent = async () => { throw new PublicSourceError('STORAGE_UNAVAILABLE'); };
      await assert.rejects(runPublicChunk({ store, source: upstream, now }), /STORAGE_UNAVAILABLE/);
      store.writeCurrent = write;
    } else {
      const fetch = upstream.fetchRegionPage;
      upstream.fetchRegionPage = async () => { throw new PublicSourceError('PUBLIC_SOURCE_TIMEOUT'); };
      await assert.rejects(runPublicChunk({ store, source: upstream, now }), /PUBLIC_SOURCE_TIMEOUT/);
      upstream.fetchRegionPage = fetch;
    }
    assert.deepEqual(await store.readCurrent(), before);
    assert.equal((await store.readControl()).value.state, 'paused_incomplete');
    await drain(store, upstream);
    assert.equal((await store.readCurrent()).value.snapshot.jobs.length, 2);
  }
});
test('concurrent deliveries cannot both hold the lease or duplicate committed jobs', async t => {
  const { db, store } = setup(t), upstream = source([[raw('1')]]);
  const results = await Promise.allSettled([runPublicChunk({ store, source: upstream, now }), runPublicChunk({ store, source: upstream, now })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PRECONDITION_FAILED');
  await drain(store, upstream);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
});
test('MCP fails explicitly on D1 errors and never serves bundled or prior cached postings', async t => {
  const { store } = setup(t);
  await drain(store, source([[raw('1')]]));
  assert.equal((await search(store)).structuredContent.totalMatches, 1);
  store.readCurrent = async () => { throw new Error('private fixture detail'); };
  const result = await search(store);
  assert.equal(result.isError, true); assert.equal(result.structuredContent.dataReturned, false);
  assert.equal(result.structuredContent.errorCode, 'STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private fixture detail'), false);
});
test('a Blob configuration alone or a different D1 never qualifies as a runtime connection', async () => {
  assert.equal(configured({ BLOB_STORE_ID: 'fixture' }), false);
  assert.equal(configured({ CLOUDFLARE_ACCOUNT_ID: accountId, D1_DATABASE_ID: 'other', CLOUDFLARE_D1_API_TOKEN: 'fixture' }), false);
  assert.equal(configured({ CLOUDFLARE_ACCOUNT_ID: accountId, D1_DATABASE_ID: databaseId, CLOUDFLARE_D1_API_TOKEN: 'fixture' }), true);
  const old = process.env.D1_WRANGLER_READS, vercel = process.env.VERCEL;
  try {
    process.env.D1_WRANGLER_READS = '1'; process.env.VERCEL = '1';
    await assert.rejects(productionStore(), cause => cause.code === 'SERVER_CONFIGURATION_REQUIRED');
  } finally {
    if (old === undefined) delete process.env.D1_WRANGLER_READS; else process.env.D1_WRANGLER_READS = old;
    if (vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = vercel;
  }
});

test('all production entry points and build checks have no dependency on the legacy Blob adapter', () => {
  const seen = new Set();
  function inspect(file) {
    if (seen.has(file) || !file.endsWith('.js')) return;
    seen.add(file);
    assert.notEqual(path.basename(file), 'blob-store.js');
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (match[1].startsWith('.')) inspect(require.resolve(path.resolve(path.dirname(file), match[1])));
    }
  }
  for (const entry of ['../api/mcp', '../api/refresh', '../api/refresh-worker',
    '../scripts/verify-live-source', '../scripts/verify-server-configuration']) inspect(require.resolve(entry));
});
