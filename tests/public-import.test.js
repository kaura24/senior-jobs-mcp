'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { posting } = require('../refresh/public-source');
const { preparePublicImport, importSql } = require('../lib/public-import');
const { createD1Store } = require('../lib/d1-store');
const { withDataset } = require('../lib/job-context');
const { searchJobs } = require('../lib/jobs');
const at = '2026-11-14T01:00:00Z';
function observed(id, title = '검증용 공고') {
  return posting({ JOB_ID: id, PROJ_TYPE: 'A', INSTN_ID: 'fixture', RECRT_TITLE: title, ORAN_NM: '테스트 기관',
    WORK_PLC_NM: '서울특별시/강남구', FR_DD: '20261101', TO_DD: '20261231', DEADLINE: '접수중', PROJ_YEAR: '2026' }, at);
}
const collection = postings => ({ source: 'https://www.seniorro.or.kr/noin/main.do', startedAt: at, completedAt: at,
  postings, counts: { failedRegions: 0 }, failures: [], regions: [] });
function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(require.resolve('../migrations/0001_d1_storage.sql'), 'utf8'));
  t.after(() => db.close());
  return { db, store: createD1Store(async (sql, params) => db.prepare(sql).all(...params)) };
}
test('public source mapping preserves observed fields and excludes expired or closed postings', () => {
  const source = observed('fixture-1');
  assert.equal(source.row.deadline, '접수중');
  assert.equal(source.row.workPlcNm, '서울특별시/강남구');
  assert.equal(source.row.emplymShp, undefined);
  assert.equal(source.source.fields.JOB_ID, 'fixture-1');
  assert.equal(source.eligible, true);
  assert.equal(posting({ ...source.source.fields, DEADLINE: '접수마감' }, at).eligible, false);
  assert.equal(posting({ ...source.source.fields, TO_DD: '20261113' }, at).eligible, false);
  assert.equal(posting({ ...source.source.fields, PROJ_YEAR: '2025' }, at).eligible, false);
});
test('public import keeps existing IDs, archives changed evidence and deduplicates a repeated run', async t => {
  const { db, store } = setup(t);
  const initial = preparePublicImport(collection([observed('fixture-1')]), null);
  db.exec(importSql(initial).sql);
  const original = await store.readCurrent();
  const changed = collection([observed('fixture-1', '변경된 공고'), observed('fixture-2')]);
  const next = preparePublicImport(changed, original);
  assert.deepEqual(next.counts, { new: 1, updated: 1, unchanged: 0, failed: 0, retained: 0 });
  db.exec(importSql(next).sql);
  const restored = await store.readCurrent();
  assert.equal(restored.value.sha256, next.envelope.sha256);
  assert.equal(restored.value.snapshot.jobs.length, 2);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT source_hash) AS n FROM source_observations WHERE job_id=?').get(observed('fixture-1').row.jobId).n, 3);
  const repeat = preparePublicImport(changed, restored);
  assert.equal(repeat.counts.new, 0); assert.equal(repeat.counts.updated, 0); assert.equal(repeat.counts.unchanged, 2);
  const partial = preparePublicImport(collection([observed('fixture-2')]), restored);
  db.exec(importSql(partial).sql);
  assert.equal((await store.readCurrent()).value.snapshot.jobs.length, 2);
});
test('a stale public import cannot overwrite a newer snapshot or publish its audit report', async t => {
  const { db, store } = setup(t);
  db.exec(importSql(preparePublicImport(collection([observed('fixture-1')]), null)).sql);
  const current = await store.readCurrent();
  const stale = importSql(preparePublicImport(collection([observed('fixture-2')]), current));
  await store.writeCurrent(current.value, current.etag);
  db.exec(stale.sql);
  assert.deepEqual((await store.readCurrent()).value.snapshot.jobs, current.value.snapshot.jobs);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM public_ingestion_runs WHERE run_id=?').get(stale.runId).n, 0);
});
test('MCP searches imported raw slash regions and returns only verified official posting links', async t => {
  const { db, store } = setup(t);
  db.exec(importSql(preparePublicImport(collection([observed('fixture-1')]), null)).sql);
  const current = await store.readCurrent();
  const result = withDataset({ snapshot: current.value.snapshot, refreshState: current.value.refreshState },
    () => searchJobs({ region: '서울', keyword: '검증', limit: 3 }, new Date(at)));
  assert.equal(result.totalMatches, 1);
  assert.equal(result.jobs[0].normalizedRegion.province, '서울');
  assert.equal(result.jobs[0].detailLink.url, observed('fixture-1').source.url);
  assert.equal(result.jobs[0].detailState, 'not_collected');
});
