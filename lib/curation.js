'use strict';

const playbook = require('../data/curation-playbook.json');
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

function fieldEvidence(row) {
  return {
    title: field(row, ['recrtTitle']), organization: field(row, ['oranNm']), region: field(row, ['workPlcNm']),
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
  return { region: factor(rows, ['workPlcNm']), occupation: factor(rows, ['jobclsNm', 'jobcls']),
    employmentCode: factor(rows, ['emplymShp', 'emplymShpNm']), applicationMethod: factor(rows, ['acptMthd']),
    ...Object.fromEntries(uncollectedFields.map(key => [key, { availability: 'not_collected', denominator: rows.length,
      providedJobs: 0, missingJobs: rows.length, confirmationRequired: true }])) };
}

function contract(state, eligibleRows, totalStored, selection, mode) {
  const questions = [];
  const regionEvidence = factor(selection.matches, ['workPlcNm']);
  if (!state.region && !state.anyRegion) questions.push({ key: 'region', text: '어느 지역에서 일하고 싶으세요?',
    evidence: { sourceFields: regionEvidence.sourceFields, denominator: regionEvidence.denominator, providedJobs: regionEvidence.providedJobs,
      missingJobs: regionEvidence.missingJobs, observedExamples: regionEvidence.values.slice(0, 6) }, allowNoPreference: true });
  if (!state.keyword && !state.anyWork) questions.push({ key: 'keyword', text: '어떤 일을 원하세요? 공고 제목에서 찾을 말로 알려주세요. 종류를 가리지 않아도 됩니다.',
    evidence: { sourceField: 'recrtTitle', providedJobs: selection.matches.filter(row => present(row.recrtTitle)).length,
      denominator: selection.matches.length, observedTitleExamples: selection.matches.slice(0, 3).map(row => ({ id: row.jobId, rawTitle: row.recrtTitle })) }, allowNoPreference: true });
  const appliedFilters = criteriaFields.filter(key => state[key]).map(key => ({ field: key, value: state[key], operator: key === 'employmentCode' ? 'exact' : 'contains_canonical' }));
  if (!selection.matches.length && (mode === 'search' || appliedFilters.length)) questions.splice(0, questions.length,
    { key: 'broaden', text: '저장된 부분 표본에서는 이 조건에 일치하는 공고가 없습니다. 지역이나 일의 종류를 넓혀서 다시 볼까요?',
      unknownCandidates: selection.unknownCount, requiresUserChoice: true });
  const nextAction = !selection.matches.length && appliedFilters.length ? 'ask_before_broadening'
    : mode === 'describe' && questions.length ? 'ask_questions' : mode === 'describe' ? 'search_jobs'
    : selection.matches.length ? 'present_matches_and_wait_for_selection' : 'ask_before_broadening';
  return { contractVersion: playbook.version, conditionState: state, appliedFilters,
    candidateCounts: { stored: totalStored, eligibleBeforeFilters: eligibleRows.length, confirmedAfterFilters: selection.matches.length,
      unknownAfterFilters: selection.unknownCount, mismatchAfterFilters: selection.mismatchCount, excludedByStoredPeriodOrStatus: totalStored - eligibleRows.length },
    unknownFilterEvidence: selection.unknownEvidenceCounts,
    distributionScope: 'all_confirmed_filtered_matches_before_paging',
    nextQuestion: questions[0] || null, suggestedQuestions: questions.slice(0, 2), nextAction,
    judgementPolicy: 'host_decides_from_observed_evidence;missing_is_not_mismatch;no_inferred_eligibility',
    zeroResultPolicy: 'zero_in_partial_sample_only;do_not_silently_relax_filters',
    scenarioInstructions: 'Ask only unanswered useful questions; use explicit anyRegion/anyWork for no preference; retrieve details only for selected IDs or explicitly requested contact.' };
}

module.exports = { instructions: playbook.instructions, version: playbook.version, criteriaFields, preferenceFlags,
  conditions, fieldEvidence, assess, filterCandidates, factors, contract };
