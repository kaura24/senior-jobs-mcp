'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const refresh = require('../refresh/snapshot-refresh');
const at = '2026-10-12T08:00:00Z';
const row = (id, deadline = '접수중', toDd = '20261020') => ({ jobId: id, recrtTitle: '테스트 모집', oranNm: '공개 기관',
  workPlcNm: '서울 강남구', frDd: '20261001', toDd, deadline });
const previous = { metadata: { observedAt: '2026-10-11T08:00:00Z', storedListJobs: 2 }, jobs: [row('old'), row('expired', '접수중', '20261011')], detailSummaries: {} };

test('refresh adds new valid jobs and excludes observed closures and expired cache without claiming partial scan is complete', () => {
  const result = refresh.prepare(previous, [{ pageNo: 1, totalCount: 20, items: [row('old', '마감'), row('new')] }], at, 2);
  assert.deepEqual(result.jobs.map(job => job.jobId), ['new']);
  assert.equal(result.metadata.coverageVerified, false);
  assert.equal(result.metadata.refresh.newlyObservedActive, 1);
  assert.equal(result.metadata.refresh.excludedInObservedScope, 1);
  assert.equal(result.metadata.refresh.removedExpiredCached, 1);
});

test('out-of-scope cache is retained with its old observation rather than marked freshly revalidated', () => {
  const result = refresh.prepare(previous, [{ pageNo: 1, totalCount: 20, items: [row('new')] }], at, 2);
  assert.equal(result.metadata.refresh.retainedNotRevalidated, 1);
  assert.equal(result.metadata.sourceObservedById.old, previous.metadata.observedAt);
  assert.equal(result.metadata.sourceObservedById.new, at);
});

test('repeated pages and changing total reject the candidate', () => {
  assert.throws(() => refresh.prepare(previous, [{ pageNo: 1, totalCount: 4, items: [row('one')] }, { pageNo: 2, totalCount: 4, items: [row('one')] }], at, 2), /REPEATED_PAGE/);
  assert.throws(() => refresh.prepare(previous, [{ pageNo: 1, totalCount: 4, items: [row('one')] }, { pageNo: 2, totalCount: 5, items: [row('two')] }], at, 2), /TOTAL_CHANGED_DURING_SCAN/);
});

test('failed atomic switch preserves the previous snapshot and immutable old release', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-refresh-test-'));
  try {
    refresh.publish(directory, previous);
    assert.throws(() => refresh.publish(directory, { ...previous, jobs: [row('new')] }, () => { throw new Error('simulated_switch_failure'); }), /simulated_switch_failure/);
    assert.deepEqual(refresh.current(directory), previous);
    assert.equal(fs.readdirSync(path.join(directory, 'releases')).length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
