'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { executeChunk } = require('../refresh/task');
const { enqueue, retry, queue } = require('../lib/refresh-queue');
const { pausedResult } = require('../lib/refresh-policy');
const { kstDay, searchJobs } = require('../lib/jobs');
const { withDataset, bundled } = require('../lib/job-context');

test('paused GET and POST refresh retain authorization and never create storage or queue work', async () => {
  const forbidden = () => { assert.fail('paused refresh must not access storage or queue'); };
  const sandbox = { module: { exports: {} }, Buffer, Date,
    process: { env: { CRON_SECRET: 'fixture-secret' } },
    require: name => ({ 'node:crypto': require('node:crypto'), '../lib/blob-store': { productionStore: forbidden },
      '../lib/refresh-queue': { enqueue: forbidden }, '../lib/jobs': { kstDay: forbidden },
      '../lib/refresh-policy': require('../lib/refresh-policy') }[name]) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/refresh'), 'utf8'), sandbox);
  for (const method of ['GET', 'POST']) {
    let body;
    const response = { setHeader() {}, end(text) { body = JSON.parse(text); } };
    await sandbox.module.exports({ method, headers: { authorization: 'Bearer fixture-secret', 'x-refresh-run-day': '2000-01-01' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body, pausedResult());
    await sandbox.module.exports({ method, headers: { authorization: 'Bearer wrong' } }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(body.errorCode, 'UNAUTHORIZED');
  }
});

test('current, stale and duplicate queued deliveries finish before any source, storage or continuation', async () => {
  const forbidden = () => { assert.fail('paused chunk must have no side effects'); };
  for (const day of [kstDay(new Date()), '2000-01-01', kstDay(new Date())]) {
    assert.deepEqual(await executeChunk(day, { storeFactory: forbidden, sourceFactory: forbidden,
      chunk: forbidden, dispatch: forbidden, log: () => {} }), pausedResult());
  }
});

test('the retained queue callback resolves for retry deliveries without collecting or writing', async () => {
  let callback, options;
  const sandbox = { module: { exports: {} }, console: { log() {} }, require: name => ({
    '../lib/refresh-queue': { queue: { handleNodeCallback(handler, opts) { callback = handler; options = opts; return handler; } }, retry },
    '../refresh/task': { executeChunk } }[name]) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/refresh-worker'), 'utf8'), sandbox);
  await callback({ dayKst: kstDay(new Date()) }, { deliveryCount: 4 });
  assert.deepEqual(options.retry({ code: 'UPSTREAM_TIMEOUT' }, { deliveryCount: 4 }), { acknowledge: true });
});

test('paused direct enqueue and retry do not send or schedule any follow-up message', async () => {
  const originalSend = queue.send;
  queue.send = () => { assert.fail('paused enqueue must not send'); };
  try {
    assert.deepEqual(await enqueue(kstDay(new Date())), pausedResult());
    assert.deepEqual(await enqueue(kstDay(new Date()), { sourceCalls: 3, phase: 'revalidation', attemptedIds: 2 }), pausedResult());
    for (const deliveryCount of [1, 4, 5]) {
      assert.deepEqual(retry({ code: 'UPSTREAM_TIMEOUT' }, { deliveryCount }), { acknowledge: true });
      assert.deepEqual(retry({ code: 'QUEUE_DISPATCH_FAILED' }, { deliveryCount }), { acknowledge: true });
    }
  } finally { queue.send = originalSend; }
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

test('paused query reports preserved source dates, prior state and last success without mutating the dataset', () => {
  const dataset = { snapshot: structuredClone(bundled.snapshot), refreshState: { ...bundled.refreshState,
    state: 'in_progress_partial', schedulerEnabled: true, lastSuccessfulAt: '2026-10-11T00:00:00Z' } };
  const before = JSON.stringify(dataset);
  const result = withDataset(dataset, () => searchJobs({ limit: 1 }));
  assert.equal(result.context.statusRevalidation.state, 'paused_by_request');
  assert.equal(result.context.statusRevalidation.schedulerEnabled, false);
  assert.equal(result.context.statusRevalidation.refreshObservedState, 'in_progress_partial');
  assert.equal(result.context.statusRevalidation.lastSuccessfulAt, '2026-10-11T00:00:00Z');
  assert.equal(result.context.statusRevalidation.sourceObservationAt, dataset.snapshot.metadata.observedAt);
  assert.equal(result.context.referenceDayKst, dataset.snapshot.metadata.referenceDayKst);
  assert.equal(JSON.stringify(dataset), before);
});

test('production configuration removes the schedule and retains the private queue consumer and MCP', () => {
  const config = require('../vercel.json');
  assert.deepEqual(config.crons, []);
  assert.equal(config.functions['api/refresh-worker.js'].experimentalTriggers[0].topic, 'senior-jobs-refresh');
  assert.ok(config.functions['api/mcp.js']);
});
