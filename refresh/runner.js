'use strict';
const crypto = require('node:crypto');
const { bundled } = require('../lib/job-context');
const { digest } = require('../lib/blob-store');
const { prepare } = require('./snapshot-refresh');
const { kstDay } = require('../lib/jobs');
const safeCodes = new Set(['SOURCE_KEY_NOT_CONFIGURED', 'UPSTREAM_DAILY_LIMIT', 'UPSTREAM_RATE_LIMIT', 'UPSTREAM_IP_DENIED',
  'UPSTREAM_KEY_REJECTED', 'UPSTREAM_KEY_EXPIRED', 'UNSAFE_OR_INVALID_XML', 'INVALID_TOTAL_COUNT', 'INVALID_SOURCE_ITEMS',
  'UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT', 'UPSTREAM_NETWORK_ERROR', 'UPSTREAM_HTTP_ERROR', 'UPSTREAM_TOO_LARGE',
  'PAGE_SEQUENCE_MISMATCH', 'INVALID_PAGE', 'TOTAL_CHANGED_DURING_SCAN', 'REPEATED_PAGE', 'MISSING_ID',
  'ID_CONTENT_CONFLICT', 'TOTAL_INCONSISTENT', 'INVALID_SCAN_PLAN', 'SNAPSHOT_TOO_LARGE', 'SCAN_TIME_BUDGET',
  'DETAIL_ID_MISMATCH', 'DOCUMENTED_DAILY_CALL_BUDGET', 'SOURCE_PAGE_SIZE_MISMATCH', 'NONFINAL_SHORT_PAGE', 'EMPTY_SOURCE_PAGE', 'REFRESH_LEASE_ACTIVE', 'DISCOVERY_REPEATED_PAGE_LIMIT']);
function errorCode(cause) { return safeCodes.has(cause.code) ? cause.code : 'STORAGE_UNAVAILABLE'; }
async function runRefresh({ store, fetchPage, now = () => new Date(), pageSize = 1000, maximumPages, schedulerEnabled = false }) {
  if (!Number.isInteger(maximumPages) || maximumPages < 1) throw Object.assign(new Error('INVALID_SCAN_PLAN'), { code: 'INVALID_SCAN_PLAN' });
  const started = now(), at = started.toISOString(), day = kstDay(started);
  let control = await store.readControl();
  if (control?.value.leaseUntil && Date.parse(control.value.leaseUntil) > started.getTime()) return { state: 'already_running' };
  if (control?.value.state === 'succeeded' && control.value.runDayKst === day) return { state: 'already_refreshed' };
  const lease = { state: 'running', leaseId: crypto.randomUUID(), leaseUntil: new Date(started.getTime() + 120000).toISOString(),
    runDayKst: day, lastAttemptAt: at, schedulerEnabled, errorCode: null };
  let claim;
  try { claim = await store.writeControl(lease, control?.etag); }
  catch { return { state: 'lease_not_acquired', errorCode: 'STORAGE_UNAVAILABLE' }; }
  let current, commitAttempted = false, preservation = true;
  try {
    current = await store.readCurrent();
    const previous = current?.value.snapshot || bundled.snapshot;
    const pages = [];
    for (let pageNo = 1; pageNo <= maximumPages; pageNo++) {
      if (now().getTime() - started.getTime() > 35000) { const cause = new Error(); cause.code = 'SCAN_TIME_BUDGET'; throw cause; }
      const page = await fetchPage(pageNo, pageSize);
      pages.push(page);
      prepare(previous, pages, now().toISOString(), pageSize);
      if (pageNo >= Math.max(1, Math.ceil(page.totalCount / pageSize))) break;
    }
    const observedAt = now().toISOString(), snapshot = prepare(previous, pages, observedAt, pageSize);
    const refreshState = { state: 'succeeded', schedulerEnabled, lastAttemptAt: at, lastSuccessfulAt: observedAt, errorCode: null };
    const envelope = { schemaVersion: 1, snapshot, sha256: digest(snapshot), refreshState };
    commitAttempted = true;
    try { await store.writeCurrent(envelope, current?.etag); }
    catch (cause) {
      let checked;
      try { checked = await store.readCurrent(); }
      catch { preservation = null; throw cause; }
      if (checked?.value.sha256 !== envelope.sha256) {
        preservation = checked?.value.sha256 === current?.value.sha256;
        throw cause;
      }
    }
    try { await store.writeControl({ ...lease, state: 'succeeded', leaseUntil: null, lastSuccessfulAt: observedAt }, claim.etag); }
    catch { /* The committed snapshot contains its successful run state. */ }
    return { state: 'succeeded', observedAt, storedListJobs: snapshot.jobs.length, coverageVerified: snapshot.metadata.coverageVerified,
      scope: snapshot.metadata.refresh };
  } catch (cause) {
    const code = errorCode(cause);
    try { await store.writeControl({ ...lease, state: 'failed', leaseUntil: null, errorCode: code }, claim.etag); }
    catch { /* Storage failure cannot overwrite the prior committed snapshot. */ }
    return { state: 'failed', errorCode: code, previousSnapshotPreserved: commitAttempted ? preservation : true };
  }
}
module.exports = { runRefresh, errorCode };
