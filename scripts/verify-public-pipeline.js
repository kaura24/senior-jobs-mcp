'use strict';
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { createD1Store } = require('../lib/d1-store');
const { loadDataset } = require('../lib/runtime-store');
const { runPublicChunk } = require('../refresh/public-daily');
const { posting } = require('../refresh/public-source');

// Replays captured official records into disposable SQLite only. No production writes or credentials.
async function verify(input) {
  const collection = JSON.parse(fs.readFileSync(input, 'utf8'));
  assert.equal(collection.source, 'https://www.seniorro.or.kr/noin/main.do');
  const records = collection.postings.map(value => value.source.fields);
  assert.ok(records.length > 0);
  const db = new DatabaseSync(':memory:');
  let server;
  try {
    for (const file of ['0001_d1_storage.sql', '0002_public_collection.sql']) db.exec(fs.readFileSync(require.resolve('../migrations/' + file), 'utf8'));
    const store = createD1Store(async (sql, params) => db.prepare(sql).all(...params));
    const source = { posting, discoverRegions: async () => ({ regions: [{ province: 'captured', district: 'official-records' }] }),
      fetchRegionPage: async (_, page) => ({ rows: records.slice((page - 1) * 30, page * 30), total: records.length,
        observedAt: collection.completedAt }) };
    let deliveries = 0, result;
    do {
      result = await runPublicChunk({ store, source }); deliveries++;
      assert.ok(deliveries <= 102);
    } while (result.continue);
    assert.equal(result.state, 'public_collection_completed');
    assert.equal(result.counts.new, records.length);
    const before = await store.readCurrent();
    assert.equal((await runPublicChunk({ store, source })).state, 'already_completed');
    assert.deepEqual(await store.readCurrent(), before);
    const sandbox = { module: { exports: {} }, Buffer, URL, console,
      require: name => name === '../lib/runtime-store' ? { productionStore: async () => store, loadDataset }
        : createRequire(require.resolve('../api/mcp'))(name) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../api/mcp'), 'utf8'), sandbox);
    server = http.createServer(sandbox.module.exports);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'search_jobs', arguments: { anyRegion: true, anyWork: true, limit: 3 } } }) });
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.result.isError, false);
    assert.equal(body.result.structuredContent.totalMatches, records.length);
    assert.equal(body.result.structuredContent.context.snapshotOrigin, 'd1');
    assert.ok(body.result.structuredContent.jobs.every(job => job.detailLink.url?.startsWith('https://www.seniorro.or.kr/')));
    return { proofKind: 'isolated_official_record_replay_through_operational_collector', productionWrites: 0,
      records: records.length, deliveries, duplicateDelivery: 'no_changes', counts: result.counts,
      sqlJobs: db.prepare('SELECT count(*) AS n FROM jobs').get().n,
      sqlEvidence: db.prepare('SELECT count(*) AS n FROM source_observations').get().n,
      mcpHttpStatus: response.status, mcpMatches: body.result.structuredContent.totalMatches, storage: 'd1' };
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
  }
}
if (require.main === module) verify(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(cause => {
  console.error(cause.code || cause.message); process.exitCode = 1;
});
module.exports = { verify };
