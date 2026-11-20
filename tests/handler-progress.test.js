'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('a failed queue dispatch records the failure while preserving any existing checkpoint', async () => {
  for (const prior of [null, { value: { leaseUntil: '2020-01-01T00:00:00Z' }, etag: 'old' }]) {
    const writes = [], logs = []; let dispatchCalls = 0;
    const store = { readControl: async () => prior, writeControl: async value => { writes.push(value); } };
    const sandbox = { module: { exports: {} }, Date, console: { log: x => logs.push(JSON.parse(x)) },
      require: name => ({ '../lib/runtime-store': { productionStore: async () => store, configured: () => true },
        '../lib/refresh-queue': { enqueue: async () => { dispatchCalls++; throw new Error('fake-secret'); } },
        '../lib/jobs': { kstDay: () => '2026-10-12' }, '../lib/refresh-policy': { isRefreshPaused: () => false } }[name]) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../api/refresh'), 'utf8'), sandbox);
    let response;
    const res = { setHeader() {}, end(body) { response = JSON.parse(body); } };
    await sandbox.module.exports({ method: 'GET', headers: {} }, res);
    assert.equal(dispatchCalls, 1);
    assert.equal(res.statusCode, 503);
    assert.equal(response.completionVerified, false);
    assert.equal(writes.length, 1, 'accepted task must persist an initial failure when the lease is absent or expired');
    assert.equal(writes[0].errorCode, 'QUEUE_DISPATCH_FAILED');
    assert.ok(logs.some(x => x.event === 'refresh_dispatch_failed' && x.errorCode === 'QUEUE_DISPATCH_FAILED'));
    assert.ok(!JSON.stringify(logs).includes('fake-secret'));
  }
});

