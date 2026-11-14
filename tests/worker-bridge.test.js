'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createD1Store } = require('../lib/d1-store');
const { operations } = require('../lib/d1-queries');
const { digest } = require('../lib/snapshot-store');
const { runPublicChunk } = require('../refresh/public-daily');
const { posting, PublicSourceError } = require('../refresh/public-source');
const { withDataset } = require('../lib/job-context');
const { searchJobs } = require('../lib/jobs');
let fixture;
async function signing() {
  if (fixture) return fixture;
  const jose = await import('jose'), auth = await import('../worker/auth.mjs');
  const key = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(key.publicKey);
  jwk.kid = 'isolated-fixture'; jwk.alg = 'RS256';
  fixture = { jose, auth, key, keys: jose.createLocalJWKSet({ keys: [jwk] }) };
  return fixture;
}
async function token(overrides = {}, keyOverride) {
  const { jose, auth, key } = await signing(), seconds = Math.floor(Date.now() / 1000);
  const { issuer, audience, subject, ...claims } = auth.identity;
  return new jose.SignJWT({ ...claims, iss: issuer, aud: audience, sub: subject,
    iat: seconds, nbf: seconds, exp: seconds + 300, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'isolated-fixture' }).sign(keyOverride || key.privateKey);
}
function request(value, body = { operation: 'readDocument', parameters: ['current'] }) {
  return new Request('https://isolated.invalid/storage', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(value ? { authorization: 'Bearer ' + value } : {}) }, body: JSON.stringify(body) });
}
async function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const file of ['0001_d1_storage.sql', '0002_public_collection.sql']) db.exec(fs.readFileSync(require.resolve('../migrations/' + file), 'utf8'));
  let calls = 0;
  const binding = { prepare(sql) { calls++; return { bind(...parameters) { return { all: async () => ({ success: true,
    results: db.prepare(sql).all(...parameters) }) }; } }; } };
  const bridge = (await import('../worker/index.mjs')).createBridge((await signing()).keys);
  const signed = await token();
  const query = async (sql, parameters) => {
    const operation = Object.keys(operations).find(key => operations[key] === sql);
    const response = await bridge.fetch(request(signed, { operation, parameters }), { DB: binding });
    assert.equal(response.status, 200);
    return (await response.json()).rows;
  };
  return { db, binding, bridge, signed, store: createD1Store(query), calls: () => calls };
}
function envelope() {
  const snapshot = { metadata: { observedAt: '2026-11-14T01:00:00Z' }, jobs: [{ jobId: 'retained-id', recrtTitle: '보존 자료' }], detailSummaries: {} };
  return { schemaVersion: 1, snapshot, sha256: digest(snapshot), refreshState: {} };
}
test('Worker rejects missing, forged, expired, future, preview and other-project tokens before any D1 access', async t => {
  const { bridge, binding, calls } = await setup(t), seconds = Math.floor(Date.now() / 1000);
  const other = await (await signing()).jose.generateKeyPair('RS256');
  const invalid = [null, 'garbage', await token({}, other.privateKey), await token({ exp: seconds - 1 }),
    await token({ nbf: seconds + 60 }), await token({ iss: 'https://example.invalid' }),
    await token({ aud: 'other' }), await token({ sub: 'other' }), await token({ environment: 'preview' }),
    await token({ project_id: 'other' }), await token({ owner_id: 'other' }), await token({ project: 'other' }),
    await token({ iat: seconds - 8000, nbf: seconds - 8000, exp: seconds + 1 })];
  for (const value of invalid) assert.equal((await bridge.fetch(request(value), { DB: binding })).status, 401);
  assert.equal(calls(), 0);
});
test('Worker exposes only fixed operations and rejects SQL text, table selectors and altered parameters', async t => {
  const { bridge, binding, signed, calls } = await setup(t);
  for (const body of [{ sql: 'SELECT 1', parameters: [] }, { operation: 'readDocument', parameters: ['other_table'] },
    { operation: 'delete', parameters: [] }, { operation: 'readDocument', parameters: ['current'], sql: 'DROP TABLE jobs' },
    { operation: 'recordRun', parameters: ['invalid', '2026-11-14', '{}'] }]) {
    assert.equal((await bridge.fetch(request(signed, body), { DB: binding })).status, 400);
  }
  assert.equal(calls(), 0);
});
test('fixed Worker writes read back from SQL, reject stale replay and cannot remove existing jobs', async t => {
  const { store, db } = await setup(t), original = envelope();
  const first = await store.writeCurrent(original);
  assert.deepEqual((await store.readCurrent()).value, original);
  const next = structuredClone(original); next.snapshot.jobs.push({ jobId: 'added-id' }); next.sha256 = digest(next.snapshot);
  await store.writeCurrent(next, first.etag);
  await assert.rejects(store.writeCurrent(next, first.etag), error => error.code === 'PRECONDITION_FAILED');
  const latest = await store.readCurrent();
  await assert.rejects(store.writeCurrent(original, latest.etag), error => error.code === 'PRECONDITION_FAILED');
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 2);
});
test('operational collection through authenticated Worker SQL handles duplicates, source failure and query readback', async t => {
  const { store, db } = await setup(t), at = '2026-11-14T01:00:00Z', now = () => new Date(at);
  const record = { JOB_ID: 'fixture', PROJ_TYPE: 'A', INSTN_ID: '1234', RECRT_TITLE: '격리 공고', DEADLINE: '접수중',
    FR_DD: '20261101', TO_DD: '20261231', PROJ_YEAR: '2026', WORK_PLC_NM: '서울특별시/강남구' };
  let failed = true;
  const source = { posting, discoverRegions: async () => ({ regions: [{ province: '서울특별시', district: '강남구' }] }),
    fetchRegionPage: async () => { if (failed) throw new PublicSourceError('PUBLIC_SOURCE_TIMEOUT');
      return { total: 2, rows: [record, record], observedAt: at }; } };
  await runPublicChunk({ store, source, now });
  const before = await store.readCurrent();
  await assert.rejects(runPublicChunk({ store, source, now }), /PUBLIC_SOURCE_TIMEOUT/);
  assert.deepEqual(await store.readCurrent(), before);
  failed = false;
  const result = await runPublicChunk({ store, source, now });
  assert.equal(result.state, 'public_collection_completed'); assert.equal(result.counts.new, 1); assert.equal(result.counts.duplicates, 1);
  assert.equal((await runPublicChunk({ store, source, now })).state, 'already_completed');
  const current = await store.readCurrent();
  const searched = withDataset({ snapshot: current.value.snapshot, refreshState: { ...current.value.refreshState, storageState: 'd1' } },
    () => searchJobs({ anyRegion: true, anyWork: true }, now()));
  assert.equal(searched.totalMatches, 1); assert.equal(searched.context.snapshotOrigin, 'd1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_observations').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM public_ingestion_runs').get().n, 1);
});
