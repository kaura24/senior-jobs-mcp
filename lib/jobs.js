'use strict';

const snapshot = require('../data/jobs.json');
const curation = require('./curation');
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
  const elapsedHours = (now.getTime() - Date.parse(snapshot.metadata.observedAt)) / 3600000;
  return {
    ...snapshot.metadata,
    queriedAt: now.toISOString(), currentDayKst: kstDay(now),
    eligibleStoredJobs: snapshot.jobs.filter(row => eligibility(row, now).eligible).length,
    sourceFreshness: elapsedHours > 24 || kstDay(now) !== snapshot.metadata.referenceDayKst ? 'stale_static_snapshot' : 'static_snapshot',
    missingFieldPolicy: 'confirmation_required',
    warning: 'Partial static PoC. These counts describe only the stored sample, not all jobs nationwide. Source changes are not fetched.',
  };
}

function answerNotice() {
  const observedAtKst = new Date(Date.parse(snapshot.metadata.observedAt) + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' KST';
  return { requiredInResultAnswers: true, observedAt: snapshot.metadata.observedAt, observedAtKst,
    storedListJobs: snapshot.metadata.storedListJobs, cachedDetailSummaries: snapshot.metadata.cachedDetailSummaries,
    jobsWithoutDetail: snapshot.metadata.jobsWithoutDetail, fullDetailDocuments: snapshot.metadata.fullDetailDocuments,
    text: `${observedAtKst} 기준 저장 공고 314건의 정적·부분 PoC입니다. 상세 관찰 요약은 1건, 전체 상세 문서는 0건이며 다른 313건은 상세 미수집입니다. 원본의 이후 변경은 반영하지 않습니다.` };
}

function publicJob(row, now, conditionState = curation.conditions({})) {
  return {
    id: row.jobId, title: row.recrtTitle, organization: row.oranNm,
    region: row.workPlcNm || null, employmentCode: row.emplymShp || row.emplymShpNm || null,
    occupation: row.jobclsNm || row.jobcls || null, applicationMethod: row.acptMthd || null,
    applicationFrom: dateField(row.frDd), applicationTo: dateField(row.toDd), rawDeadline: row.deadline,
    eligibility: eligibility(row, now),
    detailState: snapshot.detailSummaries[row.jobId] ? 'summary_only' : 'not_collected',
    confirmationRequired: unknownFields,
    fieldEvidence: curation.fieldEvidence(row), filterAssessment: curation.assess(row, conditionState),
  };
}

function select(args, now, extraFields = []) {
  const conditionState = curation.conditions(args, extraFields);
  const eligibleRows = snapshot.jobs.filter(row => eligibility(row, now).eligible);
  return { conditionState, eligibleRows, selection: curation.filterCandidates(eligibleRows, conditionState) };
}

function searchJobs(args = {}, now = new Date()) {
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
  const { conditionState, eligibleRows, selection } = select(args, now);
  return { context: context(now), answerNotice: answerNotice(), factors: curation.factors(selection.matches),
    ...curation.contract(conditionState, eligibleRows, snapshot.jobs.length, selection, 'describe'),
    searchFields: ['keyword', 'region', 'employmentCode'], questionOrderEffectiveness: 'not_measured',
    guidance: 'Ask about region and work preference using observed options. Do not infer age eligibility or reject a job because a field is missing.' };
}

function getDetails(args, now = new Date()) {
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
    nextAction: 'explain_cached_evidence_and_uncollected_fields', nextQuestion: null,
    recruiterConfirmationTopics: ['salary_and_pay_basis', 'exact_working_hours', 'age_eligibility', 'required_qualifications'],
    warning: summary ? 'Only an observation summary is cached; the full detail response was not stored.' : 'No detail or contact has been collected for this job. Missing information requires confirmation.' };
}

module.exports = { snapshot, kstDay, dateField, eligibility, context, describeOptions, searchJobs, getDetails };
