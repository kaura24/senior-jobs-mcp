'use strict';
const crypto = require('node:crypto');
const { bundled } = require('../lib/job-context');
const { digest, revalidationScope, writeCheckpoint, refreshCycleDay, planCycle, planIsAtLeastAsNew } = require('../lib/blob-store');
const { eligibility, dateField, kstDay } = require('../lib/jobs');
const { errorCode } = require('./runner');
const fields = ['jobId','recrtTitle','oranNm','organYn','workPlcNm','workPlc','frDd','toDd','deadline','emplymShp','emplymShpNm','acptMthd','jobcls','jobclsNm','stmId','stmNm'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const publicRow = row => Object.fromEntries(fields.filter(key => typeof row[key] === 'string').map(key => [key, row[key]]));
const verified = item => item?.state?.startsWith('verified_') === true;

function createDay(snapshot, prior, at) {
  const day = kstDay(new Date(at));
  const resume = prior?.discovery && !prior.discovery.ended && (!prior.discovery.errorCode || ['TOTAL_CHANGED_DURING_SCAN', 'REPEATED_PAGE', 'DISCOVERY_REPEATED_PAGE_LIMIT'].includes(prior.discovery.errorCode));
  const candidate = structuredClone(snapshot);
  candidate.metadata.sourceObservedById = Object.fromEntries(snapshot.jobs.map(row => [row.jobId,
    snapshot.metadata.sourceObservedById?.[row.jobId] || snapshot.metadata.observedAt]));
  candidate.metadata.regionHistoryById = Object.fromEntries(snapshot.jobs.map(row => [row.jobId,
    snapshot.metadata.regionHistoryById?.[row.jobId] || bundled.snapshot.metadata.regionHistoryById?.[row.jobId]]).filter(([, value]) => value));
  candidate.metadata.regionObservedById = Object.fromEntries(snapshot.jobs.map(row => [row.jobId,
    snapshot.metadata.regionObservedById?.[row.jobId] || (candidate.metadata.regionHistoryById[row.jobId]?.rawValue === row.workPlcNm
      ? candidate.metadata.regionHistoryById[row.jobId].observedAt : candidate.metadata.sourceObservedById[row.jobId])]));
  const discovery = resume ? structuredClone(prior.discovery) : { nextPage: 1, total: null, hashes: {}, scannedRows: 0, ended: false,
    cycleStartedAt: at, uniqueCoverageVerified: false };
  if (['TOTAL_CHANGED_DURING_SCAN', 'REPEATED_PAGE', 'DISCOVERY_REPEATED_PAGE_LIMIT'].includes(discovery.errorCode)) delete discovery.errorCode;
  discovery.consecutiveDuplicatePages = 0;
  return { runDayKst: day, refreshCycleKst: refreshCycleDay(at), startedAt: at, phase: 'revalidation', targetIds: snapshot.jobs.map(row => row.jobId),
    index: 0, pending: null, outcomes: {}, candidate, sourceVerifiedIds: {}, calls: prior?.runDayKst === day ? prior.calls : 0, chunks: 0, headObservedToday: false,
    discovery, errorCode: null };
}
function progress(plan) {
  const attempted = plan.targetIds.filter(id => plan.outcomes[id]);
  const confirmed = plan.targetIds.filter(id => verified(plan.outcomes[id]));
  return { dayKst: plan.runDayKst, refreshCycleKst: planCycle(plan), targetIds: plan.targetIds.length, attemptedIds: attempted.length,
    confirmedIds: confirmed.length, unverifiedIds: plan.targetIds.filter(id => !verified(plan.outcomes[id])),
    complete: confirmed.length === plan.targetIds.length, attemptsFinished: plan.index === plan.targetIds.length,
    sourceCalls: plan.calls, phase: plan.phase, discoveryNextPage: plan.discovery.nextPage,
    discoveryPagesObserved: Object.keys(plan.discovery.hashes).length, discoveryPageTraversalEnded: plan.discovery.ended,
    discoveryUniqueCoverageVerified: false, discoveryValidationFailure: plan.discovery.validationFailure || null,
    discoveryCoverageGaps: plan.discovery.coverageGaps || [], discoveryDuplicatePages: plan.discovery.duplicatePages || 0,
    discoverySkippedDuplicateSlots: plan.discovery.skippedDuplicateSlots || 0, discoveryTotalCount: plan.discovery.total,
    discoveryScannedRows: plan.discovery.scannedRows, discoveryConsecutiveDuplicatePages: plan.discovery.consecutiveDuplicatePages || 0,
    sourceDiagnostics: plan.sourceDiagnostics || null, errorCode: plan.errorCode };
}
function outcome(plan, id, state, at) { plan.outcomes[id] = { state, checkedAt: at }; }
function pruneObservations(plan) {
  const ids = new Set(plan.candidate.jobs.map(row => row.jobId));
  plan.sourceVerifiedIds = Object.fromEntries(Object.entries(plan.sourceVerifiedIds || {}).filter(([id]) => ids.has(id)));
  plan.candidate.metadata.sourceObservedById = Object.fromEntries(Object.entries(plan.candidate.metadata.sourceObservedById || {}).filter(([id]) => ids.has(id)));
  plan.candidate.metadata.regionHistoryById = Object.fromEntries(Object.entries(plan.candidate.metadata.regionHistoryById || {}).filter(([id]) => ids.has(id)));
  plan.candidate.metadata.regionObservedById = Object.fromEntries(Object.entries(plan.candidate.metadata.regionObservedById || {}).filter(([id]) => ids.has(id)));
}
function observe(plan, input, at, origin) {
  const row = publicRow(input), id = row.jobId;
  if (!id?.trim()) fail('MISSING_ID');
  const valid = eligibility(row, new Date(at));
  const from = dateField(row.frDd), to = dateField(row.toDd);
  const knownPeriod = from && to && from <= to;
  if (!knownPeriod || !row.deadline?.trim()) {
    if (plan.targetIds.includes(id)) outcome(plan, id, 'unverified_source_fields', at);
    return;
  }
  const previous = plan.candidate.jobs.find(old => old.jobId === id);
  if (previous?.workPlcNm?.trim() && previous.workPlcNm !== row.workPlcNm) {
    plan.candidate.metadata.regionHistoryById ||= {};
    const known = plan.candidate.metadata.regionHistoryById[id], lastObservedAt = plan.candidate.metadata.regionObservedById?.[id] || plan.candidate.metadata.sourceObservedById?.[id];
    if (!(known?.rawValue === previous.workPlcNm && known.workPlc === (previous.workPlc || null)
      && (!lastObservedAt || Date.parse(lastObservedAt) <= Date.parse(known.observedAt)))) {
      plan.candidate.metadata.regionHistoryById[id] = { sourceField: 'workPlcNm', rawValue: previous.workPlcNm,
        workPlc: previous.workPlc || null, observedAt: lastObservedAt || plan.candidate.metadata.observedAt,
        source: 'previous_published_source_list' };
    }
  }
  const rows = plan.candidate.jobs.filter(old => old.jobId !== id);
  if (valid.eligible) rows.push(row);
  plan.candidate.jobs = rows;
  plan.candidate.metadata.sourceObservedById ||= {};
  if (valid.eligible) {
    plan.candidate.metadata.sourceObservedById[id] = at;
    plan.candidate.metadata.regionObservedById ||= {}; plan.candidate.metadata.regionObservedById[id] = at;
    plan.sourceVerifiedIds[id] = at;
  } else {
    delete plan.candidate.metadata.sourceObservedById[id];
    delete plan.sourceVerifiedIds[id];
    delete plan.candidate.metadata.regionHistoryById?.[id]; delete plan.candidate.metadata.regionObservedById?.[id];
  }
  if (plan.targetIds.includes(id)) outcome(plan, id, valid.eligible ? 'verified_accepting' : 'verified_ineligible', at);
  if (origin === 'discovery') plan.discovery.latestObservationAt = at;
}
function recordTotal(history, totalCount, pageNo, at) {
  if (history.total !== null && history.total !== totalCount) {
    history.sourceTotalsChanged = true;
    history.totalChanges ||= [];
    history.totalChanges.push({ pageNo, previousTotal: history.total, totalCount, observedAt: at });
    if (history.totalChanges.length > 20) history.totalChanges.shift();
  }
  history.total = totalCount;
}
function recordGap(history, pageNo) {
  const ranges = [...(history.coverageGaps || []), { fromPage: pageNo, toPage: pageNo, reason: 'repeated_source_page', uniqueMissingIds: 'unknown' }]
    .sort((a, b) => a.fromPage - b.fromPage);
  history.coverageGaps = [];
  for (const range of ranges) {
    const last = history.coverageGaps.at(-1);
    if (last && range.fromPage <= last.toPage + 1) last.toPage = Math.max(last.toPage, range.toPage);
    else history.coverageGaps.push({ ...range });
  }
}
function validatePage(page, pageNo, pageSize, history, evolving = false, at) {
  if (page.resultCode && !['00', '0000', '0'].includes(String(page.resultCode))) fail('UPSTREAM_ERROR');
  if (page.pageNo !== pageNo || (page.reportedPageNo && Number(page.reportedPageNo) !== pageNo)) fail('PAGE_SEQUENCE_MISMATCH');
  if (!Number.isInteger(page.totalCount) || page.totalCount < 0 || !Array.isArray(page.items) || page.items.length > pageSize) fail('INVALID_PAGE');
  if (page.reportedNumOfRows && Number(page.reportedNumOfRows) !== pageSize) fail('SOURCE_PAGE_SIZE_MISMATCH');
  if (page.totalCount > 0 && page.items.length === 0 && !(evolving && history.total !== null
    && page.totalCount < history.total && pageNo > Math.ceil(page.totalCount / pageSize))) fail('EMPTY_SOURCE_PAGE');
  if (pageNo < Math.ceil(page.totalCount / pageSize) && page.items.length < pageSize) fail('NONFINAL_SHORT_PAGE');
  if (!evolving && history.total !== null && history.total !== page.totalCount) fail('TOTAL_CHANGED_DURING_SCAN');
  const rows = page.items.map(publicRow), fingerprint = hash(rows), idSetDigest = hash([...new Set(rows.map(row => row.jobId))].sort());
  const unique = new Map();
  for (const row of rows) {
    if (!row.jobId?.trim()) fail('MISSING_ID');
    if (unique.has(row.jobId) && hash([unique.get(row.jobId)]) !== hash([row])) fail('ID_CONTENT_CONFLICT');
    unique.set(row.jobId, row);
  }
  const sameContent = rows.length ? Object.entries(history.hashes).find(([number, value]) => Number(number) !== pageNo && value === fingerprint) : null;
  const sameIds = evolving && rows.length ? Object.entries(history.idSetHashes || {}).find(([number, value]) => Number(number) !== pageNo && value === idSetDigest) : null;
  const repeated = sameContent || sameIds;
  history.lastPageRepeated = false;
  if (repeated) {
    const duplicate = { errorCode: 'REPEATED_PAGE', requestedPage: pageNo, repeatedFromPage: Number(repeated[0]),
      totalCount: page.totalCount, returnedItems: page.items.length, idSetDigest, sameContent: !!sameContent, observedAt: at };
    if (!evolving) { history.validationFailure = duplicate; fail('REPEATED_PAGE'); }
    history.lastDuplicatePage = duplicate; history.lastPageRepeated = true;
    history.duplicatePages = (history.duplicatePages || 0) + 1;
    history.skippedDuplicateSlots = (history.skippedDuplicateSlots || 0) + page.items.length;
    history.consecutiveDuplicatePages = (history.consecutiveDuplicatePages || 0) + 1;
    recordGap(history, pageNo);
    recordTotal(history, page.totalCount, pageNo, at); history.hashes[pageNo] = fingerprint;
    history.idSetHashes ||= {}; history.idSetHashes[pageNo] = idSetDigest;
    delete history.validationFailure;
    return sameContent ? [] : [...unique.values()];
  }
  if (evolving) history.consecutiveDuplicatePages = 0;
  recordTotal(history, page.totalCount, pageNo, at); history.hashes[pageNo] = fingerprint;
  history.idSetHashes ||= {}; history.idSetHashes[pageNo] = idSetDigest;
  delete history.validationFailure;
  return [...unique.values()];
}
async function advance(plan, source, at, pageSize, clock = () => new Date(at)) {
  if (plan.calls >= 10000) fail('DOCUMENTED_DAILY_CALL_BUDGET');
  if (plan.phase === 'revalidation') {
    while (plan.index < plan.targetIds.length && verified(plan.outcomes[plan.targetIds[plan.index]])) plan.index++;
    if (plan.index === plan.targetIds.length) {
      const scope = revalidationScope(plan);
      if (scope.state === 'verified') plan.existingIdsRevalidation ||= scope;
      plan.phase = plan.discovery.nextPage > 1 && !plan.discovery.ended ? 'discovery_head' : 'discovery'; return;
    }
    const id = plan.targetIds[plan.index];
    if (!plan.pending) {
      plan.calls++;
      const detail = await source.detail(id);
      at = clock().toISOString();
      if (!detail || !detail.title) { outcome(plan, id, 'unverified_detail_missing', at); plan.index++; return; }
      if (detail.id !== id) fail('DETAIL_ID_MISMATCH');
      const from = dateField(detail.from), to = dateField(detail.to), day = kstDay(new Date(at));
      if (from && to && from <= to && (day < from || day > to)) {
        plan.candidate.jobs = plan.candidate.jobs.filter(row => row.jobId !== id);
        outcome(plan, id, 'verified_period_ineligible', at); plan.index++; return;
      }
      plan.pending = { id, title: detail.title, nextPage: 1, total: null, hashes: {} };
      return;
    }
    const pending = plan.pending;
    plan.calls++;
    const page = await source.list(pending.nextPage, pageSize, pending.title);
    at = clock().toISOString();
    const rows = validatePage(page, pending.nextPage, pageSize, pending, false, at);
    for (const row of rows) if (plan.targetIds.includes(row.jobId)) observe(plan, row, at, 'revalidation');
    if (rows.some(row => row.jobId === id)) { plan.pending = null; plan.index++; }
    else if (pending.nextPage >= Math.max(1, Math.ceil(page.totalCount / pageSize))) {
      outcome(plan, id, 'unverified_not_returned_by_title_search', at); plan.pending = null; plan.index++;
    } else pending.nextPage++;
    return;
  }
  const discovery = plan.discovery;
  if (plan.phase === 'discovery_head') {
    plan.calls++;
    const page = await source.list(1, pageSize);
    at = clock().toISOString();
    const head = { total: null, hashes: {} };
    const rows = validatePage(page, 1, pageSize, head);
    if (discovery.nextPage > Math.max(1, Math.ceil(page.totalCount / pageSize))) {
      Object.assign(discovery, { nextPage: 1, hashes: {}, idSetHashes: {}, scannedRows: 0, cycleStartedAt: at,
        restartReason: 'source_total_shrank_before_cursor' });
    }
    recordTotal(discovery, page.totalCount, 1, at);
    for (const row of rows) observe(plan, row, at, 'discovery');
    discovery.total = page.totalCount; discovery.hashes[1] = head.hashes[1];
    discovery.idSetHashes ||= {}; discovery.idSetHashes[1] = head.idSetHashes[1];
    discovery.scannedRows += page.items.length; plan.headObservedToday = true;
    if (discovery.nextPage === 1) discovery.nextPage = 2;
    plan.phase = 'discovery';
    if (Math.ceil(page.totalCount / pageSize) <= 1) { discovery.ended = true; plan.phase = 'done'; }
    return;
  }
  if (discovery.ended) { plan.phase = 'done'; return; }
  plan.calls++;
  const page = await source.list(discovery.nextPage, pageSize);
  at = clock().toISOString();
  const rows = validatePage(page, discovery.nextPage, pageSize, discovery, true, at);
  if (!page.items.length && page.totalCount > 0 && discovery.nextPage > Math.ceil(page.totalCount / pageSize)) {
    Object.assign(discovery, { nextPage: 1, hashes: {}, idSetHashes: {}, scannedRows: 0, cycleStartedAt: at,
      restartReason: 'source_total_shrank_before_cursor' });
    return;
  }
  if (discovery.nextPage === 1) plan.headObservedToday = true;
  for (const row of rows) observe(plan, row, at, 'discovery');
  if (discovery.lastPageRepeated) {
    const attemptedPage = discovery.nextPage;
    discovery.nextPage++;
    if (discovery.consecutiveDuplicatePages >= 5) {
      plan.errorCode = discovery.errorCode = 'DISCOVERY_REPEATED_PAGE_LIMIT';
      discovery.validationFailure = { ...discovery.lastDuplicatePage, errorCode: plan.errorCode, consecutiveDuplicatePages: discovery.consecutiveDuplicatePages };
      return;
    }
    if (attemptedPage >= Math.max(1, Math.ceil(page.totalCount / pageSize))) { discovery.ended = true; plan.phase = 'done'; }
    return;
  }
  discovery.scannedRows += page.items.length;
  if (discovery.nextPage >= Math.max(1, Math.ceil(page.totalCount / pageSize))) { discovery.ended = true; plan.phase = 'done'; }
  else discovery.nextPage++;
}
function published(plan, at, schedulerEnabled) {
  pruneObservations(plan);
  const snapshot = structuredClone(plan.candidate), stats = progress(plan);
  const scope = plan.existingIdsRevalidation || revalidationScope(plan);
  if (scope?.state === 'verified') {
    plan.existingIdsRevalidation ||= scope;
    plan.existingIdsPublishedAt ||= at;
  }
  snapshot.jobs = snapshot.jobs.filter(row => eligibility(row, new Date(at)).eligible);
  const ids = new Set(snapshot.jobs.map(row => row.jobId));
  snapshot.detailSummaries = Object.fromEntries(Object.entries(snapshot.detailSummaries).filter(([id]) => ids.has(id)));
  const observed = snapshot.metadata.sourceObservedById || {};
  const currentIds = snapshot.jobs.filter(row => plan.sourceVerifiedIds[row.jobId]).map(row => row.jobId);
  const retained = snapshot.jobs.length - currentIds.length;
  snapshot.metadata.sourceObservedById = Object.fromEntries(Object.entries(observed).filter(([id]) => ids.has(id)));
  Object.assign(snapshot.metadata, { observedAt: at, referenceDayKst: plan.runDayKst, datasetState: 'partial_source_daily_refresh',
    coverageVerified: false, storedListJobs: snapshot.jobs.length, cachedDetailSummaries: Object.keys(snapshot.detailSummaries).length,
    fullDetailDocuments: 0, jobsWithoutDetail: snapshot.jobs.length - Object.keys(snapshot.detailSummaries).length,
    refresh: { scanScope: 'existing_ids_revalidation_and_resumable_discovery', retainedNotRevalidated: retained,
      latestStatusRevalidatedIds: currentIds, dailyRevalidation: stats,
      existingIdsRevalidation: scope?.state === 'verified' ? { ...scope, state: 'succeeded', publishedAt: plan.existingIdsPublishedAt } : scope,
      discovery: { nextPage: plan.discovery.nextPage,
        totalCount: plan.discovery.total, scannedRows: plan.discovery.scannedRows, pageTraversalEnded: plan.discovery.ended,
        uniqueCoverageVerified: false, cycleStartedAt: plan.discovery.cycleStartedAt,
        sourceTotalsChanged: plan.discovery.sourceTotalsChanged || false, totalChanges: plan.discovery.totalChanges || [],
        restartReason: plan.discovery.restartReason || null, coverageGaps: plan.discovery.coverageGaps || [],
        duplicatePages: plan.discovery.duplicatePages || 0, skippedDuplicateSlots: plan.discovery.skippedDuplicateSlots || 0,
        lastDuplicatePage: plan.discovery.lastDuplicatePage || null } } });
  const hasGaps = !!plan.discovery.coverageGaps?.length;
  const complete = stats.complete && plan.phase === 'done' && !hasGaps;
  const refreshState = { state: plan.errorCode ? 'paused_incomplete' : plan.phase === 'done' && hasGaps ? 'completed_with_discovery_gaps' :
    complete ? 'completed_partial_source' : plan.phase === 'done' ? 'completed_with_unverified_ids' : 'in_progress_partial', schedulerEnabled,
    lastAttemptAt: plan.startedAt, lastPublishedAt: at, lastSuccessfulAt: complete ? at : null,
    existingIdsComplete: stats.complete, errorCode: plan.errorCode || null };
  const { candidate, ...runPlan } = plan;
  return { schemaVersion: 1, snapshot, sha256: digest(snapshot), refreshState, runPlan };
}
async function runDailyChunk({ store, source, now = () => new Date(), budgetMs = 35000, pageSize = 1000, schedulerEnabled = false, onEvent = () => {} }) {
  const started = now(), at = started.toISOString(), current = await store.readCurrent(), control = await store.readControl();
  if (Date.parse(control?.value.leaseUntil || '') > started.getTime()) return { state: 'already_running', continue: false };
  const previous = current?.value.snapshot || bundled.snapshot;
  const currentPlan = current?.value.runPlan ? { ...current.value.runPlan, candidate: current.value.snapshot } : null;
  const checkpoint = control?.value.plan;
  const prior = planIsAtLeastAsNew(checkpoint, currentPlan) ? checkpoint : currentPlan;
  const plan = prior?.runDayKst === kstDay(started) && planCycle(prior) === refreshCycleDay(at) ? structuredClone(prior) : createDay(previous, prior, at);
  if (control?.value.attemptDayKst === plan.runDayKst && Number.isInteger(control.value.attemptSourceCalls)) {
    plan.calls = Math.max(plan.calls, control.value.attemptSourceCalls);
  }
  pruneObservations(plan);
  if (plan.phase !== 'revalidation' && !plan.existingIdsRevalidation) {
    const scope = revalidationScope(plan);
    if (scope?.state === 'verified') {
      plan.existingIdsRevalidation = scope;
      if (currentPlan?.runDayKst === plan.runDayKst && revalidationScope(currentPlan)?.state === 'verified') {
        plan.existingIdsPublishedAt = current.value.refreshState.lastPublishedAt || previous.metadata.observedAt;
      }
    }
  }
  if (plan.phase === 'done') return { state: 'already_completed', continue: false, progress: progress(plan) };
  if (plan.discovery.errorCode === 'DISCOVERY_REPEATED_PAGE_LIMIT') {
    return { state: 'paused_incomplete', continue: false, errorCode: 'DISCOVERY_REPEATED_PAGE_LIMIT', progress: progress(plan) };
  }
  if (plan.phase === 'discovery' && plan.discovery.errorCode) {
    if (['TOTAL_CHANGED_DURING_SCAN', 'REPEATED_PAGE'].includes(plan.discovery.errorCode)) delete plan.discovery.errorCode;
    else plan.discovery = { nextPage: 1, total: null, hashes: {}, scannedRows: 0, ended: false, cycleStartedAt: at, uniqueCoverageVerified: false };
  }
  plan.errorCode = null;
  const claimState = { state: 'running', schedulerEnabled, lastAttemptAt: at,
    leaseId: crypto.randomUUID(), leaseUntil: new Date(started.getTime() + 90000).toISOString(), dailyProgress: progress(plan), plan };
  let claim;
  try { claim = await store.writeControl(claimState, control?.etag); }
  catch { return { state: 'lease_not_acquired', continue: false, errorCode: 'STORAGE_UNAVAILABLE' }; }
  plan.chunks++;
  try {
    while (plan.phase !== 'done' && !plan.errorCode && now().getTime() - started.getTime() < budgetMs) {
      try { await advance(plan, source, now().toISOString(), pageSize, now); }
      finally { if (source.diagnostics) plan.sourceDiagnostics = { ...source.diagnostics(), scope: 'latest_chunk', chunkElapsedMs: now().getTime() - started.getTime() }; }
    }
    const end = now().toISOString(), envelope = published(plan, end, schedulerEnabled);
    envelope.refreshState.lastSuccessfulAt ||= current?.value.refreshState.lastSuccessfulAt || null;
    try { await store.writeCurrent(envelope, current?.etag); }
    catch (cause) {
      const check = await store.readCurrent();
      if (check?.value.sha256 !== envelope.sha256) throw cause;
    }
    const finished = { ...claimState, plan, dailyProgress: progress(plan), leaseUntil: null, state: envelope.refreshState.state, lastAttemptAt: at, errorCode: plan.errorCode || null };
    const checkpoint = await writeCheckpoint(store, finished, claim.etag);
    onEvent({ event: 'refresh_checkpoint', state: finished.state, checkpointSaved: true, snapshotPublished: true,
      phase: plan.phase, confirmedIds: finished.dailyProgress.confirmedIds, targetIds: plan.targetIds.length, sourceCalls: plan.calls,
      elapsedMs: now().getTime() - started.getTime(), checkpointCompact: checkpoint.compact, controlBytes: checkpoint.bytes,
      sourceVerifiedIdsStored: Object.keys(plan.sourceVerifiedIds).length,
      sourceObservationIdsStored: Object.keys(plan.candidate.metadata.sourceObservedById).length });
    return { state: finished.state, continue: plan.phase !== 'done' && !plan.errorCode, errorCode: plan.errorCode || null,
      progress: progress(plan), snapshotPublished: true };
  } catch (cause) {
    plan.errorCode = errorCode(cause);
    if (plan.phase.startsWith('discovery') && ['TOTAL_CHANGED_DURING_SCAN','REPEATED_PAGE','PAGE_SEQUENCE_MISMATCH','SOURCE_PAGE_SIZE_MISMATCH','NONFINAL_SHORT_PAGE'].includes(plan.errorCode)) plan.discovery.errorCode = plan.errorCode;
    const failed = { ...claimState, plan, dailyProgress: progress(plan), leaseUntil: null, state: 'paused_incomplete', errorCode: plan.errorCode };
    let checkpointSaved = false, checkpoint;
    try { checkpoint = await writeCheckpoint(store, failed, claim.etag); checkpointSaved = true; } catch { /* A failed checkpoint retains the preceding durable cursor. */ }
    onEvent({ event: 'refresh_checkpoint', state: failed.state, checkpointSaved, phase: plan.phase,
      confirmedIds: failed.dailyProgress.confirmedIds, targetIds: plan.targetIds.length, sourceCalls: plan.calls,
      errorCode: plan.errorCode, elapsedMs: now().getTime() - started.getTime(), checkpointCompact: checkpoint?.compact || false,
      controlBytes: checkpoint?.bytes || null, validationFailure: plan.discovery.validationFailure || plan.pending?.validationFailure || null });
    return { state: 'paused_incomplete', continue: false, progress: progress(plan), errorCode: plan.errorCode,
      snapshotPublishOutcome: 'check_current_snapshot_digest' };
  }
}
module.exports = { createDay, progress, advance, published, runDailyChunk };
