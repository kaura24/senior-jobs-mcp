'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createD1Store } = require('../lib/d1-store');
const { runScheduledChunk } = require('../refresh/scheduled');
const { preparePublicImport } = require('../lib/public-import');
const { posting } = require('../refresh/public-source');
const { digest } = require('../lib/snapshot-store');
const at = '2026-11-14T01:00:00Z';
function collection(title = '격리 공고', observedAt = at) {
  return { source: 'https://www.seniorro.or.kr/noin/main.do', startedAt: observedAt, completedAt: observedAt,
    failures: [], regions: [], counts: {}, postings: [posting({ JOB_ID: 'fixture', PROJ_TYPE: 'A', INSTN_ID: '1234',
      RECRT_TITLE: title, FR_DD: '20261101', TO_DD: '20261114', DEADLINE: '접수중', PROJ_YEAR: '2026' }, observedAt)] };
}
function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(require.resolve('../migrations/0001_d1_storage.sql'), 'utf8'));
  return createD1Store(async (sql, params) => db.prepare(sql).all(...params));
}
test('scheduled maintenance makes zero source calls, preserves rows and source timestamps, and expires only the active scope', async t => {
  const store = setup(t), prepared = preparePublicImport(collection(), null);
  prepared.envelope.runPlan = { kind: 'official_public', phase: 'done', runDayKst: '2026-11-14' };
  prepared.envelope.refreshState.lastSuccessfulAt = at;
  await store.writeCurrent(prepared.envelope);
  const source = new Proxy({}, { get() { assert.fail('daily maintenance must never call the source'); } });
  const now = () => new Date('2026-11-14T15:00:00Z'); // Next KST day.
  const result = await runScheduledChunk({ store, source, now });
  assert.equal(result.sourceRequests, 0); assert.equal(result.expiredFromActive, 1);
  const current = await store.readCurrent();
  assert.equal(current.value.snapshot.jobs.length, 1);
  assert.deepEqual(current.value.snapshot.metadata.refresh.queryableIds, []);
  assert.equal(current.value.snapshot.metadata.observedAt, at);
  assert.equal(current.value.refreshState.lastSuccessfulAt, at);
  assert.equal(current.value.snapshot.metadata.syncPolicy.sourceWatermark, null);
  assert.equal(current.value.snapshot.metadata.syncPolicy.automaticFullScan, false);
  assert.equal(current.value.snapshot.metadata.freshnessById.SR_A_fixture_1234.lastCheckedAt, at);
  assert.equal((await runScheduledChunk({ store, source, now })).state, 'already_completed');
  assert.deepEqual(await store.readCurrent(), current);
});
test('a missing source baseline never causes an implicit national scan', async t => {
  const store = setup(t), prepared = preparePublicImport(collection(), null);
  await store.writeCurrent(prepared.envelope);
  const source = new Proxy({}, { get() { assert.fail('no implicit source scan'); } });
  const result = await runScheduledChunk({ store, source, now: () => new Date(at) });
  assert.equal(result.sourceRequests, 0);
  assert.equal((await store.readCurrent()).value.snapshot.metadata.syncPolicy.mode, 'awaiting_verified_change_feed');
});
test('concurrent maintenance deliveries keep one durable publication and no source calls', async t => {
  const store = setup(t), prepared = preparePublicImport(collection(), null);
  await store.writeCurrent(prepared.envelope);
  const source = new Proxy({}, { get() { assert.fail('no source calls'); } });
  const options = { store, source, now: () => new Date(at) };
  const results = await Promise.allSettled([runScheduledChunk(options), runScheduledChunk(options)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PRECONDITION_FAILED');
  assert.equal((await store.readControl()).value.state, 'local_maintenance_completed');
  const current = await store.readCurrent();
  assert.equal((await runScheduledChunk(options)).state, 'already_completed');
  assert.deepEqual(await store.readCurrent(), current);
});
test('timestamps distinguish a new observation from a real content change and never fabricate source modification dates', () => {
  const first = preparePublicImport(collection(), null, { changedAt: at });
  const secondAt = '2026-11-14T02:00:00Z';
  const second = preparePublicImport(collection('격리 공고', secondAt), { value: first.envelope, etag: 'first' });
  const id = 'SR_A_fixture_1234';
  assert.equal(second.envelope.snapshot.metadata.freshnessById[id].lastCheckedAt, secondAt);
  assert.equal(second.envelope.snapshot.metadata.freshnessById[id].lastContentChangedAt, at);
  const thirdAt = '2026-11-14T03:00:00Z';
  const third = preparePublicImport(collection('관찰된 변경', thirdAt), { value: second.envelope, etag: 'second' }, { changedAt: thirdAt });
  assert.equal(third.envelope.snapshot.metadata.freshnessById[id].lastContentChangedAt, thirdAt);
  assert.equal(third.envelope.snapshot.metadata.freshnessById[id].sourceUpdatedAt, null);
  assert.equal(third.envelope.snapshot.metadata.freshnessById[id].sourceCreatedAt, null);
  assert.equal(third.envelope.sha256, digest(third.envelope.snapshot));
});
