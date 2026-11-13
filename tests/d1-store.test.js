'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createD1Store } = require('../lib/d1-store');
const { digest, loadDataset } = require('../lib/blob-store');
const { prepareMigration } = require('../scripts/prepare-d1-migration');

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(require.resolve('../migrations/0001_d1_storage.sql'), 'utf8'));
  t.after(() => db.close());
  return { db, store: createD1Store(async (sql, params) => db.prepare(sql).all(...params)) };
}
function envelope() {
  const snapshot = { metadata: { observedAt: '2026-11-13T15:58:39Z', referenceDayKst: '2026-11-14' },
    jobs: [{ jobId: 'a', recrtTitle: "작은 '회사' 공고", deadline: '접수중', frDd: '20261101', toDd: '20261201' },
      { jobId: 'b', recrtTitle: '다른 공고', deadline: '접수중', frDd: '20261101', toDd: '20261201' }],
    detailSummaries: { a: { observation: 'original evidence' } } };
  return { schemaVersion: 1, snapshot, sha256: digest(snapshot), refreshState: { state: 'in_progress_partial' },
    runPlan: { phase: 'discovery', discovery: { nextPage: 367 } } };
}

test('D1 round-trips the original snapshot digest and keeps jobs in separate rows', async t => {
  const { db, store } = setup(t), original = envelope();
  await store.writeCurrent(original);
  const restored = await store.readCurrent();
  assert.deepEqual(restored.value, original);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 2);
  const document = db.prepare("SELECT * FROM storage_documents WHERE name='current'").get();
  assert.deepEqual(JSON.parse(document.payload).snapshot.jobs, []);
  assert.equal(document.incoming_jobs, null);
});

test('a stale D1 revision cannot replace the published jobs', async t => {
  const { store } = setup(t), original = envelope();
  const first = await store.writeCurrent(original);
  const next = structuredClone(original); next.snapshot.jobs = [next.snapshot.jobs[0]]; next.sha256 = digest(next.snapshot);
  await store.writeCurrent(next, first.etag);
  await assert.rejects(store.writeCurrent(original, first.etag), error => error.code === 'PRECONDITION_FAILED');
  assert.deepEqual((await store.readCurrent()).value, next);
});

test('a failed SQL publish rolls back metadata and job changes together', async t => {
  const { store } = setup(t), original = envelope(), first = await store.writeCurrent(original);
  const invalid = structuredClone(original);
  invalid.snapshot.jobs = [invalid.snapshot.jobs[0]];
  invalid.snapshot.detailSummaries.orphan = { observation: 'invalid reference' };
  invalid.sha256 = digest(invalid.snapshot);
  await assert.rejects(store.writeCurrent(invalid, first.etag), /FOREIGN KEY/);
  assert.deepEqual((await store.readCurrent()).value, original);
});

test('Wrangler migration SQL preserves source dates, apostrophes and the exact durable cursor', async t => {
  const { db, store } = setup(t), original = envelope();
  original.snapshot.jobs[0].recrtTitle = '채용🎵'.repeat(4000);
  original.sha256 = digest(original.snapshot);
  const control = { state: 'in_progress_partial', plan: { targetIds: ['a', 'b'], phase: 'discovery', discovery: { nextPage: 367 } } };
  db.exec(prepareMigration(original, control));
  assert.deepEqual((await store.readCurrent()).value, original);
  assert.deepEqual((await store.readControl()).value, control);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_inputs').get().n, 0);
});

test('reordered detail evidence keeps the published digest when D1 updates existing rows', async t => {
  const { store } = setup(t), original = envelope();
  original.snapshot.detailSummaries.b = { observation: 'second evidence' };
  original.sha256 = digest(original.snapshot);
  const first = await store.writeCurrent(original);
  const next = structuredClone(original);
  next.snapshot.detailSummaries = { b: original.snapshot.detailSummaries.b, a: original.snapshot.detailSummaries.a };
  next.sha256 = digest(next.snapshot);
  await store.writeCurrent(next, first.etag);
  assert.deepEqual((await store.readCurrent()).value, next);
});

test('D1 checkpoint updates keep compare-and-swap and expose D1 to MCP dataset loading', async t => {
  const { store } = setup(t);
  await store.writeCurrent(envelope());
  const first = await store.writeControl({ state: 'running' });
  await store.writeControl({ state: 'in_progress_partial' }, first.etag);
  await assert.rejects(store.writeControl({ state: 'stale' }, first.etag), error => error.code === 'PRECONDITION_FAILED');
  assert.equal((await store.readControl()).value.state, 'in_progress_partial');
  assert.equal((await loadDataset(store, true)).refreshState.storageState, 'd1');
});
