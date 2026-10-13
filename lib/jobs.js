'use strict';

const snapshot = require('../data/jobs.json');
const { datasetContext } = require('./job-context');
const curation = require('./curation');
const regions = require('./regions');
const { detailLink } = require('./job-links');

const unknownFields = ['salary', 'workTime', 'ageEligibility', 'qualifications', 'preferences'];

function kstDay(now) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

function dateField(value) {
  const text = String(value || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(text)) return null;
  const date = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function eligibility(row, now) {
  const today = kstDay(now), from = dateField(row.frDd), to = dateField(row.toDd);
  if (!from || !to || from > to) return { eligible: false, reason: 'invalid_application_period' };
  if (today < from || today > to) return { eligible: false, reason: 'outside_application_period' };
  if (String(row.deadline || '').trim() !== '접수중') return { eligible: false, reason: 'raw_status_not_accepting' };
  return { eligible: true, reason: 'period_and_raw_status_accepting' };
}

function context(now) {
  const { snapshot, refreshState } = datasetContext();
  const { regionHistoryById, ...publicMetadata } = snapshot.metadata;
  const elapsedHours = (now.getTime() - Date.parse(snapshot.metadata.observedAt)) / 3600000;
  const daily = refreshState.dailyRevalidation || snapshot.metadata.refresh?.dailyRevalidation;
  const publishedDiscovery = snapshot.metadata.refresh?.discovery;
  const discovery = publishedDiscovery && daily ? { ...publishedDiscovery,
    publishedNextPage: publishedDiscovery.nextPage, cursorEvidence: refreshState.progressEvidence || 'latest_durable_checkpoint', nextPage: daily.discoveryNextPage,
    scannedRows: daily.discoveryScannedRows ?? publishedDiscovery.scannedRows,
    totalCount: daily.discoveryTotalCount ?? publishedDiscovery.totalCount,
    pageTraversalEnded: daily.discoveryPageTraversalEnded,
    coverageGaps: daily.discoveryCoverageGaps || publishedDiscovery.coverageGaps || [],
    duplicatePages: daily.discoveryDuplicatePages ?? publishedDiscovery.duplicatePages ?? 0,
    skippedDuplicateSlots: daily.discoverySkippedDuplicateSlots ?? publishedDiscovery.skippedDuplicateSlots ?? 0 } : publishedDiscovery;
  return {
    ...publicMetadata,
    ...(discovery ? { refresh: { ...snapshot.metadata.refresh, discovery } } : {}),
    queriedAt: now.toISOString(), currentDayKst: kstDay(now), snapshotOrigin: refreshState.storageState || 'bundled_fallback',
    eligibleStoredJobs: snapshot.jobs.filter(row => eligibility(row, now).eligible).length,
    sourceFreshness: elapsedHours > 24 || kstDay(now) !== snapshot.metadata.referenceDayKst ? 'stale_static_snapshot' :
      refreshState.existingIdsRevalidation?.state === 'succeeded' ? 'source_revalidated_snapshot' :
      snapshot.metadata.refresh?.dailyRevalidation ? 'partially_revalidated_snapshot' : 'static_snapshot',
    missingFieldPolicy: 'confirmation_required',
    statusRevalidation: { state: refreshState.state, schedulerEnabled: refreshState.schedulerEnabled,
      lastAttemptAt: refreshState.lastAttemptAt, lastSuccessfulAt: refreshState.lastSuccessfulAt,
      sourceObservationAt: snapshot.metadata.observedAt, currentLiveStatusVerified: false,
      scanScope: snapshot.metadata.refresh?.scanScope || 'original_partial_sample',
      retainedNotRevalidated: snapshot.metadata.refresh?.retainedNotRevalidated ?? snapshot.jobs.length,
      storageState: refreshState.storageState || 'bundled_fallback',
      checkpointReadState: refreshState.checkpointReadState || null, storageReadErrorCode: refreshState.storageReadErrorCode || null,
      snapshotReadState: refreshState.snapshotReadState || null, refreshObservedState: refreshState.refreshObservedState || null,
      progressEvidence: refreshState.progressEvidence || null,
      dailyRevalidation: refreshState.dailyRevalidation || snapshot.metadata.refresh?.dailyRevalidation || null,
      existingIdsRevalidation: refreshState.existingIdsRevalidation || snapshot.metadata.refresh?.existingIdsRevalidation || null,
      successfulScope: refreshState.existingIdsRevalidation?.state === 'succeeded' ? 'existing_ids_revalidation' : null,
      queryApplicationPeriodRechecked: true, errorCode: refreshState.errorCode || null },
    warning: 'These counts describe only the published snapshot, not all jobs nationwide. Consult per-ID source observation times and refresh coverage.',
  };
}

function answerNotice() {
  const { snapshot, refreshState } = datasetContext();
  const daily = refreshState.dailyRevalidation || snapshot.metadata.refresh?.dailyRevalidation;
  const dailyText = daily ? ` 기존 ID 재검증(${daily.dayKst} KST) ${daily.confirmedIds}/${daily.targetIds}건, 미확인 ${daily.unverifiedIds.length}건.` : '';
  const scope = refreshState.existingIdsRevalidation || snapshot.metadata.refresh?.existingIdsRevalidation;
  const scopeText = scope?.state === 'succeeded' ? ` 기존 ID ${scope.confirmedIds}/${scope.targetIds}건 재검증 성공: ${scope.verifiedAt}, 게시: ${scope.publishedAt}. 신규 탐색은 별도 진행 상태입니다.` : '';
  const gapText = daily?.discoveryCoverageGaps?.length ? ` 신규 탐색에서 반복 응답으로 확인하지 못한 페이지 구간 ${daily.discoveryCoverageGaps.length}개가 있습니다. 누락된 고유 공고 수는 미확인입니다.` : '';
  const readText = refreshState.storageReadErrorCode === 'CONTROL_READ_UNAVAILABLE' ? ' 최신 게시 snapshot은 읽었으나 갱신 체크포인트 상태는 확인하지 못했습니다.' :
    refreshState.snapshotReadState === 'unavailable' ? ' 이번 조회에서 최신 snapshot을 읽지 못해 이전 캐시를 표시합니다. 현재 갱신 실행 상태는 미확인입니다.' : '';
  const observedAtKst = new Date(Date.parse(snapshot.metadata.observedAt) + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' KST';
  return { requiredInResultAnswers: true, observedAt: snapshot.metadata.observedAt, observedAtKst,
    storedListJobs: snapshot.metadata.storedListJobs, cachedDetailSummaries: snapshot.metadata.cachedDetailSummaries,
    jobsWithoutDetail: snapshot.metadata.jobsWithoutDetail, fullDetailDocuments: snapshot.metadata.fullDetailDocuments,
    text: `${observedAtKst} 기준 저장 공고 ${snapshot.metadata.storedListJobs}건의 부분 PoC입니다. 상세 관찰 요약은 ${snapshot.metadata.cachedDetailSummaries}건, 전체 상세 문서는 ${snapshot.metadata.fullDetailDocuments}건이며 다른 ${snapshot.metadata.jobsWithoutDetail}건은 상세 미수집입니다. 원천 재검증 범위: ${snapshot.metadata.refresh?.scanScope || 'original_partial_sample'}, 미재검증 유지 ${snapshot.metadata.refresh?.retainedNotRevalidated ?? snapshot.jobs.length}건.${dailyText}${scopeText}${gapText}${readText} 전국 전체 커버리지는 검증되지 않았습니다. 조회 시 KST 접수기간은 재검사합니다. 자동 갱신 상태: ${refreshState.state}, 재검증과 탐색을 모두 마친 실행의 마지막 성공: ${refreshState.lastSuccessfulAt || '없음'}. 오류: ${refreshState.errorCode || '없음'}.` };
}

function publicJob(row, now, conditionState = curation.conditions({})) {
  const { snapshot, refreshState } = datasetContext();
  return {
    id: row.jobId, title: row.recrtTitle, organization: row.oranNm,
    detailLink: detailLink(row.jobId),
    sourceObservedAt: snapshot.metadata.sourceObservedById?.[row.jobId] || snapshot.metadata.observedAt,
    observedInLatestRefresh: snapshot.metadata.refresh?.latestStatusRevalidatedIds?.includes(row.jobId) || false,
    dailyRevalidationState: snapshot.metadata.refresh?.dailyRevalidation?.unverifiedIds?.includes(row.jobId) ? 'unverified' :
      snapshot.metadata.refresh?.latestStatusRevalidatedIds?.includes(row.jobId) ? 'verified_from_source_list' : 'not_revalidated',
    region: row.workPlcNm || null, normalizedRegion: regions.normalize(row.workPlcNm), employmentCode: row.emplymShp || row.emplymShpNm || null,
    occupation: row.jobclsNm || row.jobcls || null, applicationMethod: row.acptMthd || null,
    applicationFrom: dateField(row.frDd), applicationTo: dateField(row.toDd), rawDeadline: row.deadline,
    eligibility: eligibility(row, now),
    detailState: snapshot.detailSummaries[row.jobId] ? 'summary_only' : 'not_collected',
    confirmationRequired: unknownFields,
    fieldEvidence: curation.fieldEvidence(row), filterAssessment: curation.assess(row, conditionState),
  };
}

function select(args, now, extraFields = []) {
  const { snapshot, refreshState } = datasetContext();
  const conditionState = curation.conditions(args, extraFields);
  const eligibleRows = snapshot.jobs.filter(row => eligibility(row, now).eligible);
  return { conditionState, eligibleRows, selection: curation.filterCandidates(eligibleRows, conditionState) };
}

function searchJobs(args = {}, now = new Date()) {
  const { snapshot, refreshState } = datasetContext();
  const { conditionState, eligibleRows, selection } = select(args, now, ['offset', 'limit']);
  const rows = selection.matches;
  const offset = args.offset ?? 0, limit = args.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50.');
  return { context: context(now), answerNotice: answerNotice(), totalMatches: rows.length, offset, limit,
    ...curation.contract(conditionState, eligibleRows, snapshot.jobs.length, selection, 'search'),
    factors: curation.factors(rows),
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    jobs: rows.slice(offset, offset + limit).map(row => publicJob(row, now, conditionState)) };
}

function describeOptions(args = {}, now = new Date()) {
  const { snapshot, refreshState } = datasetContext();
  const { conditionState, eligibleRows, selection } = select(args, now);
  return { context: context(now), answerNotice: answerNotice(), factors: curation.factors(selection.matches),
    ...curation.contract(conditionState, eligibleRows, snapshot.jobs.length, selection, 'describe'),
    searchFields: ['keyword', 'region', 'employmentCode'], questionOrderEffectiveness: 'not_measured',
    guidance: 'Ask about region and work preference using observed options. Do not infer age eligibility or reject a job because a field is missing.' };
}

function getDetails(args, now = new Date()) {
  const { snapshot, refreshState } = datasetContext();
  const conditionState = curation.conditions(args, ['id']);
  if (typeof args.id !== 'string' || !args.id.trim() || args.id.length > 100) throw new Error('id must be a nonempty string up to 100 characters.');
  const row = snapshot.jobs.find(row => row.jobId === args.id);
  if (!row) return { context: context(now), answerNotice: answerNotice(), found: false, id: args.id, conditionState, reason: 'not_in_stored_partial_sample', nextAction: 'choose_an_id_from_search_results' };
  const summary = snapshot.detailSummaries[row.jobId] || null;
  return { context: context(now), answerNotice: answerNotice(), found: true, contractVersion: curation.version, conditionState,
    job: publicJob(row, now, conditionState),
    rawListFields: row, cachedDetailSummary: summary, fullDetailDocument: null,
    contact: summary ? { name: summary.clerk, telephoneRaw: summary.clerkContt, observedAt: summary.observedAt,
      state: 'observed_in_cached_summary', connectivityVerified: false } : { state: 'not_collected', connectivityVerified: false },
    detailPolicy: 'cache_only_no_upstream_requests',
    additionalInvestigationOffer: { text: '급여·근무시간·지원조건을 더 찾아드릴까요?',
      when: 'missing_details_and_user_has_not_already_requested_source_investigation',
      executionOwner: 'calling_client', requiresUserAcceptance: true, automaticallyStarted: false },
    nextAction: 'explain_cached_evidence_and_uncollected_fields', nextQuestion: null,
    recruiterConfirmationTopics: ['salary_and_pay_basis', 'exact_working_hours', 'age_eligibility', 'required_qualifications'],
    warning: summary ? 'Only an observation summary is cached; the full detail response was not stored.' : 'No detail or contact has been collected for this job. Missing information requires confirmation.' };
}

module.exports = { snapshot, kstDay, dateField, eligibility, context, describeOptions, searchJobs, getDetails };
