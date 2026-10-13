'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../lib/jobs');
const curation = require('../lib/curation');
const { respond, tools } = require('../lib/protocol');
const now = new Date('2026-10-11T17:00:00Z');

test('vague exploration asks only region and work, using actual field coverage', () => {
  const result = jobs.describeOptions({}, now);
  assert.deepEqual(result.suggestedQuestions.map(q => q.key), ['region', 'keyword']);
  assert.equal(result.nextAction, 'ask_questions');
  assert.equal(result.nextQuestion.evidence.providedJobs, 157);
  assert.equal(result.nextQuestion.evidence.missingJobs, 157);
  assert.equal(result.conditionState.region, null);
  assert.equal(result.candidateCounts.confirmedAfterFilters, 314);
  assert.equal(result.factors.salary.providedJobs, 0);
  assert.equal(result.factors.ageEligibility.confirmationRequired, true);
});

test('described and searched distributions use all filtered candidates before paging', () => {
  const options = jobs.describeOptions({ region: '원주', anyWork: true }, now);
  const search = jobs.searchJobs({ region: '원주', anyWork: true, limit: 1 }, now);
  assert.equal(search.totalMatches, 7);
  assert.equal(search.jobs.length, 1);
  assert.equal(search.candidateCounts.eligibleBeforeFilters, 314);
  assert.equal(search.candidateCounts.confirmedAfterFilters, 7);
  assert.equal(search.factors.region.denominator, 7);
  assert.equal(search.factors.region.values[0].value, '강원 원주시');
  assert.equal(search.factors.region.values[0].count, 7);
  assert.deepEqual(options.factors, search.factors);
  assert.equal(options.nextQuestion, null);
  assert.equal(options.nextAction, 'search_jobs');
});

test('a missing source place is unknown, a known different place is mismatch', () => {
  const state = curation.conditions({ region: '전주', keyword: '경비원' });
  const fixtures = [
    { jobId: 'a', recrtTitle: '경비원 모집', workPlcNm: '전북 전주시 완산구' },
    { jobId: 'b', recrtTitle: '경비원 모집' },
    { jobId: 'c', recrtTitle: '경비원 모집', workPlcNm: '서울 종로구' },
  ];
  const result = curation.filterCandidates(fixtures, state);
  assert.deepEqual(result.matches.map(row => row.jobId), ['a']);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.mismatchCount, 1);
  assert.equal(curation.fieldEvidence(fixtures[1]).region.state, 'unknown');
  assert.equal(curation.fieldEvidence(fixtures[1]).salary.state, 'not_collected');
  const evidence = curation.assess(fixtures[0], state).evidence;
  assert.equal(evidence[0].sourceField, 'workPlcNm');
  assert.equal(evidence[0].rawValue, fixtures[0].workPlcNm);
  assert.equal(evidence[0].requestedValue, '전주');
  assert.equal(evidence[1].observedSourceValues.find(x => x.sourceField === 'recrtTitle').matched, true);
});

test('zero confirmed matches with unknown locations explains missing evidence without broadening', () => {
  const state = curation.conditions({ region: '서울' });
  const rows = [{ jobId: 'missing', recrtTitle: '서울 업무 안내', workPlc: '010150' }];
  const result = curation.contract(state, rows, 1, curation.filterCandidates(rows, state), 'search');
  assert.equal(result.candidateCounts.confirmedAfterFilters, 0);
  assert.equal(result.candidateCounts.unknownAfterFilters, 1);
  assert.equal(result.candidateCounts.mismatchAfterFilters, 0);
  assert.equal(result.conditionState.region, '서울');
  assert.equal(result.nextAction, 'explain_unknown_candidates');
  assert.equal(result.nextQuestion.key, 'confirm_missing_fields');
  assert.match(result.nextQuestion.text, /근무지명.*미기재.*1건/);
  assert.doesNotMatch(result.nextQuestion.text, /공고가 없습니다|넓혀/);
  assert.deepEqual(result.uiGuidance.options, []);
});

test('known different locations produce a real zero in the stored sample', () => {
  const state = curation.conditions({ region: '서울', anyWork: true });
  const rows = [{ jobId: 'different', workPlcNm: '부산 중구' }];
  const result = curation.contract(state, rows, 1, curation.filterCandidates(rows, state), 'search');
  assert.equal(result.candidateCounts.unknownAfterFilters, 0);
  assert.equal(result.candidateCounts.mismatchAfterFilters, 1);
  assert.equal(result.nextAction, 'ask_before_broadening');
  assert.equal(result.nextQuestion.key, 'broaden');
});

test('explicit no preference and changed conditions do not retain stale work filters', () => {
  const original = jobs.searchJobs({ region: '전주', keyword: '경비원' }, now);
  const changed = jobs.searchJobs({ region: '원주', keyword: '', anyWork: true, employmentCode: 'CM0103' }, now);
  assert.equal(original.totalMatches, 1);
  assert.equal(changed.conditionState.region, '원주');
  assert.equal(changed.conditionState.keyword, null);
  assert.equal(changed.conditionState.anyWork, true);
  assert.ok(changed.jobs.every(row => row.region === '강원 원주시' && row.employmentCode === 'CM0103'));
  const expectedIds = jobs.snapshot.jobs.filter(row => row.workPlcNm === '강원 원주시' && row.emplymShp === 'CM0103').map(row => row.jobId);
  assert.deepEqual(changed.jobs.map(row => row.id), expectedIds);
  const any = jobs.describeOptions({ anyRegion: true, anyWork: true }, now);
  assert.equal(any.nextQuestion, null);
  assert.throws(() => jobs.describeOptions({ anyRegion: true, region: '전주' }, now));
  assert.throws(() => jobs.searchJobs({ anyWork: true, keyword: '경비' }, now));
});

test('zero results preserve exact filters and ask before widening the partial sample search', () => {
  const result = jobs.searchJobs({ region: '서귀포', keyword: '잠수함 조종사' }, now);
  assert.equal(result.totalMatches, 0);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.conditionState.region, '서귀포');
  assert.equal(result.conditionState.keyword, '잠수함 조종사');
  assert.equal(result.factors.region.denominator, 0);
  assert.equal(result.factors.region.providedRate, null);
  assert.equal(result.nextAction, 'ask_before_broadening');
  assert.equal(result.nextQuestion.requiresUserChoice, true);
  assert.equal(result.context.coverageVerified, false);
});

test('selected detail separates title evidence, uncollected fields and actual filter mismatch', () => {
  const result = jobs.getDetails({ id: 'KJ21062610080016', region: '서울' }, now);
  assert.equal(result.job.filterAssessment.state, 'mismatch');
  assert.equal(result.job.fieldEvidence.region.rawValue, '전북 전주시 완산구');
  assert.equal(result.job.fieldEvidence.workTime.state, 'not_collected');
  assert.equal(result.job.fieldEvidence.ageEligibility.state, 'not_collected');
  assert.equal(result.rawListFields.recrtTitle, '[평화동 건설현장 격일제] 경비원 모집');
  assert.equal(result.cachedDetailSummary.fullResponseStored, false);
  assert.equal(result.contact.telephoneRaw, '031-8045-3268');
  assert.equal(result.context.jobsWithoutDetail, 313);
  assert.equal(result.context.cachedDetailSummaries, 1);
  assert.equal(result.nextQuestion, null);
});

test('count accounting and raw evidence hold for each real filter combination', () => {
  for (const args of [{}, { region: '전주' }, { region: '전주', keyword: '경비원' }, { employmentCode: 'CM0103' }, { region: '원주', employmentCode: 'CM0103' }]) {
    const result = jobs.searchJobs({ ...args, limit: 3 }, now);
    const counts = result.candidateCounts;
    assert.equal(counts.confirmedAfterFilters + counts.unknownAfterFilters + counts.mismatchAfterFilters, counts.eligibleBeforeFilters);
    assert.equal(counts.eligibleBeforeFilters + counts.excludedByStoredPeriodOrStatus, counts.stored);
    assert.equal(result.factors.region.denominator, result.totalMatches);
    assert.ok(result.jobs.every(job => job.filterAssessment.state === 'match'));
  }
});

test('MCP loads the reusable curation instructions and accepts only small condition fields', () => {
  const response = respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, now);
  assert.equal(response.result.serverInfo.version, require('../package.json').version);
  assert.equal(response.result.instructions, curation.instructions);
  assert.equal(tools.length, 3);
  assert.ok(tools[0].inputSchema.properties.region);
  assert.ok(tools[1].inputSchema.properties.anyWork);
  for (const extra of [{ conversation: 'not needed' }, { health: 'not transmitted' }, { apiKey: 'not needed' }]) {
    assert.throws(() => jobs.describeOptions(extra, now));
  }
  assert.throws(() => jobs.searchJobs({ keyword: 'x'.repeat(201) }, now));
});

test('every result and detail provides the exact snapshot and detail-coverage notice', () => {
  for (const result of [jobs.searchJobs({ region: '전주', keyword: '경비원' }, now),
    jobs.searchJobs({ keyword: '잠수함 조종사' }, now), jobs.getDetails({ id: 'KJ21062610080016' }, now)]) {
    assert.equal(result.answerNotice.requiredInResultAnswers, true);
    assert.equal(result.answerNotice.observedAt, jobs.snapshot.metadata.observedAt);
    assert.equal(result.answerNotice.observedAtKst, '2026-10-12 01:19:42 KST');
    assert.equal(result.answerNotice.storedListJobs, 314);
    assert.equal(result.answerNotice.cachedDetailSummaries, 1);
    assert.equal(result.answerNotice.jobsWithoutDetail, 313);
    assert.equal(result.answerNotice.fullDetailDocuments, 0);
  }
  const query = jobs.searchJobs({ region: '전주시 완산구', keyword: '경비원' }, now);
  assert.deepEqual(query.unknownFilterEvidence, { region: 31 });
});
