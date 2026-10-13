'use strict';
const crypto = require('node:crypto');
const { bundled } = require('./job-context');
const { withinDeadline } = require('./deadline');
const maximumBytes = 2_000_000;
let sdkPromise;
const sdk = () => sdkPromise ||= import('@vercel/blob');
const path = 'senior-jobs/current.json';
const controlPath = 'senior-jobs/control.json';

class StoreFailure extends Error { constructor(code) { super(code); this.code = code; } }
const errorClasses = new Set(['BlobError', 'BlobPreconditionFailedError', 'BlobAccessError', 'BlobOidcEnvironmentNotAllowedError',
  'BlobServiceRateLimited', 'BlobStoreSuspendedError', 'BlobStoreNotFoundError', 'BlobServiceNotAvailable', 'BlobRequestAbortedError',
  'StoreFailure', 'TypeError', 'SyntaxError', 'Error', 'DOMException', 'SocketError']);
const networkCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function safeFailure(cause) {
  const type = cause?.constructor?.name;
  const status = type === 'BlobError' ? /^(?:Vercel Blob: )?Failed to fetch blob: ([1-5]\d{2})(?: |$)/.exec(cause.message || '')?.[1] : null;
  const network = networkCodes.has(cause?.code) ? cause.code : networkCodes.has(cause?.cause?.code) ? cause.cause.code : null;
  return { sdkErrorClass: errorClasses.has(type) ? type : 'UNRECOGNIZED', httpStatus: status ? Number(status) : null,
    networkCode: network, errorName: ['AbortError','TimeoutError','SyntaxError','TypeError','Error','InvalidStateError'].includes(cause?.name) ? cause.name : null,
    errorCode: cause instanceof StoreFailure ? cause.code : null };
}
function retryableRead(cause, trace) {
  const safe = safeFailure(cause);
  return !!safe.networkCode || (cause instanceof SyntaxError && trace.expectedBytes > trace.receivedBytes)
    || (safe.httpStatus !== null && (safe.httpStatus === 408 || safe.httpStatus === 429 || safe.httpStatus >= 500));
}
function digest(snapshot) { return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
function refreshCycleDay(at) { return new Date(Date.parse(at) + 3 * 3600000).toISOString().slice(0, 10); }
function planCycle(plan) { return plan?.refreshCycleKst || (plan?.startedAt ? refreshCycleDay(plan.startedAt) : plan?.runDayKst); }
function planIsAtLeastAsNew(a, b) {
  if (!a) return false;
  if (!b) return true;
  const aCycle = `${a.runDayKst}:${planCycle(a)}`, bCycle = `${b.runDayKst}:${planCycle(b)}`;
  return aCycle > bCycle || (aCycle === bCycle && a.calls >= b.calls);
}
function revalidationScope(plan) {
  if (!plan?.targetIds || !plan.outcomes) return null;
  const counts = {}, entries = plan.targetIds.map(id => plan.outcomes[id]).filter(Boolean);
  for (const entry of entries) if (/^(verified_|unverified_)[a-z_]+$/.test(entry.state)) counts[entry.state] = (counts[entry.state] || 0) + 1;
  const accepting = counts.verified_accepting || 0, ineligible = counts.verified_ineligible || 0, periodOnly = counts.verified_period_ineligible || 0;
  const confirmedIds = accepting + ineligible + periodOnly, unverifiedIds = plan.targetIds.length - confirmedIds;
  return { state: unverifiedIds === 0 ? 'verified' : 'incomplete', dayKst: plan.runDayKst, targetIds: plan.targetIds.length,
    confirmedIds, unverifiedIds, verifiedAt: unverifiedIds === 0 ? entries.map(entry => entry.checkedAt).filter(Boolean).sort().at(-1) || plan.startedAt : null,
    verifiedAtBasis: 'latest_required_id_source_observation', verificationEvidence: {
      statusAndPeriodConfirmed: accepting + ineligible, statusAndPeriodAccepting: accepting, statusAndPeriodIneligible: ineligible,
      periodOnlyIneligible: periodOnly, periodOnlyAccepting: 0, unverifiedIds, outcomesByState: counts } };
}
function validateEnvelope(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.snapshot?.jobs) || !value.snapshot.metadata || !value.snapshot.detailSummaries
    || !value.refreshState || value.sha256 !== digest(value.snapshot)) throw new StoreFailure('SNAPSHOT_INVALID');
  const ids = new Set();
  for (const row of value.snapshot.jobs) {
    if (typeof row.jobId !== 'string' || !row.jobId.trim() || ids.has(row.jobId)) throw new StoreFailure('SNAPSHOT_INVALID');
    ids.add(row.jobId);
  }
  return value;
}
async function readJson(sdkClient, pathname, timeoutMs, onEvent = () => {}, operation) {
  const trace = { phase: 'get', attempt: 1, httpStatus: null, receivedBytes: 0, expectedBytes: null };
  return withinDeadline(async abortSignal => {
  for (let attempt = 1; attempt <= 2; attempt++) {
  Object.assign(trace, { phase: 'get', attempt, httpStatus: null, receivedBytes: 0, expectedBytes: null });
  const started = Date.now();
  try {
  const result = await sdkClient.get(pathname, { access: 'private', useCache: false, abortSignal, headers: { 'accept-encoding': 'identity' } });
  if (!result) return null;
  trace.httpStatus = result.statusCode; trace.expectedBytes = Number.isFinite(result.blob.size) ? result.blob.size : null;
  if (result.statusCode !== 200 || !result.stream || result.blob.size > maximumBytes) throw new StoreFailure('STORAGE_UNAVAILABLE');
  trace.phase = 'body';
  const reader = result.stream.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; trace.receivedBytes = size;
      if (size > maximumBytes) { await reader.cancel(); throw new StoreFailure('SNAPSHOT_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    trace.phase = 'parse';
    const parsed = { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: result.blob.etag };
    if (attempt > 1) onEvent({ event: 'blob_read_recovered', operation, attempt, elapsedMs: Date.now() - started,
      receivedBytes: trace.receivedBytes, httpStatus: trace.httpStatus });
    return parsed;
  } finally { reader.releaseLock(); }
  } catch (cause) {
    const safe = safeFailure(cause), again = attempt < 2 && !abortSignal.aborted && retryableRead(cause, trace);
    onEvent({ event: 'blob_read_attempt_failed', operation, ...trace, ...safe, httpStatus: trace.httpStatus ?? safe.httpStatus,
      elapsedMs: Date.now() - started, willRetry: again });
    if (!again) throw cause;
  }
  }
  }, timeoutMs, () => Object.assign(new StoreFailure('STORAGE_UNAVAILABLE'), { readPhase: trace.phase, readAttempt: trace.attempt }));
}
async function writeJson(sdkClient, pathname, value, etag, timeoutMs) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maximumBytes) throw new StoreFailure('SNAPSHOT_TOO_LARGE');
  return withinDeadline(abortSignal => sdkClient.put(pathname, body, { access: 'private', contentType: 'application/json', addRandomSuffix: false,
    allowOverwrite: !!etag, ...(etag ? { ifMatch: etag } : {}), abortSignal }), timeoutMs, () => new StoreFailure('STORAGE_UNAVAILABLE'));
}
function createStore(sdkClient, { timeoutMs = 5000, onEvent = () => {} } = {}) {
  async function operation(name, task, etag) {
    const started = Date.now();
    try { return await task(); }
    catch (cause) {
      onEvent({ event: 'blob_operation_failed', operation: name, elapsedMs: Date.now() - started,
        ...safeFailure(cause), readPhase: cause?.readPhase || null, readAttempt: cause?.readAttempt || null, ifMatchPresent: !!etag,
        etagWeak: typeof etag === 'string' && etag.startsWith('W/'), etagQuoted: typeof etag === 'string' && etag.startsWith('"') });
      throw cause;
    }
  }
  return {
    readCurrent: () => operation('readCurrent', async () => { const row = await readJson(sdkClient, path, timeoutMs, onEvent, 'readCurrent'); if (row) validateEnvelope(row.value); return row; }),
    readControl: () => operation('readControl', () => readJson(sdkClient, controlPath, timeoutMs, onEvent, 'readControl')),
    writeCurrent: (value, etag) => operation('writeCurrent', () => { validateEnvelope(value); return writeJson(sdkClient, path, value, etag, timeoutMs); }, etag),
    writeControl: (value, etag) => operation('writeControl', () => writeJson(sdkClient, controlPath, value, etag, timeoutMs), etag),
  };
}
async function productionStore() { return createStore(await sdk(), { onEvent: event => console.log(JSON.stringify(event)) }); }
async function writeCheckpoint(store, state, etag) {
  try {
    const result = await store.writeControl(state, etag);
    return { ...result, compact: false, bytes: Buffer.byteLength(JSON.stringify(state)) };
  } catch (cause) {
    if (cause.code !== 'SNAPSHOT_TOO_LARGE') throw cause;
    const durable = await store.readCurrent(), committed = durable?.value.runPlan;
    const { plan: omitted, ...summary } = state;
    const attemptDayKst = state.plan?.runDayKst || state.attemptDayKst || state.runDayKst || committed?.runDayKst;
    const attemptSourceCalls = Math.max(state.plan?.runDayKst === attemptDayKst ? state.plan.calls || 0 : 0,
      state.attemptDayKst === attemptDayKst ? state.attemptSourceCalls || 0 : 0,
      committed?.runDayKst === attemptDayKst ? committed.calls || 0 : 0);
    const compact = { ...summary, runDayKst: committed?.runDayKst || state.plan?.runDayKst || state.runDayKst,
      resumeSource: 'current_snapshot', attemptDayKst, attemptSourceCalls,
      dailyProgress: durable?.value.snapshot.metadata.refresh?.dailyRevalidation || null };
    const result = await store.writeControl(compact, etag);
    return { ...result, compact: true, bytes: Buffer.byteLength(JSON.stringify(compact)) };
  }
}
let lastGood = bundled;
async function loadDataset(store, configured = !!process.env.BLOB_STORE_ID, now = () => new Date()) {
  if (!configured) return bundled;
  let currentReadFailed = false, checkpointReadState = 'unavailable';
  try {
    const [currentRead, controlRead] = await Promise.allSettled([store.readCurrent(), store.readControl()]);
    checkpointReadState = controlRead.status === 'fulfilled' ? controlRead.value?.value ? 'available' : 'absent' : 'unavailable';
    if (currentRead.status === 'rejected') { currentReadFailed = true; throw currentRead.reason; }
    const current = currentRead.value, control = controlRead.status === 'fulfilled' ? controlRead.value : null;
    const envelope = current?.value;
    const base = envelope ? { snapshot: envelope.snapshot, refreshState: { ...envelope.refreshState, storageState: 'private_blob' } }
      : { snapshot: bundled.snapshot, refreshState: { ...bundled.refreshState, state: 'awaiting_first_refresh', storageState: 'private_blob_empty' } };
    Object.assign(base.refreshState, { checkpointReadState,
      snapshotReadState: 'available',
      storageReadErrorCode: controlRead.status === 'rejected' ? 'CONTROL_READ_UNAVAILABLE' : null,
      progressEvidence: control?.value ? 'latest_durable_checkpoint' : 'published_snapshot' });
    const candidateAttempt = control?.value;
    const checkpoint = candidateAttempt?.plan || (candidateAttempt?.resumeSource === 'current_snapshot' && candidateAttempt.dailyProgress ?
      { runDayKst: candidateAttempt.dailyProgress.dayKst, refreshCycleKst: candidateAttempt.dailyProgress.refreshCycleKst,
        startedAt: candidateAttempt.lastAttemptAt, calls: candidateAttempt.dailyProgress.sourceCalls } : null), committed = envelope?.runPlan;
    const attempt = checkpoint && committed && !planIsAtLeastAsNew(checkpoint, committed) ? null : candidateAttempt;
    if (!attempt) base.refreshState.progressEvidence = 'published_snapshot';
    base.refreshState.dailyRevalidation = attempt?.dailyProgress || envelope?.snapshot.metadata.refresh?.dailyRevalidation || null;
    const publishedScope = envelope?.snapshot.metadata.refresh?.existingIdsRevalidation;
    const derivedScope = publishedScope || revalidationScope(committed);
    base.refreshState.existingIdsRevalidation = derivedScope?.state === 'verified' ? { ...derivedScope, state: 'succeeded',
      publishedAt: envelope.refreshState.lastPublishedAt || envelope.snapshot.metadata.observedAt } : derivedScope;
    const outcomes = attempt?.plan?.outcomes || envelope?.runPlan?.outcomes;
    if (outcomes && base.refreshState.dailyRevalidation) {
      const counts = {};
      for (const entry of Object.values(outcomes)) {
        const state = entry.state;
        if (/^(verified_|unverified_)[a-z_]+$/.test(state)) counts[state] = (counts[state] || 0) + 1;
      }
      const accepting = counts.verified_accepting || 0, ineligible = counts.verified_ineligible || 0,
        periodOnly = counts.verified_period_ineligible || 0;
      base.refreshState.dailyRevalidation = { ...base.refreshState.dailyRevalidation, verificationEvidence: {
        statusAndPeriodConfirmed: accepting + ineligible, statusAndPeriodAccepting: accepting,
        statusAndPeriodIneligible: ineligible, periodOnlyIneligible: periodOnly, periodOnlyAccepting: 0,
        unverifiedIds: base.refreshState.dailyRevalidation.targetIds - accepting - ineligible - periodOnly, outcomesByState: counts } };
    }
    const latestCheckpoint = checkpoint && committed && planIsAtLeastAsNew(checkpoint, committed);
    if (attempt?.lastAttemptAt && (latestCheckpoint || !base.refreshState.lastSuccessfulAt || attempt.lastAttemptAt > base.refreshState.lastSuccessfulAt)) {
      Object.assign(base.refreshState, { state: attempt.state, lastAttemptAt: attempt.lastAttemptAt, errorCode: attempt.errorCode,
        schedulerEnabled: attempt.schedulerEnabled === true });
      if (attempt.state === 'running' && !(Date.parse(attempt.leaseUntil || '') > now().getTime())) {
        Object.assign(base.refreshState, { state: 'interrupted_incomplete', errorCode: 'LEASE_EXPIRED_WITHOUT_CHECKPOINT' });
      }
    }
    if (!attempt && candidateAttempt?.state === 'running' && checkpoint?.runDayKst === committed?.runDayKst && committed?.phase !== 'done'
      && planCycle(checkpoint) === planCycle(committed)
      && !(Date.parse(candidateAttempt.leaseUntil || '') > now().getTime())) {
      Object.assign(base.refreshState, { state: 'interrupted_incomplete', errorCode: 'LEASE_EXPIRED_WITHOUT_CHECKPOINT' });
    }
    lastGood = base;
    return base;
  } catch {
    return { snapshot: lastGood.snapshot, refreshState: { ...lastGood.refreshState, state: 'storage_unavailable',
      storageState: lastGood === bundled ? 'bundled_fallback' : 'last_successful_in_process_cache', errorCode: 'STORAGE_UNAVAILABLE',
      storageReadErrorCode: currentReadFailed ? 'CURRENT_READ_UNAVAILABLE' : 'STORAGE_UNAVAILABLE', snapshotReadState: 'unavailable',
      checkpointReadState, refreshObservedState: lastGood.refreshState.state, progressEvidence: 'cached_snapshot' } };
  }
}
module.exports = { createStore, productionStore, loadDataset, validateEnvelope, digest, revalidationScope, writeCheckpoint,
  refreshCycleDay, planCycle, planIsAtLeastAsNew, StoreFailure };
