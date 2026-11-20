'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { executeChunk } = require('../refresh/task');
const { isRefreshPaused, pausedResult } = require('../lib/refresh-policy');
const { kstDay } = require('../lib/jobs');

test('production enables scheduled maintenance at 06:00 KST', () => {
  const config = require('../vercel.json');
  assert.equal(isRefreshPaused(), false);
  assert.deepEqual(config.crons, [{ path: '/api/refresh', schedule: '0 21 * * *' }]);
  assert.equal(config.functions['api/refresh-worker.js'].experimentalTriggers[0].topic, 'senior-jobs-refresh');
});

test('a direct request queues source collection and a Vercel cron request queues maintenance without a secret', async () => {
  const dispatched = [];
  const sandbox = { module: { exports: {} }, Date, console,
    process: { env: {} },
    require: name => ({ '../lib/runtime-store': { configured: () => true },
      '../lib/refresh-queue': { enqueue: async (day, _progress, sourceRefresh) => dispatched.push({ day, sourceRefresh }) },
      '../lib/jobs': { kstDay: () => '2026-11-13' },
      '../lib/refresh-policy': require('../lib/refresh-policy') }[name]) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/refresh'), 'utf8'), sandbox);
  let body;
  const response = { setHeader() {}, end(text) { body = JSON.parse(text); } };
  await sandbox.module.exports({ method: 'GET', headers: {} }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(body.state, 'queued');
  await sandbox.module.exports({ method: 'GET', headers: { 'user-agent': 'vercel-cron/1.0' } }, response);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(dispatched, [{ day: '2026-11-13', sourceRefresh: true }, { day: '2026-11-13', sourceRefresh: false }]);
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
