'use strict';
const { productionStore, writeCheckpoint } = require('../lib/blob-store');
const { runDailyChunk } = require('./daily');
const { createSource } = require('./source');
const { errorCode } = require('./runner');
const { enqueue, retryable } = require('../lib/refresh-queue');
const { kstDay } = require('../lib/jobs');
const { isRefreshPaused, pausedResult } = require('../lib/refresh-policy');
async function executeChunk(day, { storeFactory = productionStore, chunk = runDailyChunk,
  sourceFactory = createSource, dispatch = enqueue, log = event => console.log(JSON.stringify(event)),
  isPaused = isRefreshPaused } = {}) {
  if (isPaused()) {
    log({ event: 'refresh_paused', state: 'paused_by_request' });
    return pausedResult();
  }
  if (day !== kstDay(new Date())) return { state: 'stale_delivery_ignored' };
  let store, phase = 'store';
  const started = Date.now();
  try {
    store = await storeFactory();
    phase = 'chunk';
    const source = sourceFactory(process.env.DATA_GO_KR_SERVICE_KEY, fetch, {
      timeoutMs: 15000, onEvent: event => log({ event: 'source_request', ...event }) });
    const result = await chunk({ store, source,
      schedulerEnabled: true, budgetMs: 20000, onEvent: log });
    log({ event: 'refresh_chunk', state: result.state, errorCode: result.errorCode || null,
      confirmedIds: result.progress?.confirmedIds, targetIds: result.progress?.targetIds, elapsedMs: Date.now() - started });
    if (!result.continue) {
      if (result.state === 'already_running') throw Object.assign(new Error('REFRESH_LEASE_ACTIVE'), { code: 'REFRESH_LEASE_ACTIVE' });
      if (retryable(result.errorCode)) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
      return result;
    }
    phase = 'continuation';
    if (isPaused()) return pausedResult();
    const continuationStarted = Date.now();
    await dispatch(kstDay(new Date()), result.progress);
    log({ event: 'refresh_continuation', delivery: 'private_queue', state: 'queued',
      elapsedMs: Date.now() - continuationStarted, completionVerified: false });
    return result;
  } catch (cause) {
    if (isPaused()) return pausedResult();
    const code = phase === 'continuation' ? 'QUEUE_DISPATCH_FAILED' : errorCode(cause);
    log({ event: 'refresh_task_failed', phase, errorCode: code, elapsedMs: Date.now() - started });
    if (store) try {
      const state = await store.readControl();
      if (!(Date.parse(state?.value.leaseUntil || '') > Date.now())) {
        const checkpoint = await writeCheckpoint(store, { ...state?.value, lastAttemptAt: new Date().toISOString(), leaseUntil: null,
          schedulerEnabled: true, state: 'paused_incomplete', errorCode: code }, state?.etag);
        log({ event: 'refresh_error_checkpoint', checkpointSaved: true, errorCode: code, checkpointCompact: checkpoint.compact, controlBytes: checkpoint.bytes });
      }
    } catch { log({ event: 'refresh_error_checkpoint', checkpointSaved: false, errorCode: code }); }
    throw Object.assign(new Error(code), { code });
  }
}
module.exports = { executeChunk };
