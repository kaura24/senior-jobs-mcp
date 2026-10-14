'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { executeChunk } = require('../refresh/task');
const { retry } = require('../lib/refresh-queue');
const { kstDay } = require('../lib/jobs');
const day = () => kstDay(new Date());
test('private queued chunks advance the durable cursor through more than five deliveries without recursive HTTP calls', async () => {
  const sent = [], logs = [];
  for (let n = 0; n < 8; n++) {
    await executeChunk(day(), { isPaused: () => false, storeFactory: async () => ({}), sourceFactory: () => ({}),
      chunk: async () => ({ state: 'in_progress_partial', continue: true, progress: { sourceCalls: n + 1, phase: 'revalidation', attemptedIds: n } }),
      dispatch: async (runDay, progress) => sent.push({ runDay, calls: progress.sourceCalls }), log: event => logs.push(event) });
  }
  assert.equal(sent.length, 8);
  assert.deepEqual(sent.map(x => x.calls), [1,2,3,4,5,6,7,8]);
  assert.ok(logs.filter(x => x.event === 'refresh_continuation').every(x => x.delivery === 'private_queue'));
});
test('an upstream timeout is persisted and rethrown for bounded queue retry while permanent source failures stay paused', async () => {
  for (const code of ['UPSTREAM_TIMEOUT', 'UPSTREAM_KEY_REJECTED']) {
    const writes = [], store = { readControl: async () => ({ value: { plan: { index: 4 } }, etag: 'old' }),
      writeControl: async value => writes.push(value) };
    const task = executeChunk(day(), { isPaused: () => false, storeFactory: async () => store, sourceFactory: () => ({}),
      chunk: async () => ({ state: 'paused_incomplete', errorCode: code, continue: false }), log: () => {} });
    if (code === 'UPSTREAM_TIMEOUT') {
      await assert.rejects(task, cause => cause.code === code);
      assert.equal(writes[0].plan.index, 4);
      assert.deepEqual(retry({ code }, { deliveryCount: 1 }, () => false), { afterSeconds: 30 });
      assert.deepEqual(retry({ code }, { deliveryCount: 5 }, () => false), { acknowledge: true });
    } else {
      assert.equal((await task).errorCode, code);
      assert.deepEqual(retry({ code }, { deliveryCount: 1 }, () => false), { acknowledge: true });
    }
  }
});
test('stale queued days and a completed run do not issue source requests or publish another continuation', async () => {
  let storeCalls = 0, dispatchCalls = 0;
  const deps = { isPaused: () => false, storeFactory: async () => { storeCalls++; return {}; }, sourceFactory: () => ({}),
    chunk: async () => ({ state: 'already_completed', continue: false }), dispatch: async () => dispatchCalls++, log: () => {} };
  assert.equal((await executeChunk('2000-01-01', deps)).state, 'stale_delivery_ignored');
  assert.equal(storeCalls, 0);
  assert.equal((await executeChunk(day(), deps)).state, 'already_completed');
  assert.equal(dispatchCalls, 0);
});
test('a retry that meets an unexpired orphaned lease remains queued until the lease can expire', async () => {
  const writes = [];
  const store = { readControl: async () => ({ value: { leaseUntil: new Date(Date.now() + 90000).toISOString() } }),
    writeControl: async value => writes.push(value) };
  await assert.rejects(executeChunk(day(), { isPaused: () => false, storeFactory: async () => store, sourceFactory: () => ({}),
    chunk: async () => ({ state: 'already_running', continue: false }), log: () => {} }), cause => cause.code === 'REFRESH_LEASE_ACTIVE');
  assert.equal(writes.length, 0);
  assert.deepEqual(retry({ code: 'REFRESH_LEASE_ACTIVE' }, { deliveryCount: 1 }, () => false), { afterSeconds: 30 });
});
test('a chunk crossing KST midnight queues the current day so the next delivery is not discarded as stale', async () => {
  let tick = Date.parse('2026-10-12T14:59:59.998Z'), nextDay;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [tick])); } static now() { return tick; } }
  const sandbox = { module: { exports: {} }, Date: Clock, process: { env: {} }, fetch: () => {}, console,
    require: name => ({ '../lib/blob-store': {}, './daily': {}, './source': {}, './runner': { errorCode: cause => cause.code },
      '../lib/refresh-queue': { retryable: () => false }, '../lib/jobs': { kstDay }, '../lib/refresh-policy': require('../lib/refresh-policy') }[name]) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../refresh/task'), 'utf8'), sandbox);
  await sandbox.module.exports.executeChunk('2026-10-12', { isPaused: () => false, storeFactory: async () => { tick += 4; return {}; }, sourceFactory: () => ({}),
    chunk: async () => ({ state: 'in_progress_partial', continue: true, progress: { dayKst: '2026-10-13', sourceCalls: 1 } }),
    dispatch: async dayKst => { nextDay = dayKst; }, log: () => {} });
  assert.equal(nextDay, '2026-10-13');
});

test('transient queue failure uses a compact durable checkpoint if its control plan exceeds the size limit', async () => {
  const writes = [], progress = { dayKst: day(), sourceCalls: 22, confirmedIds: 314, targetIds: 314 };
  const store = { readControl: async () => ({ etag: 'old', value: { plan: { large: true }, leaseUntil: null } }),
    readCurrent: async () => ({ value: { runPlan: { runDayKst: day() }, snapshot: { metadata: { refresh: { dailyRevalidation: progress } } } } }),
    writeControl: async (value, etag) => { assert.equal(etag, 'old');
      if (value.plan) throw Object.assign(new Error('SNAPSHOT_TOO_LARGE'), { code: 'SNAPSHOT_TOO_LARGE' });
      writes.push(value); return { etag: 'new' }; } };
  await assert.rejects(executeChunk(day(), { isPaused: () => false, storeFactory: async () => store, sourceFactory: () => ({}),
    chunk: async () => ({ state: 'paused_incomplete', errorCode: 'UPSTREAM_TIMEOUT', continue: false }), log: () => {} }),
    cause => cause.code === 'UPSTREAM_TIMEOUT');
  assert.equal(writes.length, 1); assert.equal(writes[0].leaseUntil, null);
  assert.deepEqual(writes[0].dailyProgress, progress); assert.equal(writes[0].resumeSource, 'current_snapshot');
  assert.deepEqual(retry({ code: 'UPSTREAM_TIMEOUT' }, { deliveryCount: 1 }, () => false), { afterSeconds: 30 });
});

test('a repeated source page is retried at the durable cursor with the same bounded queue policy', async () => {
  const store = { readControl: async () => ({ value: { plan: { discovery: { nextPage: 23 } }, leaseUntil: null } }),
    writeControl: async () => ({ etag: 'next' }) };
  await assert.rejects(executeChunk(day(), { isPaused: () => false, storeFactory: async () => store, sourceFactory: () => ({}),
    chunk: async () => ({ state: 'paused_incomplete', errorCode: 'REPEATED_PAGE', continue: false }), log: () => {} }), cause => cause.code === 'REPEATED_PAGE');
  assert.deepEqual(retry({ code: 'REPEATED_PAGE' }, { deliveryCount: 1 }, () => false), { afterSeconds: 30 });
  assert.deepEqual(retry({ code: 'REPEATED_PAGE' }, { deliveryCount: 5 }, () => false), { acknowledge: true });
});
