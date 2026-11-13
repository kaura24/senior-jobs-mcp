'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { executeChunk } = require('../refresh/task');
const { isRefreshPaused, pausedResult } = require('../lib/refresh-policy');
const { kstDay } = require('../lib/jobs');

test('production enables daily nationwide refresh at 06:00 KST', () => {
  const config = require('../vercel.json');
  assert.equal(isRefreshPaused(), false);
  assert.deepEqual(config.crons, [{ path: '/api/refresh', schedule: '0 21 * * *' }]);
  assert.equal(config.functions['api/refresh-worker.js'].experimentalTriggers[0].topic, 'senior-jobs-refresh');
});

test('authenticated refresh dispatches; unauthenticated calls do not', async () => {
  let dispatched = 0;
  const sandbox = { module: { exports: {} }, Buffer, Date, console,
    process: { env: { CRON_SECRET: 'fixture-secret', BLOB_STORE_ID: 'fixture', DATA_GO_KR_SERVICE_KEY: 'fixture' } },
    require: name => ({ 'node:crypto': require('node:crypto'), '../lib/blob-store': {},
      '../lib/refresh-queue': { enqueue: async () => { dispatched++; } },
      '../lib/jobs': { kstDay: () => '2026-11-13' },
      '../lib/refresh-policy': require('../lib/refresh-policy') }[name]) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/refresh'), 'utf8'), sandbox);
  let body;
  const response = { setHeader() {}, end(text) { body = JSON.parse(text); } };
  await sandbox.module.exports({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, response);
  assert.equal(response.statusCode, 401); assert.equal(dispatched, 0);
  await sandbox.module.exports({ method: 'GET', headers: { authorization: 'Bearer fixture-secret' } }, response);
  assert.equal(response.statusCode, 202); assert.equal(body.state, 'queued'); assert.equal(dispatched, 1);
});

test('a pause detected after a fixture chunk blocks continuation and error checkpoint writes', async () => {
  for (const fail of [false, true]) {
    let paused = false;
    const forbidden = () => { assert.fail('pause must block dispatch and checkpoint writes'); };
    const result = await executeChunk(kstDay(new Date()), { isPaused: () => paused,
      storeFactory: async () => ({ readControl: forbidden, writeControl: forbidden }), sourceFactory: () => ({}),
      chunk: async () => { paused = true; if (fail) throw new Error('fixture failure'); return { continue: true }; },
      dispatch: forbidden, log: () => {} });
    assert.deepEqual(result, pausedResult());
  }
});
