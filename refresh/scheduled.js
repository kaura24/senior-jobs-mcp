'use strict';
const { runPublicChunk } = require('./public-daily');
const { eligibility, kstDay } = require('../lib/jobs');
const { digest, StoreFailure } = require('../lib/snapshot-store');

async function runScheduledChunk(options) {
  const { store, now = () => new Date(), schedulerEnabled = true } = options;
  const at = now().toISOString(), day = kstDay(now());
  const [current, control] = await Promise.all([store.readCurrent(), store.readControl()]);
  if (!current) throw new StoreFailure('D1_DATA_NOT_COLLECTED');
  const plan = current.value.runPlan;
  // Only finish the explicitly started initial baseline; never start a daily national scan.
  if (plan?.kind === 'official_public' && plan.phase !== 'done' && plan.runDayKst === day) {
    return runPublicChunk(options);
  }
  if (Date.parse(control?.value.leaseUntil || '') > now().getTime()) return { state: 'already_running', continue: false };
  if (current.value.localMaintenance?.dayKst === day) {
    if (control?.value.state !== 'local_maintenance_completed') await store.writeControl({ state: 'local_maintenance_completed',
      schedulerEnabled, lastAttemptAt: current.value.localMaintenance.completedAt, leaseUntil: null, sourceRequests: 0, errorCode: null }, control?.etag);
    return { state: 'already_completed', continue: false, sourceRequests: 0 };
  }
  const claim = await store.writeControl({ state: 'running', schedulerEnabled, lastAttemptAt: at,
    leaseUntil: new Date(now().getTime() + 90000).toISOString(), sourceRequests: 0, errorCode: null }, control?.etag);
  const envelope = structuredClone(current.value), metadata = envelope.snapshot.metadata;
  const verified = metadata.refresh?.queryableIds || [];
  const eligibleIds = new Set(envelope.snapshot.jobs.filter(row => eligibility(row, now()).eligible).map(row => row.jobId));
  const active = verified.filter(id => eligibleIds.has(id));
  metadata.refresh = { ...metadata.refresh, queryableIds: active };
  metadata.syncPolicy = { mode: 'awaiting_verified_change_feed', automaticFullScan: false,
    automaticSourceRequests: false, sourceDateFilterVerified: false, sourceWatermark: null,
    lastSuccessfulSourceScanAt: envelope.refreshState.lastSuccessfulAt || null, lastLocalMaintenanceAt: at,
    reason: 'SOURCE_MODIFIED_SINCE_QUERY_NOT_VERIFIED' };
  metadata.freshnessById ||= {};
  for (const row of envelope.snapshot.jobs) {
    metadata.freshnessById[row.jobId] ||= { sourceCreatedAt: null, sourceUpdatedAt: null,
      firstObservedAt: null, lastCheckedAt: metadata.sourceObservedById?.[row.jobId] || metadata.observedAt,
      lastContentChangedAt: null };
  }
  envelope.localMaintenance = { dayKst: day, completedAt: at, sourceRequests: 0,
    expiredFromActive: verified.length - active.length, activeJobs: active.length };
  envelope.refreshState = { ...envelope.refreshState, state: 'local_maintenance_completed',
    schedulerEnabled, lastAttemptAt: at, errorCode: null };
  envelope.sha256 = digest(envelope.snapshot);
  try {
    await store.writeCurrent(envelope, current.etag);
    await store.writeControl({ state: 'local_maintenance_completed', schedulerEnabled, lastAttemptAt: at,
      leaseUntil: null, sourceRequests: 0, errorCode: null }, claim.etag);
  } catch (cause) {
    await store.writeControl({ state: 'paused_incomplete', schedulerEnabled, lastAttemptAt: at,
      leaseUntil: null, sourceRequests: 0, errorCode: cause.code || 'STORAGE_UNAVAILABLE' }, claim.etag);
    throw cause;
  }
  return { state: 'local_maintenance_completed', continue: false, sourceRequests: 0,
    expiredFromActive: envelope.localMaintenance.expiredFromActive, activeJobs: active.length };
}
module.exports = { runScheduledChunk };
