'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { respond } = require('../lib/protocol');
const { withDataset } = require('../lib/job-context');
const { preparePublicImport } = require('../lib/public-import');
const { posting } = require('../refresh/public-source');
const now = new Date('2026-11-14T21:52:00Z');
const observedAt = now.toISOString();
function fixture() {
  const rows = [
    ['a', '서울특별시/마포구', '경비원 공고 A'],
    ['b', '서울 마포구', '경비원 공고 B'],
    ['c', '서울특별시/종로구', '생활지원사 공고 C'],
    ['d', '인천광역시/남동구', '경비원 공고 D'],
    ['e', '서울특별시', '경비원 공고 E']
  ];
  const { envelope } = preparePublicImport({
    source: 'https://www.seniorro.or.kr/noin/main.do', startedAt: observedAt, completedAt: observedAt,
    failures: [], regions: [], counts: {}, postings: rows.map(([id, work, title]) =>
      posting({ JOB_ID: id, INSTN_ID: 'i', PROJ_TYPE: 'A', RECRT_TITLE: title, ORAN_NM: '격리검증',
        WORK_PLC_NM: work, FR_DD: '20261101', TO_DD: '20261201', DEADLINE: '접수중', PROJ_YEAR: '2026' }, observedAt))
  }, null);
  envelope.refreshState.storageState = 'd1';
  return { snapshot: envelope.snapshot, refreshState: envelope.refreshState };
}
const rpc = (method, params) => withDataset(fixture(), () => respond({ jsonrpc: '2.0', id: 1, method, params }, now).result);
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });

test('initialize and tools/list describe a count+choices path without changing client identity or tool names', () => {
  const init = rpc('initialize');
  assert.equal(init.serverInfo.name, 'senior-jobs-static-poc');
  assert.match(init.instructions, /explicitly requested only a count/);
  assert.match(init.instructions, /published D1 snapshot/);
  assert.doesNotMatch(init.instructions, /private Blob snapshot/);
  const names = rpc('tools/list').tools.map(tool => {
    assert.match(tool.description, /plain Korean TextContent/);
    assert.equal(tool.annotations.readOnlyHint, true);
    return tool.name;
  });
  assert.deepEqual(names, ['describe_search_options', 'search_jobs', 'get_job_details']);
});
test('서울 전체 provides count, actual linked examples, optional district narrowing and paging instead of a count-only response', () => {
  const result = call('search_jobs', { region: '서울', anyWork: true, limit: 3 });
  assert.equal(result.isError, false);
  const data = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  assert.equal(data.context.snapshotOrigin, 'd1');
  assert.equal(data.totalMatches, 4);
  assert.equal(data.conversationGuide.examples.length, 3);
  assert.equal(data.conversationGuide.nextQuestion.key, 'district_or_selection');
  assert.deepEqual(data.conversationGuide.nextPage.arguments, { region: '서울', anyWork: true, offset: 3, limit: 3 });
  const plain = result.content[1].text;
  assert.match(plain, /4건/); assert.match(plain, /번호나 제목/); assert.match(plain, /다음 3건/);
  assert.match(plain, /www.seniorro.or.kr\/noin\/jobDetail\.do/);
  assert.doesNotMatch(plain, /어떤 일을 원하세요/);
  assert.equal(data.conversationGuide.displayPolicy, 'offer_helpful_choices_unless_user_explicitly_requests_count_only');
});
test('a district action reuses its displayed count over aliased spellings without silently broadening scope', () => {
  const wide = call('search_jobs', { region: '서울', keyword: '경비원', limit: 3 }).structuredContent;
  const mapo = wide.conversationGuide.districtOptions.find(option => option.value === '마포구');
  assert.equal(mapo.count, 2);
  assert.deepEqual(mapo.searchArguments, { region: '서울 마포구', keyword: '경비원', limit: 3 });
  const exact = call('search_jobs', mapo.searchArguments).structuredContent;
  assert.equal(exact.totalMatches, mapo.count);
  assert.equal(exact.unknownFilterEvidence.region, 1); // Seoul without a district is not assumed to be a mismatch.
  assert.equal(exact.conversationGuide.nextQuestion.key, 'selection');
  assert.ok(exact.jobs.every(x => x.normalizedRegion.cityDistrict === '마포구'));
  assert.equal(exact.appliedFilters[1].operator, 'exact_observed_province_and_district');
  const detail = call('get_job_details', exact.conversationGuide.examples[0].detailLink.tool.arguments);
  assert.equal(detail.structuredContent.job.id, exact.conversationGuide.examples[0].id);
  assert.match(detail.content[1].text, /급여·근무시간·지원조건/);
  assert.match(detail.content[1].text, /공식 공고/);
});
test('vague and no-result requests ask only unanswered or relevant questions and never fetch a source', t => {
  const noFetch = t.mock.method(globalThis, 'fetch', () => { assert.fail('ordinary MCP reading must not fetch'); });
  const vague = call('describe_search_options');
  assert.equal(vague.structuredContent.conversationGuide.nextQuestion.key, 'region');
  assert.match(vague.content[1].text, /서울\(4건\)/);
  const regionKnown = call('describe_search_options', { region: '서울' });
  assert.equal(regionKnown.structuredContent.conversationGuide.nextQuestion.key, 'keyword_or_district');
  const zero = call('search_jobs', { region: '서울 마포구', keyword: '무응답테스트' });
  assert.equal(zero.structuredContent.totalMatches, 0);
  assert.equal(zero.structuredContent.conversationGuide.nextQuestion.key, 'broaden');
  assert.match(zero.content[1].text, /넓혀서 다시 볼까요/);
  assert.equal(noFetch.mock.callCount(), 0);
});
