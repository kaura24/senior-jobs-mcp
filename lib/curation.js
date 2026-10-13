'use strict';

const playbook = require('../data/curation-playbook.json');
const regions = require('./regions');
const { datasetContext, bundled } = require('./job-context');
const { detailLink } = require('./job-links');
const criteriaFields = ['keyword', 'region', 'employmentCode'];
const preferenceFlags = ['anyRegion', 'anyWork'];
const uncollectedFields = ['salary', 'workTime', 'ageEligibility', 'qualifications', 'preferences'];
const canonical = value => String(value || '').normalize('NFC').replace(/\s+/g, '').toLocaleLowerCase('ko');
const present = value => typeof value === 'string' && Boolean(value.trim());

function conditions(args, extra = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  const allowed = [...criteriaFields, ...preferenceFlags, ...extra];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}`);
  const state = {};
  for (const key of criteriaFields) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > 200)) throw new Error(`${key} must be a string up to 200 characters.`);
    state[key] = (args[key] || '').trim() || null;
  }
  for (const key of preferenceFlags) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
    state[key] = args[key] ?? false;
  }
  if (state.anyRegion && state.region) throw new Error('anyRegion conflicts with a specific region.');
  if (state.anyWork && state.keyword) throw new Error('anyWork conflicts with a specific keyword.');
  return state;
}

function field(row, fields) {
  const key = fields.find(key => present(row[key]));
  return key ? { state: 'observed', sourceField: key, rawValue: row[key] } : { state: 'unknown', sourceFields: fields, rawValue: null };
}

function regionEvidence(row) {
  const { snapshot } = datasetContext();
  const observedAt = snapshot.metadata.regionObservedById?.[row.jobId] || snapshot.metadata.sourceObservedById?.[row.jobId] || snapshot.metadata.observedAt;
  const prior = snapshot.metadata.regionHistoryById?.[row.jobId] || bundled.snapshot.metadata.regionHistoryById?.[row.jobId];
  return { ...field(row, ['workPlcNm']), observedAt, source: 'latest_stored_source_list',
    workPlc: row.workPlc || null,
    sourceValueState: present(row.workPlcNm) ? 'provided' : Object.hasOwn(row, 'workPlcNm') ? 'empty' : 'not_provided',
    previousObservation: prior && Date.parse(prior.observedAt) < Date.parse(observedAt)
      ? { ...prior, state: 'previous_observation_only', usedForCurrentFiltering: false } : null };
}

function fieldEvidence(row) {
  return {
    title: field(row, ['recrtTitle']), organization: field(row, ['oranNm']), region: regionEvidence(row),
    occupation: field(row, ['jobclsNm', 'jobcls']), employmentCode: field(row, ['emplymShp', 'emplymShpNm']),
    applicationMethod: field(row, ['acptMthd']), applicationFrom: field(row, ['frDd']), applicationTo: field(row, ['toDd']),
    rawDeadline: field(row, ['deadline']),
    ...Object.fromEntries(uncollectedFields.map(key => [key, { state: 'not_collected', rawValue: null, confirmationRequired: true }])),
  };
}

function assess(row, state) {
  const evidence = [];
  for (const key of ['region', 'employmentCode']) {
    if (!state[key]) continue;
    const observed = field(row, key === 'region' ? ['workPlcNm'] : ['emplymShp', 'emplymShpNm']);
    const matched = observed.state === 'observed' && (key === 'region' ? canonical(observed.rawValue).includes(canonical(state[key])) : observed.rawValue === state[key]);
    evidence.push({ criterion: key, requestedValue: state[key], ...observed, operator: key === 'region' ? 'contains_canonical' : 'exact',
      result: observed.state === 'unknown' ? 'unknown' : matched ? 'match' : 'mismatch' });
  }
  if (state.keyword) {
    const fields = ['recrtTitle', 'oranNm', 'workPlcNm', 'jobclsNm', 'jobcls'];
    const available = fields.filter(key => present(row[key]));
    const matching = available.filter(key => canonical(row[key]).includes(canonical(state.keyword)));
    evidence.push({ criterion: 'keyword', requestedValue: state.keyword, operator: 'contains_canonical',
      result: matching.length ? 'match' : available.length ? 'mismatch' : 'unknown',
      observedSourceValues: available.map(sourceField => ({ sourceField, rawValue: row[sourceField], matched: matching.includes(sourceField) })) });
  }
  return { state: evidence.some(x => x.result === 'mismatch') ? 'mismatch' : evidence.some(x => x.result === 'unknown') ? 'unknown' : 'match', evidence };
}

function filterCandidates(rows, state) {
  const assessed = rows.map(row => ({ row, assessment: assess(row, state) }));
  const unknown = assessed.filter(x => x.assessment.state === 'unknown');
  const unknownEvidenceCounts = {};
  for (const item of unknown) for (const evidence of item.assessment.evidence) {
    if (evidence.result === 'unknown') unknownEvidenceCounts[evidence.criterion] = (unknownEvidenceCounts[evidence.criterion] || 0) + 1;
  }
  return { matches: assessed.filter(x => x.assessment.state === 'match').map(x => x.row),
    unknownCount: unknown.length, unknownEvidenceCounts,
    mismatchCount: assessed.filter(x => x.assessment.state === 'mismatch').length };
}

function factor(rows, fields) {
  const counts = new Map();
  let providedJobs = 0;
  for (const row of rows) {
    const observed = field(row, fields);
    if (observed.state !== 'observed') continue;
    providedJobs++;
    counts.set(observed.rawValue, (counts.get(observed.rawValue) || 0) + 1);
  }
  return { sourceFields: fields, denominator: rows.length, providedJobs, missingJobs: rows.length - providedJobs,
    providedRate: rows.length ? providedJobs / rows.length : null,
    values: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko')).map(([value, count]) => ({ value, count })),
    effectivenessMeasured: false };
}

function factors(rows) {
  const previous = rows.map(row => regionEvidence(row).previousObservation).filter(Boolean);
  const dates = previous.map(item => item.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { region: { ...factor(rows, ['workPlcNm']), normalized: regions.distribution(rows),
    previousObservations: { state: 'previous_observation_only', usedForCurrentFiltering: false, denominator: rows.length,
      providedJobs: previous.length, earliestObservedAt: dates[0] || null, latestObservedAt: dates.at(-1) || null,
      normalized: regions.distribution(previous.map(item => ({ workPlcNm: item.rawValue }))) } }, occupation: factor(rows, ['jobclsNm', 'jobcls']),
    employmentCode: factor(rows, ['emplymShp', 'emplymShpNm']), applicationMethod: factor(rows, ['acptMthd']),
    ...Object.fromEntries(uncollectedFields.map(key => [key, { availability: 'not_collected', denominator: rows.length,
      providedJobs: 0, missingJobs: rows.length, confirmationRequired: true }])) };
}

function contract(state, eligibleRows, totalStored, selection, mode) {
  const questions = [];
  const regionEvidence = factor(selection.matches, ['workPlcNm']);
  if (!state.region && !state.anyRegion) questions.push({ key: 'region', text: regionEvidence.providedJobs
    ? '어느 지역에서 일하고 싶으세요?'
    : `현재 저장 목록 ${regionEvidence.missingJobs}건의 근무지명이 미기재되어 지역별 공고 수를 확인할 수 없습니다. 희망 지역을 직접 알려주시겠어요?`,
    evidence: { sourceFields: regionEvidence.sourceFields, denominator: regionEvidence.denominator, providedJobs: regionEvidence.providedJobs,
      missingJobs: regionEvidence.missingJobs, observedExamples: regions.distribution(selection.matches).provinces,
      examplesComplete: true, unrecognizedJobs: regions.distribution(selection.matches).unrecognizedJobs }, allowNoPreference: true });
  if (!state.keyword && !state.anyWork) questions.push({ key: 'keyword', text: '어떤 일을 원하세요? 공고 제목에서 찾을 말로 알려주세요. 종류를 가리지 않아도 됩니다.',
    evidence: { sourceField: 'recrtTitle', providedJobs: selection.matches.filter(row => present(row.recrtTitle)).length,
      denominator: selection.matches.length, observedTitleExamples: selection.matches.slice(0, 3).map(row => ({ id: row.jobId, rawTitle: row.recrtTitle,
        detailLink: detailLink(row.jobId) })) }, allowNoPreference: true });
  const appliedFilters = criteriaFields.filter(key => state[key]).map(key => ({ field: key, value: state[key], operator: key === 'employmentCode' ? 'exact' : 'contains_canonical' }));
  const unknownOnly = !selection.matches.length && selection.unknownCount > 0;
  const missingNames = Object.keys(selection.unknownEvidenceCounts).map(key => ({ region: '근무지명', employmentCode: '고용형태', keyword: '검색 근거' })[key]).join('·');
  if (!selection.matches.length && (mode === 'search' || appliedFilters.length)) questions.splice(0, questions.length,
    unknownOnly ? { key: 'confirm_missing_fields',
      text: `조건에 일치한다고 확인된 공고는 0건이지만, ${missingNames} 미기재로 일치 여부를 확인하지 못한 공고가 ${selection.unknownCount}건입니다. 조건을 유지한 채 확인 방법을 안내할까요?`,
      unknownCandidates: selection.unknownCount, missingFilterEvidence: selection.unknownEvidenceCounts, requiresUserChoice: true }
      : { key: 'broaden', text: '저장된 부분 표본에서는 이 조건에 일치하는 공고가 없습니다. 지역이나 일의 종류를 넓혀서 다시 볼까요?',
        unknownCandidates: 0, requiresUserChoice: true });
  const nextAction = unknownOnly ? 'explain_unknown_candidates' : !selection.matches.length && appliedFilters.length ? 'ask_before_broadening'
    : mode === 'describe' && questions.length ? 'ask_questions' : mode === 'describe' ? 'search_jobs'
    : selection.matches.length ? 'present_matches_and_wait_for_selection' : 'ask_before_broadening';
  const nextQuestion = questions[0] || null;
  const normalizedRegions = regions.distribution(selection.matches);
  const occupationEvidence = factor(selection.matches, ['jobclsNm', 'jobcls']);
  const options = nextQuestion?.key === 'region' ? normalizedRegions.provinces
    : nextQuestion?.key === 'keyword' ? [...occupationEvidence.values].sort((a, b) => a.value.localeCompare(b.value, 'ko')) : [];
  const uiGuidance = { nextAction, question: nextQuestion?.text || null, optionsSource: 'database', options,
    allowAny: true, allowFreeText: true, optionsComplete: true,
    optionsBasis: nextQuestion?.key === 'region' ? 'normalized_province_from_raw_workPlcNm'
      : nextQuestion?.key === 'keyword' ? 'observed_occupation_classification' : 'no_selection_needed',
    optionCoverage: nextQuestion?.key === 'region' ? normalizedRegions
      : nextQuestion?.key === 'keyword' ? { denominator: occupationEvidence.denominator, providedJobs: occupationEvidence.providedJobs,
        missingJobs: occupationEvidence.missingJobs, titleKeywordSearchSupported: true } : null,
    questionOrderMandatory: false, clientRenderingGuaranteed: false, recommendationRanking: false };
  return { contractVersion: playbook.version, conditionState: state, appliedFilters, uiGuidance,
    candidateCounts: { stored: totalStored, eligibleBeforeFilters: eligibleRows.length, confirmedAfterFilters: selection.matches.length,
      unknownAfterFilters: selection.unknownCount, mismatchAfterFilters: selection.mismatchCount, excludedByStoredPeriodOrStatus: totalStored - eligibleRows.length },
    unknownFilterEvidence: selection.unknownEvidenceCounts,
    distributionScope: 'all_confirmed_filtered_matches_before_paging',
    nextQuestion, suggestedQuestions: questions.slice(0, 2), nextAction,
    judgementPolicy: 'host_decides_from_observed_evidence;missing_is_not_mismatch;no_inferred_eligibility',
    zeroResultPolicy: 'zero_in_partial_sample_only;do_not_silently_relax_filters',
    scenarioInstructions: 'Use a flexible conversation: stated preferences, data-backed candidates with actual source references or explicit source-unavailable cached-detail fallbacks, selected posting and requested additional fields, then explicit client-side source investigation. Search immediately when conditions are sufficient; ask only unanswered useful questions and never impose a fixed question order. Use explicit anyRegion/anyWork for no preference. If no posting is selected, ask for selection before investigating; never bulk-crawl candidates. Retrieve cached details first for the selected ID. The MCP remains cache-only and provides source clues and guidance. The calling client chooses tools actually available in its own environment; no particular tool, key or service is required. Only on an explicit request, prefer official original sources, verify ID or documented cross-reference, company and title, and return requested confirmed fields with source passages, source URLs and retrieval times. If client tools are unavailable or access is blocked, provide existing links and disclose that the source has not been queried. Distinguish missing, blocked, identity mismatch and explicit closure; never bypass login/security blocks, add a server crawler or call a separate AI API. Treat user-provided examples as unverified claims and report conflicting list/source values with separate sources and observation times instead of silently overwriting them.' };
}

module.exports = { instructions: playbook.instructions, version: playbook.version, criteriaFields, preferenceFlags,
  conditions, fieldEvidence, assess, filterCandidates, factors, contract };
