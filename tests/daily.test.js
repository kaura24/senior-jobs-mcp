'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { digest, loadDataset } = require('../lib/blob-store');
const { runDailyChunk } = require('../refresh/daily');
const { parseDetail } = require('../refresh/source');
const { withDataset } = require('../lib/job-context');
const jobs = require('../lib/jobs');
const row = id => ({ jobId: id, recrtTitle: 'Title ' + id, oranNm: '기관', workPlcNm: '서울 강남구',
  frDd: '20261001', toDd: '20261120', deadline: '접수중' });
function setup(count = 4) {
  let clock = Date.parse('2026-10-12T11:00:00Z'), revision = 1;
  const snapshot = { metadata: { observedAt: '2026-10-11T08:00:00Z', storedListJobs: count, cachedDetailSummaries: 0,
    jobsWithoutDetail: count, fullDetailDocuments: 0 }, jobs: Array.from({ length: count }, (_, index) => row('id' + index)), detailSummaries: {} };
  let current = { value: { schemaVersion: 1, snapshot, sha256: digest(snapshot), refreshState: { lastSuccessfulAt: null } }, etag: 'v1' }, control = null;
  const calls = [], sourceRows = new Map(snapshot.jobs.map(item => [item.jobId, item]));
  const store = {
    failCurrent: false, failFinish: false,
    readCurrent: async () => structuredClone(current), readControl: async () => structuredClone(control),
    async writeCurrent(value, etag) {
      if (this.failCurrent) throw new Error('quota');
      assert.equal(etag, current.etag);
      current = { value: structuredClone(value), etag: 'v' + (++revision) }; return { etag: current.etag };
    },
    async writeControl(value, etag) {
      if (this.failFinish && !value.leaseUntil) throw new Error('checkpoint unavailable');
      assert.equal(etag, control?.etag);
      control = { value: structuredClone(value), etag: 'v' + (++revision) }; return { etag: control.etag };
    },
  };
  const source = {
    async detail(id) { clock++; calls.push({ kind: 'detail', id }); return { id, title: 'Title ' + id, from: '20261001', to: '20261120' }; },
    async list(pageNo, pageSize, search) {
      clock++; calls.push({ kind: search ? 'target' : 'discovery', pageNo, search });
      const items = search ? [...sourceRows.values()].filter(item => item.recrtTitle === search) : [];
      return { pageNo, totalCount: items.length, items };
    },
  };
  return { store, source, calls, sourceRows, now: () => new Date(clock), skip: milliseconds => { clock += milliseconds; } };
}
test('all 314 existing IDs are checked before discovery across time-bounded resumable chunks', async () => {
  const s = setup(314); let result, chunks = 0;
  do {
    result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 50 }); chunks++;
    assert.ok(chunks < 30);
    if (result.progress.confirmedIds < 314) assert.equal(result.progress.complete, false);
  } while (result.continue);
  assert.equal(result.progress.confirmedIds, 314); assert.equal(result.progress.complete, true);
  assert.equal(result.progress.targetIds, 314); assert.equal(result.progress.discoveryUniqueCoverageVerified, false);
  assert.equal(s.calls.filter(call => call.kind === 'detail').length, 314);
  assert.equal(s.calls.filter(call => call.kind === 'target').length, 314);
  assert.ok(s.calls.findIndex(call => call.kind === 'discovery') >= 628);
  assert.equal(result.state, 'completed_partial_source');
});
test('an ID absent from title results remains unverified and never becomes a confirmed closure', async () => {
  const s = setup(2); s.sourceRows.delete('id1');
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(result.state, 'completed_with_unverified_ids');
  assert.deepEqual(result.progress.unverifiedIds, ['id1']);
  const current = (await s.store.readCurrent()).value;
  assert.ok(current.snapshot.jobs.some(item => item.jobId === 'id1'));
  assert.equal(current.snapshot.metadata.sourceObservedById.id1, '2026-10-11T08:00:00Z');
  assert.equal(current.refreshState.lastSuccessfulAt, null);
});
test('fresh list closure removes an old job and discovery adds a new accepting job', async () => {
  const s = setup(1); s.sourceRows.set('id0', { ...row('id0'), deadline: '마감' });
  const original = s.source.list;
  s.source.list = async (pageNo, size, search) => search ? original(pageNo, size, search) : { pageNo, totalCount: 1, items: [row('new')] };
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(result.progress.complete, true);
  assert.deepEqual((await s.store.readCurrent()).value.snapshot.jobs.map(item => item.jobId), ['new']);
});

test('a fresh missing region retains prior region evidence separately without making it a current match', async () => {
  const s = setup(1);
  const fresh = { ...row('id0'), workPlc: 'new-code' }; delete fresh.workPlcNm;
  s.sourceRows.set('id0', fresh);
  await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  const current = (await s.store.readCurrent()).value;
  assert.equal(current.snapshot.jobs[0].workPlcNm, undefined);
  const prior = current.snapshot.metadata.regionHistoryById.id0;
  assert.equal(prior.rawValue, '서울 강남구');
  assert.equal(prior.observedAt, '2026-10-11T08:00:00Z');
  const result = withDataset(current, () => jobs.getDetails({ id: 'id0', region: '서울' }, s.now()));
  assert.equal(result.job.region, null);
  assert.equal(result.job.filterAssessment.state, 'unknown');
  assert.equal(result.job.fieldEvidence.region.state, 'unknown');
  assert.equal(result.job.fieldEvidence.region.previousObservation.rawValue, '서울 강남구');
  assert.equal(result.job.fieldEvidence.region.previousObservation.observedAt, '2026-10-11T08:00:00Z');
  assert.equal(result.job.fieldEvidence.region.workPlc, 'new-code');
  assert.equal(result.job.fieldEvidence.region.previousObservation.workPlc, null);
  const options = withDataset(current, () => jobs.describeOptions({}, s.now()));
  assert.equal(options.factors.region.providedJobs, 0);
  assert.deepEqual(options.uiGuidance.options, []);
  assert.equal(options.factors.region.previousObservations.providedJobs, 1);
});

test('the original region checkpoint time and hash survive a missing field refresh', async () => {
  const { createDay, advance } = require('../refresh/daily');
  const snapshot = structuredClone(require('../data/jobs.json'));
  const original = snapshot.jobs[0], history = structuredClone(snapshot.metadata.regionHistoryById[original.jobId]);
  snapshot.jobs = [original];
  const plan = createDay(snapshot,null,'2026-10-12T11:00:00Z');
  const fresh = { ...original }; delete fresh.workPlcNm;
  const source = { detail: async()=>({ id:original.jobId,title:original.recrtTitle }),
    list: async()=>({pageNo:1,totalCount:1,items:[fresh]}) };
  await advance(plan,source,'2026-10-12T11:00:00Z',1000);
  await advance(plan,source,'2026-10-12T11:00:01Z',1000);
  assert.deepEqual(plan.candidate.metadata.regionHistoryById[original.jobId],history);
  assert.equal(plan.candidate.jobs[0].workPlcNm,undefined);
});

test('a new explicit source region replaces the prior value without matching the old location', async () => {
  const s=setup(1);s.sourceRows.set('id0',{...row('id0'),workPlcNm:'전북 전주시 완산구',plDetAddr:'서울 사업장 주소'});
  await runDailyChunk({store:s.store,source:s.source,now:s.now});
  const current=(await s.store.readCurrent()).value;
  const result=withDataset(current,()=>jobs.getDetails({id:'id0',region:'서울'},s.now()));
  assert.equal(result.job.region,'전북 전주시 완산구');assert.equal(result.job.filterAssessment.state,'mismatch');
  assert.equal(result.job.fieldEvidence.region.previousObservation.rawValue,'서울 강남구');
  assert.notEqual(result.job.fieldEvidence.region.observedAt,result.job.fieldEvidence.region.previousObservation.observedAt);
});
test('failed source resumes the pending ID and page without discarding earlier confirmed evidence', async () => {
  const s = setup(3), original = s.source.list; let fail = true;
  s.source.list = async (pageNo, size, search) => {
    if (search === 'Title id1' && fail) { const cause = new Error('redacted'); cause.code = 'UPSTREAM_RATE_LIMIT'; throw cause; }
    return original(pageNo, size, search);
  };
  const before = (await s.store.readCurrent()).value.sha256;
  const first = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(first.state, 'paused_incomplete'); assert.equal(first.progress.confirmedIds, 1);
  assert.equal((await s.store.readCurrent()).value.sha256, before);
  assert.equal((await s.store.readControl()).value.plan.pending.id, 'id1');
  fail = false;
  const resumed = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(resumed.progress.confirmedIds, 3);
  assert.equal(s.calls.filter(call => call.kind === 'detail' && call.id === 'id0').length, 1);
});
test('discovery crosses more than three pages with a separate durable cursor and no complete national claim', async () => {
  const s = setup(1), original = s.source.list;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.skip(5); s.calls.push({ kind: 'discovery', pageNo });
    return { pageNo, totalCount: 8, items: [row('new' + pageNo)] };
  };
  let result;
  do { result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 9 }); } while (result.continue);
  assert.deepEqual(s.calls.filter(call => call.kind === 'discovery').map(call => call.pageNo), [1,2,3,4,5,6,7,8]);
  assert.equal(result.progress.discoveryPageTraversalEnded, true);
  assert.equal((await s.store.readCurrent()).value.snapshot.metadata.coverageVerified, false);
});
test('snapshot commit provides the resume cursor when the later control checkpoint fails', async () => {
  const s = setup(4); s.store.failFinish = true;
  const first = await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  assert.equal(first.state, 'paused_incomplete');
  assert.equal((await s.store.readCurrent()).value.runPlan.index, 1);
  s.skip(100000); s.store.failFinish = false;
  const next = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(next.progress.confirmedIds, 4);
  assert.equal(s.calls.filter(call => call.kind === 'detail' && call.id === 'id0').length, 1);
});
test('the next KST day begins revalidation of every still-published ID instead of carrying yesterday completeness', async () => {
  const s = setup(2); await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  s.skip(24 * 3600000);
  const next = await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 1 });
  assert.equal(next.progress.dayKst, '2026-10-13'); assert.equal(next.progress.confirmedIds, 0);
  assert.equal(next.progress.complete, false); assert.equal(next.progress.targetIds, 2);
});
test('published partial progress is carried to MCP notices and KST expiry is rechecked', async () => {
  const s = setup(3); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  const dataset = await loadDataset(s.store, true);
  const search = withDataset(dataset, () => jobs.searchJobs({}, s.now()));
  assert.equal(search.context.statusRevalidation.dailyRevalidation.confirmedIds, 1);
  assert.match(search.answerNotice.text, /1\/3/);
  assert.equal(withDataset(dataset, () => jobs.searchJobs({}, new Date('2030-01-01T00:00:00Z'))).totalMatches, 0);
});
test('detail parser retains only current title and period, never inferring a raw accepting marker', () => {
  const xml = '<response><header><resultCode>00</resultCode></header><body><item><jobId>id</jobId><wantedTitle>Fresh</wantedTitle><frAcptDd>20261001</frAcptDd><toAcptDd>20261120</toAcptDd><clerkContt>not collected</clerkContt></item></body></response>';
  assert.deepEqual(parseDetail(xml, 'id'), { id: 'id', title: 'Fresh', from: '20261001', to: '20261120' });
  assert.throws(() => parseDetail(xml, 'other'), /DETAIL_ID_MISMATCH/);
  assert.throws(() => parseDetail('<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>22</returnReasonCode><errMsg>redacted</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>', 'id'), /UPSTREAM_DAILY_LIMIT/);
});
test('a repeated final discovery page leaves a coverage gap and cannot claim overall success', async () => {
  const s = setup(1), original = s.source.list;
  s.source.list = async (pageNo, size, search) => search ? original(pageNo, size, search) : { pageNo, totalCount: 2, items: [row('same')] };
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.equal(result.state, 'completed_with_discovery_gaps');
  assert.equal(result.progress.complete, true); assert.equal(result.progress.discoveryUniqueCoverageVerified, false);
  assert.equal(result.progress.discoveryPageTraversalEnded, true);
  assert.deepEqual(result.progress.discoveryCoverageGaps.map(gap => [gap.fromPage, gap.toPage]), [[2,2]]);
  assert.equal((await s.store.readCurrent()).value.refreshState.lastSuccessfulAt, null);
});
test('a mismatched requested page size or nonfinal short page cannot advance the discovery cursor', async () => {
  for (const reportedNumOfRows of [1, undefined]) {
    const s = setup(0);
    s.source.list = async pageNo => ({ pageNo, reportedNumOfRows, totalCount: 4, items: [row('one')] });
    const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 2 });
    assert.equal(result.errorCode, reportedNumOfRows ? 'SOURCE_PAGE_SIZE_MISMATCH' : 'NONFINAL_SHORT_PAGE');
    assert.equal(result.progress.discoveryNextPage, 1);
  }
});
test('the documented API call budget pauses without reporting successful current revalidation', async () => {
  const s = setup(1); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 0 });
  const control = await s.store.readControl(); control.value.plan.calls = 10000;
  await s.store.writeControl(control.value, control.etag);
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(result.errorCode, 'DOCUMENTED_DAILY_CALL_BUDGET');
  assert.equal(result.progress.confirmedIds, 0); assert.equal(result.progress.complete, false);
});
test('the prepared source probe measures all current IDs without executing discovery or exposing source rows', async () => {
  const s = setup(314), { probe } = require('../scripts/verify-source-revalidation');
  const result = await probe(s.source, (await s.store.readCurrent()).value.snapshot, s.now);
  assert.equal(result.success, true); assert.equal(result.existingIds.confirmedIds, 314);
  assert.equal(result.discoveryExecuted, false); assert.equal(s.calls.some(call => call.kind === 'discovery'), false);
  assert.equal(result.existingIds.sourceCalls, 628);
  assert.equal(JSON.stringify(result).includes('recrtTitle'), false);
});
test('a resumed discovery cursor still checks the new daily first page without restarting existing-ID work', async () => {
  const s = setup(1), original = s.source.list;
  let newDay = false;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.skip(5); s.calls.push({ kind: 'discovery', pageNo });
    const observed = row(newDay && pageNo === 1 ? 'new-today' : 'page' + pageNo);
    s.sourceRows.set(observed.jobId, observed);
    return { pageNo, totalCount: 10, items: [observed] };
  };
  const first = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 8 });
  assert.equal(first.continue, true);
  const before = (await s.store.readControl()).value.plan.discovery.nextPage;
  assert.ok(before > 1);
  s.skip(24 * 3600000); newDay = true;
  const callsBefore = s.calls.length;
  const second = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 15 });
  assert.equal(second.progress.complete, true);
  assert.equal(s.calls.slice(callsBefore).filter(call => call.kind === 'discovery')[0].pageNo, 1);
  assert.ok((await s.store.readCurrent()).value.snapshot.jobs.some(item => item.jobId === 'new-today'));
});
test('partial publication preserves unobserved ID timestamps even when the old observation is from the same KST day', async () => {
  const s = setup(3), initial = await s.store.readCurrent();
  initial.value.snapshot.metadata.observedAt = '2026-10-12T00:00:00Z';
  initial.value.sha256 = digest(initial.value.snapshot);
  await s.store.writeCurrent(initial.value, initial.etag);
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  const published = (await s.store.readCurrent()).value.snapshot;
  assert.equal(published.metadata.sourceObservedById.id1, '2026-10-12T00:00:00Z');
  assert.deepEqual(published.metadata.refresh.latestStatusRevalidatedIds, ['id0']);
  assert.equal(published.metadata.refresh.retainedNotRevalidated, 2);
  const dataset = await loadDataset(s.store, true);
  const result = withDataset(dataset, () => jobs.getDetails({ id: 'id1' }, s.now()));
  assert.equal(result.job.sourceObservedAt, '2026-10-12T00:00:00Z');
  assert.equal(result.job.dailyRevalidationState, 'unverified');
});

test('changing global totals preserve forward discovery and never assert unique national coverage', async () => {
  const s = setup(1), original = s.source.list;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.skip(5); s.calls.push({ kind: 'discovery', pageNo });
    return { pageNo, totalCount: pageNo < 2 ? 5 : pageNo < 4 ? 6 : 4, items: [row('new' + pageNo)] };
  };
  let result;
  do { result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 9 }); } while (result.continue);
  assert.deepEqual(s.calls.filter(call => call.kind === 'discovery').map(call => call.pageNo), [1,2,3,4]);
  const current = (await s.store.readCurrent()).value;
  assert.equal(current.snapshot.metadata.refresh.discovery.sourceTotalsChanged, true);
  assert.equal(current.snapshot.metadata.refresh.discovery.totalChanges.length, 2);
  assert.equal(current.snapshot.metadata.coverageVerified, false);
});
test('a legacy total-change pause resumes its durable page instead of resetting discovery', async () => {
  const s = setup(0); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 0 });
  const control = await s.store.readControl();
  Object.assign(control.value.plan, { phase: 'discovery', errorCode: 'TOTAL_CHANGED_DURING_SCAN' });
  Object.assign(control.value.plan.discovery, { nextPage: 12, total: 20, hashes: { 1: 'old' }, scannedRows: 11, errorCode: 'TOTAL_CHANGED_DURING_SCAN' });
  await s.store.writeControl(control.value, control.etag);
  s.source.list = async pageNo => { s.skip(5); s.calls.push({ kind: 'discovery', pageNo }); return { pageNo, totalCount: 21, items: [row('new' + pageNo)] }; };
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 4 });
  assert.equal(s.calls[0].pageNo, 12); assert.equal(result.progress.discoveryNextPage, 13);
});
test('new-day discovery head accepts changed totals while preserving the prior cursor', async () => {
  const s = setup(0); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 0 });
  const control = await s.store.readControl();
  Object.assign(control.value.plan.discovery, { nextPage: 12, total: 20, hashes: { 1: 'old' }, scannedRows: 11, errorCode: 'TOTAL_CHANGED_DURING_SCAN' });
  await s.store.writeControl(control.value, control.etag); s.skip(24 * 3600000);
  s.source.list = async pageNo => { s.skip(5); s.calls.push({ kind: 'discovery', pageNo }); return { pageNo, totalCount: 21, items: [row('new' + pageNo)] }; };
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 9 });
  assert.deepEqual(s.calls.map(call => call.pageNo), [1,12]);
});
test('title-search total changes remain a strict existing-ID validation failure', async () => {
  const s = setup(1); s.source.list = async pageNo => ({ pageNo, totalCount: pageNo === 1 ? 2 : 3, items: [row('other' + pageNo)] });
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.equal(result.errorCode, 'TOTAL_CHANGED_DURING_SCAN'); assert.equal(result.progress.complete, false);
});
test('published existing-ID success keeps its evidence and time when later discovery becomes ambiguous or fails', async () => {
  const s = setup(1), original = s.source.list;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.skip(5); return { pageNo, totalCount: 2, items: [{ ...row('id0'), deadline: '' }] };
  };
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 6 });
  const committed = (await s.store.readCurrent()).value;
  const scope = committed.snapshot.metadata.refresh.existingIdsRevalidation;
  assert.equal(scope.state, 'succeeded'); assert.equal(scope.confirmedIds, 1);
  assert.equal(scope.verificationEvidence.statusAndPeriodAccepting, 1);
  assert.ok(scope.verifiedAt); assert.ok(scope.publishedAt);
  const failed = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.equal(failed.state, 'completed_with_discovery_gaps');
  const dataset = await loadDataset(s.store, true, s.now);
  const response = withDataset(dataset, () => jobs.describeOptions({}, s.now()));
  assert.deepEqual(response.context.statusRevalidation.existingIdsRevalidation, scope);
  assert.equal(response.context.statusRevalidation.state, 'completed_with_discovery_gaps');
  assert.equal(response.context.statusRevalidation.lastSuccessfulAt, null);
  assert.equal(response.context.sourceFreshness, 'source_revalidated_snapshot');
});

test('an empty final source page with a positive total pauses and preserves the prior snapshot', async () => {
  const s = setup(1), original = s.source.list;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.skip(5); return { pageNo, totalCount: 2, items: pageNo === 1 ? [row('new')] : [] };
  };
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 6 });
  const before = (await s.store.readCurrent()).value.sha256;
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.equal(result.errorCode, 'EMPTY_SOURCE_PAGE'); assert.equal(result.progress.discoveryPageTraversalEnded, false);
  assert.equal((await s.store.readCurrent()).value.sha256, before);
  assert.equal((await s.store.readControl()).value.plan.discovery.nextPage, 2);
});

test('a newer published cursor keeps its evidence but exposes the older orphaned lease as interrupted', async () => {
  const s = setup(4); s.store.failFinish = true;
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 }); s.skip(100000);
  const dataset = await loadDataset(s.store, true, s.now);
  assert.equal(dataset.refreshState.dailyRevalidation.confirmedIds, 1);
  assert.equal(dataset.refreshState.state, 'interrupted_incomplete');
  assert.equal(dataset.refreshState.errorCode, 'LEASE_EXPIRED_WITHOUT_CHECKPOINT');
});

test('a source total shrinking behind the saved cursor restarts discovery without treating the empty response as completion', async () => {
  const s = setup(0); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 0 });
  const control = await s.store.readControl();
  Object.assign(control.value.plan, { phase: 'discovery' });
  Object.assign(control.value.plan.discovery, { nextPage: 12, total: 20, hashes: { 1: 'old' }, scannedRows: 11 });
  await s.store.writeControl(control.value, control.etag);
  s.source.list = async pageNo => { s.skip(5); s.calls.push({ kind: 'discovery', pageNo }); return { pageNo, totalCount: 10, items: pageNo > 10 ? [] : [row('new' + pageNo)] }; };
  const first = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 4 });
  assert.equal(first.progress.discoveryNextPage, 1); assert.equal(first.progress.discoveryPageTraversalEnded, false);
  assert.equal(first.continue, true); assert.equal(first.progress.discoveryUniqueCoverageVerified, false);
  const second = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 4 });
  assert.equal(s.calls[1].pageNo, 1); assert.equal(second.progress.discoveryNextPage, 2);
});

test('a deployed legacy discovery checkpoint pins already-published existing-ID success before its next observation', async () => {
  const s = setup(1); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  const current = await s.store.readCurrent(), control = await s.store.readControl();
  Object.assign(current.value.runPlan, { phase: 'discovery', index: 1 });
  delete current.value.runPlan.existingIdsRevalidation; delete current.value.runPlan.existingIdsPublishedAt;
  delete current.value.snapshot.metadata.refresh.existingIdsRevalidation;
  current.value.sha256 = digest(current.value.snapshot); await s.store.writeCurrent(current.value, current.etag);
  Object.assign(control.value.plan, { phase: 'discovery', index: 1 });
  delete control.value.plan.existingIdsRevalidation; delete control.value.plan.existingIdsPublishedAt;
  await s.store.writeControl(control.value, control.etag);
  s.source.list = async pageNo => { s.skip(5); return { pageNo, totalCount: 2, items: [{ ...row('id0'), deadline: '' }] }; };
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 4 });
  const scope = (await s.store.readCurrent()).value.snapshot.metadata.refresh.existingIdsRevalidation;
  assert.equal(scope.state, 'succeeded'); assert.equal(scope.confirmedIds, 1);
  assert.equal(scope.publishedAt, current.value.refreshState.lastPublishedAt);
});

test('excluded discovery rows do not accumulate per-ID timestamps in the durable checkpoint', async () => {
  const s = setup(1), original = s.source.list;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.skip(5);
    return { pageNo, totalCount: 6000, items: Array.from({ length: size }, (_, i) => ({ ...row('expired-' + pageNo + '-' + i), toDd: '20200101', frDd: '20190101' })) };
  };
  let result;
  do {
    result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1000, budgetMs: 9 });
    const plan = (await s.store.readControl()).value.plan;
    assert.equal(Object.keys(plan.sourceVerifiedIds).length, 1);
    assert.equal(Object.keys(plan.candidate.metadata.sourceObservedById).length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(plan)) < 50000);
  } while (result.continue);
  assert.equal(result.progress.discoveryPageTraversalEnded, true);
});
test('an old checkpoint with excluded-ID timestamp accumulation is compacted before acquiring the next lease', async () => {
  const s = setup(1); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  const control = await s.store.readControl();
  for (let i = 0; i < 3000; i++) {
    control.value.plan.sourceVerifiedIds['expired-' + i] = s.now().toISOString();
    control.value.plan.candidate.metadata.sourceObservedById['expired-' + i] = s.now().toISOString();
  }
  await s.store.writeControl(control.value, control.etag);
  const write = s.store.writeControl;
  s.store.writeControl = async function(value, etag) {
    if (Buffer.byteLength(JSON.stringify(value)) > 50000) throw Object.assign(new Error('SNAPSHOT_TOO_LARGE'), { code: 'SNAPSHOT_TOO_LARGE' });
    return write.call(this, value, etag);
  };
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(result.state, 'completed_partial_source'); assert.equal(result.progress.confirmedIds, 1);
});
test('an oversized full control checkpoint falls back to the committed cursor and still queues the next chunk', async () => {
  const s = setup(1), write = s.store.writeControl;
  s.store.writeControl = async function(value, etag) {
    if (!value.leaseUntil && value.plan) throw Object.assign(new Error('SNAPSHOT_TOO_LARGE'), { code: 'SNAPSHOT_TOO_LARGE' });
    return write.call(this, value, etag);
  };
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  assert.equal(result.continue, true); assert.equal(result.state, 'in_progress_partial');
  const checkpoint = (await s.store.readControl()).value;
  assert.equal(checkpoint.leaseUntil, null); assert.equal(checkpoint.plan, undefined);
  assert.equal(checkpoint.resumeSource, 'current_snapshot'); assert.equal(checkpoint.dailyProgress.confirmedIds, 1);
  const next = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(next.state, 'completed_partial_source');
  assert.equal(s.calls.filter(c => c.kind === 'detail' && c.id === 'id0').length, 1);
});

test('a source-confirmed closure removes both retained timestamp entries while preserving its exclusion evidence', async () => {
  const s = setup(1); s.sourceRows.set('id0', { ...row('id0'), deadline: '마감' });
  await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  const plan = (await s.store.readControl()).value.plan;
  assert.equal(plan.outcomes.id0.state, 'verified_ineligible');
  assert.deepEqual(plan.sourceVerifiedIds, {}); assert.deepEqual(plan.candidate.metadata.sourceObservedById, {});
});
test('a compact source-failure checkpoint reports only committed progress and releases its lease', async () => {
  const s = setup(2); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  const committed = (await s.store.readCurrent()).value.runPlan;
  const write = s.store.writeControl, original = s.source.list;
  s.store.writeControl = async function(value, etag) {
    if (!value.leaseUntil && value.plan) throw Object.assign(new Error('SNAPSHOT_TOO_LARGE'), { code: 'SNAPSHOT_TOO_LARGE' });
    return write.call(this, value, etag);
  };
  s.source.list = async (...args) => {
    if (args[2] === 'Title id1') throw Object.assign(new Error('UPSTREAM_TIMEOUT'), { code: 'UPSTREAM_TIMEOUT' });
    return original(...args);
  };
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(result.errorCode, 'UPSTREAM_TIMEOUT');
  const checkpoint = (await s.store.readControl()).value;
  assert.equal(checkpoint.state, 'paused_incomplete'); assert.equal(checkpoint.leaseUntil, null);
  assert.equal(checkpoint.dailyProgress.sourceCalls, committed.calls);
  assert.equal(checkpoint.dailyProgress.confirmedIds, 1); assert.equal(checkpoint.plan, undefined);
});
test('compact control fallback keeps conditional writes and cannot overwrite another lease', async () => {
  const s = setup(1), write = s.store.writeControl; let once = false;
  s.store.writeControl = async function(value, etag) {
    if (!value.leaseUntil && value.plan && !once) {
      once = true;
      await write.call(this, { state: 'running', leaseId: 'other-worker', leaseUntil: new Date(s.now().getTime() + 90000).toISOString() }, etag);
      throw Object.assign(new Error('SNAPSHOT_TOO_LARGE'), { code: 'SNAPSHOT_TOO_LARGE' });
    }
    return write.call(this, value, etag);
  };
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  assert.equal(result.state, 'paused_incomplete');
  assert.equal((await s.store.readControl()).value.leaseId, 'other-worker');
});

test('compact failure recovery keeps attempted call consumption so a retry cannot exceed the daily source budget', async () => {
  const s = setup(2); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 2 });
  const current = await s.store.readCurrent(), control = await s.store.readControl();
  current.value.runPlan.calls = 9999; current.value.snapshot.metadata.refresh.dailyRevalidation.sourceCalls = 9999;
  current.value.sha256 = digest(current.value.snapshot); await s.store.writeCurrent(current.value, current.etag);
  control.value.plan.calls = 9999; await s.store.writeControl(control.value, control.etag);
  const write = s.store.writeControl; let attempted = 0;
  s.store.writeControl = async function(value, etag) {
    if (!value.leaseUntil && value.plan) throw Object.assign(new Error('SNAPSHOT_TOO_LARGE'), { code: 'SNAPSHOT_TOO_LARGE' });
    return write.call(this, value, etag);
  };
  s.source.detail = async () => { attempted++; throw Object.assign(new Error('UPSTREAM_TIMEOUT'), { code: 'UPSTREAM_TIMEOUT' }); };
  const first = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(first.errorCode, 'UPSTREAM_TIMEOUT');
  assert.equal((await s.store.readControl()).value.attemptSourceCalls, 10000);
  const next = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(next.errorCode, 'DOCUMENTED_DAILY_CALL_BUDGET'); assert.equal(attempted, 1);
});

test('repeated discovery pages are recorded as a gap before the next distinct page is collected', async () => {
  const s = setup(1), original = s.source.list;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.calls.push({ kind: 'discovery', pageNo });
    return { pageNo, totalCount: 4, items: [row(pageNo < 4 ? 'first' : 'fourth')] };
  };
  const first = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.equal(first.state, 'completed_with_discovery_gaps');
  assert.deepEqual(s.calls.filter(c => c.kind === 'discovery').map(c => c.pageNo), [1,2,3,4]);
  assert.equal(first.progress.discoveryUniqueCoverageVerified, false);
  assert.deepEqual(first.progress.discoveryCoverageGaps.map(g => [g.fromPage,g.toPage]), [[2,3]]);
  assert.equal(first.progress.discoveryConsecutiveDuplicatePages, 0);
});

test('the next KST day checks the head while preserving a repeated-page pause cursor for another safe attempt', async () => {
  const s = setup(0); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 0 });
  const control = await s.store.readControl();
  Object.assign(control.value.plan.discovery, { nextPage: 23, total: 30, hashes: { 1: 'old' }, scannedRows: 22, errorCode: 'REPEATED_PAGE' });
  await s.store.writeControl(control.value, control.etag); s.skip(24 * 3600000);
  s.source.list = async pageNo => { s.skip(5); s.calls.push({ kind: 'discovery', pageNo }); return { pageNo, totalCount: 30, items: [row('new' + pageNo)] }; };
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 9 });
  assert.deepEqual(s.calls.map(c => c.pageNo), [1,23]);
});

test('five consecutive duplicate pages publish the next cursor and gap before stopping, including compact control fallback', async () => {
  for (const compact of [false, true]) {
    const s = setup(1), original = s.source.list, write = s.store.writeControl;
    s.source.list = async (pageNo, size, search) => search ? original(pageNo, size, search) : { pageNo, totalCount: 20, items: [row('same')] };
    if (compact) s.store.writeControl = async function(value, etag) {
      if (!value.leaseUntil && value.plan) throw Object.assign(new Error('SNAPSHOT_TOO_LARGE'), { code: 'SNAPSHOT_TOO_LARGE' });
      return write.call(this, value, etag);
    };
    const first = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
    assert.equal(first.errorCode, 'DISCOVERY_REPEATED_PAGE_LIMIT'); assert.equal(first.continue, false);
    assert.equal(first.progress.discoveryNextPage, 7); assert.equal(first.progress.discoveryConsecutiveDuplicatePages, 5);
    assert.deepEqual(first.progress.discoveryCoverageGaps.map(g => [g.fromPage,g.toPage]), [[2,6]]);
    const current = (await s.store.readCurrent()).value;
    assert.equal(current.runPlan.discovery.nextPage, 7); assert.equal(current.refreshState.lastSuccessfulAt, null);
    assert.equal(current.snapshot.metadata.refresh.existingIdsRevalidation.state, 'succeeded');
    assert.equal((await s.store.readControl()).value.leaseUntil, null);
    const calls = current.runPlan.calls;
    const second = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
    assert.equal(second.errorCode, 'DISCOVERY_REPEATED_PAGE_LIMIT'); assert.equal(second.progress.sourceCalls, calls);
    assert.equal(second.progress.discoveryNextPage, 7);
  }
});
test('the next KST day rechecks the head and resumes beyond the prior duplicate run limit', async () => {
  const s = setup(1), original = s.source.list; let nextDay = false;
  s.source.list = async (pageNo, size, search) => {
    if (search) return original(pageNo, size, search);
    s.skip(5); s.calls.push({ kind: 'discovery', pageNo });
    const item = row(nextDay ? 'fresh-' + pageNo : 'same'); s.sourceRows.set(item.jobId, item);
    return { pageNo, totalCount: 20, items: [item] };
  };
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  const start = s.calls.length; s.skip(24 * 3600000); nextDay = true;
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1, budgetMs: 13 });
  assert.deepEqual(s.calls.slice(start).filter(c => c.kind === 'discovery').map(c => c.pageNo), [1,7]);
  assert.equal(result.progress.discoveryConsecutiveDuplicatePages, 0); assert.equal(result.progress.discoveryNextPage, 8);
});
test('separated duplicate page intervals remain distinct and a normal page resets the duplicate streak', async () => {
  const s = setup(0);
  s.source.list = async pageNo => ({ pageNo, totalCount: 5, items: [row([null,'a','a','b','b','c'][pageNo])] });
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.deepEqual(result.progress.discoveryCoverageGaps.map(g => [g.fromPage,g.toPage]), [[2,2],[4,4]]);
  assert.equal(result.progress.discoveryDuplicatePages, 2); assert.equal(result.progress.discoverySkippedDuplicateSlots, 2);
  assert.equal(result.progress.discoveryConsecutiveDuplicatePages, 0);
});

test('duplicate ID sets are detected across row order changes and fresh status updates still remove closed jobs', async () => {
  const s = setup(0);
  s.source.list = async pageNo => ({ pageNo, totalCount: 6, items: pageNo === 1 ? [row('a'),row('b')] :
    [row('b'), { ...row('a'), deadline: pageNo === 3 ? '마감' : '접수중' }] });
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 2 });
  assert.deepEqual(result.progress.discoveryCoverageGaps.map(g => [g.fromPage,g.toPage]), [[2,3]]);
  assert.deepEqual((await s.store.readCurrent()).value.snapshot.jobs.map(r => r.jobId), ['b']);
  assert.equal(result.state, 'completed_with_discovery_gaps');
});
test('MCP exposes the latest durable discovery cursor separately from its published snapshot cursor', async () => {
  const s = setup(0); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 0 });
  const control = await s.store.readControl();
  control.value.dailyProgress.discoveryNextPage = 23; control.value.dailyProgress.discoveryScannedRows = 22000;
  control.value.plan.calls = 1; await s.store.writeControl(control.value, control.etag);
  const loaded = await loadDataset(s.store, true, s.now);
  const response = withDataset(loaded, () => jobs.describeOptions({}, s.now()));
  assert.equal(response.context.refresh.discovery.nextPage, 23);
  assert.equal(response.context.refresh.discovery.publishedNextPage, 1);
  assert.equal(response.context.refresh.discovery.scannedRows, 22000);
});

test('gap ranges remain compact when a new smaller scan overlaps a previous duplicate interval', async () => {
  const s = setup(0); await runDailyChunk({ store: s.store, source: s.source, now: s.now, budgetMs: 0 });
  const control = await s.store.readControl();
  Object.assign(control.value.plan.discovery, { nextPage: 7, total: 20, hashes: { 1: 'old' }, idSetHashes: { 4: 'old-id-set' },
    scannedRows: 1, coverageGaps: [{ fromPage: 2, toPage: 6, reason: 'repeated_source_page', uniqueMissingIds: 'unknown' }], errorCode: 'DISCOVERY_REPEATED_PAGE_LIMIT' });
  await s.store.writeControl(control.value, control.etag); s.skip(24 * 3600000);
  s.source.list = async pageNo => ({ pageNo, totalCount: 3, items: [row('same')] });
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.deepEqual(result.progress.discoveryCoverageGaps.map(g => [g.fromPage,g.toPage]), [[2,6]]);
});

test('the 06:00 KST scheduled cycle revalidates published IDs again after an earlier same-day manual run', async () => {
  const s = setup(2);
  s.skip(Date.parse('2026-10-12T17:00:00Z') - s.now().getTime());
  await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  const before = s.calls.length;
  s.skip(Date.parse('2026-10-12T21:00:00Z') - s.now().getTime());
  const morning = await runDailyChunk({ store: s.store, source: s.source, now: s.now });
  assert.equal(morning.progress.dayKst, '2026-10-13');
  assert.equal(morning.progress.refreshCycleKst, '2026-10-13');
  assert.equal(s.calls.slice(before).filter(c => c.kind === 'detail').length, 2);
});
test('a same-day duplicate-run limit re-arms at the registered morning window while retaining the daily source call budget', async () => {
  const s = setup(0);
  s.skip(Date.parse('2026-10-12T17:00:00Z') - s.now().getTime());
  s.source.list = async pageNo => { s.calls.push({ kind: 'discovery', pageNo }); return { pageNo, totalCount: 20, items: [row('same')] }; };
  await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  const current = await s.store.readCurrent(), control = await s.store.readControl();
  current.value.runPlan.calls = 10000; current.value.snapshot.metadata.refresh.dailyRevalidation.sourceCalls = 10000;
  current.value.sha256 = digest(current.value.snapshot); await s.store.writeCurrent(current.value, current.etag);
  control.value.plan.calls = 10000; await s.store.writeControl(control.value, control.etag);
  s.skip(Date.parse('2026-10-12T21:00:00Z') - s.now().getTime());
  const callsBefore = s.calls.length;
  const result = await runDailyChunk({ store: s.store, source: s.source, now: s.now, pageSize: 1 });
  assert.equal(result.errorCode, 'DOCUMENTED_DAILY_CALL_BUDGET');
  assert.equal(result.progress.refreshCycleKst, '2026-10-13'); assert.equal(s.calls.length, callsBefore);
});
