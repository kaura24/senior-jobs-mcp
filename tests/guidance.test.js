'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../lib/jobs');
const regions = require('../lib/regions');
const now = new Date('2026-10-12T08:00:00Z');

test('unconditional guidance lists complete database province counts and separates missing/unrecognized', () => {
  const result = jobs.describeOptions({}, now);
  const aggregate = result.factors.region.normalized;
  assert.equal(aggregate.denominator, 314);
  assert.equal(aggregate.providedJobs, 157);
  assert.equal(aggregate.missingJobs, 157);
  assert.equal(aggregate.recognizedProvinceJobs, 152);
  assert.equal(aggregate.unrecognizedJobs, 5);
  assert.equal(aggregate.provinces.reduce((n, row) => n + row.count, 0), 152);
  assert.deepEqual(result.uiGuidance.options, aggregate.provinces);
  assert.equal(result.uiGuidance.optionsComplete, true);
  assert.equal(result.uiGuidance.allowAny, true);
  assert.equal(result.uiGuidance.allowFreeText, true);
  assert.equal(result.uiGuidance.recommendationRanking, false);
  assert.equal(result.uiGuidance.questionOrderMandatory, false);
  const expectedGyeonggi = jobs.snapshot.jobs.filter(row => /^경기(?:도)?\s/.test(row.workPlcNm || '')).length;
  assert.equal(result.uiGuidance.options.find(option => option.value === '경기').count, expectedGyeonggi);
  assert.ok(!result.uiGuidance.options.some(option => option.value === '광주' || option.value === '전남'));
});

test('raw region is preserved and ambiguous values are never completed into an inferred district', () => {
  assert.deepEqual(regions.normalize('전남광주 남구'), { raw: '전남광주 남구', state: 'unrecognized', province: null, cityDistrict: null });
  const incomplete = regions.normalize('서울 강남');
  assert.equal(incomplete.province, '서울');
  assert.equal(incomplete.cityDistrict, null);
  assert.equal(incomplete.state, 'province_only');
  const aggregate = regions.distribution([{ workPlcNm: '' }, { workPlcNm: '알수없음 동네' }, { workPlcNm: '서울 강남구' }]);
  assert.equal(aggregate.denominator, 3);
  assert.equal(aggregate.missingJobs, 1);
  assert.equal(aggregate.unrecognizedJobs, 1);
  assert.equal(aggregate.recognizedProvinceJobs, 1);
});

test('region only asks work while supplied region and work advance immediately to search', () => {
  const regionOnly = jobs.describeOptions({ region: '강원 원주시' }, now);
  assert.equal(regionOnly.nextQuestion.key, 'keyword');
  assert.equal(regionOnly.uiGuidance.optionCoverage.titleKeywordSearchSupported, true);
  const ready = jobs.describeOptions({ region: '전주', keyword: '경비원' }, now);
  assert.equal(ready.nextQuestion, null);
  assert.equal(ready.uiGuidance.nextAction, 'search_jobs');
});

test('two-condition search and a changed region preserve the supplied work condition', () => {
  const first = jobs.searchJobs({ region: '강원 원주시', keyword: '경비원', limit: 3 }, now);
  const next = jobs.searchJobs({ region: '대구', keyword: first.conditionState.keyword, limit: 3 }, now);
  assert.equal(next.conditionState.region, '대구');
  assert.equal(next.conditionState.keyword, '경비원');
  assert.ok(next.jobs.every(job => job.region.includes('대구') && job.filterAssessment.state === 'match'));
});

test('no schedule and old source evidence are disclosed while expired rows are excluded at query time', () => {
  const result = jobs.searchJobs({}, new Date('2030-01-01T00:00:00Z'));
  assert.equal(result.totalMatches, 0);
  assert.equal(result.context.statusRevalidation.currentLiveStatusVerified, false);
  assert.equal(result.context.statusRevalidation.schedulerEnabled, false);
  assert.equal(result.context.statusRevalidation.queryApplicationPeriodRechecked, true);
  assert.equal(result.context.sourceFreshness, 'stale_static_snapshot');
});
