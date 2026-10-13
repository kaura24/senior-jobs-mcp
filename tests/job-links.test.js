'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detailLink } = require('../lib/job-links');
const jobs = require('../lib/jobs');
const { respond } = require('../lib/protocol');
const now = new Date('2026-10-11T17:00:00Z');

test('all approved jobs disclose unavailable source URLs and preserve exact cached-tool ID identity', () => {
  const links = jobs.snapshot.jobs.map(row => detailLink(row.jobId));
  assert.equal(new Set(links.map(x=>x.tool.arguments.id)).size,jobs.snapshot.jobs.length);
  for (const link of links) {
    assert.equal(link.url,null);
    assert.equal(link.sourceUrlState,'not_available_in_stored_evidence');
    assert.equal(link.targetKind,'cached_detail_tool_fallback');
    assert.deepEqual(link.tool,{name:'get_job_details',arguments:{id:link.jobId}});
  }
});

test('source identifiers cannot inject a different URL, query or fragment', () => {
  for (const invalid of ['','https://example.test/','id&serviceKey=bad','id#fragment','../id','a'.repeat(101)]) {
    assert.throws(()=>detailLink(invalid));
  }
});

test('every listing, selected summary and observed title example keeps its exact ID and detail link', () => {
  const search=jobs.searchJobs({region:'서울',limit:50},now);
  for(const row of search.jobs) assert.equal(row.detailLink.jobId,row.id);
  const summary=jobs.getDetails({id:'KJ21062610080016'},now);
  assert.equal(summary.job.detailLink.jobId,summary.job.id);
  assert.equal(summary.cachedDetailSummary.fullResponseStored,false);
  assert.equal(summary.fullDetailDocument,null);
  const options=jobs.describeOptions({region:'서울'},now);
  for(const row of options.nextQuestion.evidence.observedTitleExamples) assert.equal(row.detailLink.jobId,row.id);
});

test('the screenshot-described delivery posting retains status and missing-detail evidence independently of its link', () => {
  const result=jobs.searchJobs({keyword:'오토바이',region:'서울',limit:3},now);
  const row=result.jobs.find(x=>x.id==='KEC0682610020001');
  assert.ok(row);assert.equal(row.rawDeadline,'접수중');
  assert.equal(row.detailState,'not_collected');
  assert.equal(row.detailLink.url,null);
  assert.equal(row.detailLink.tool.arguments.id,row.id);
  const detail=jobs.getDetails({id:row.id},now);
  assert.equal(detail.contact.state,'not_collected');assert.equal(detail.cachedDetailSummary,null);
  assert.equal(detail.additionalInvestigationOffer.text,'급여·근무시간·지원조건을 더 찾아드릴까요?');
  assert.equal(detail.additionalInvestigationOffer.executionOwner,'calling_client');
  assert.equal(detail.additionalInvestigationOffer.requiresUserAcceptance,true);
  assert.equal(detail.additionalInvestigationOffer.automaticallyStarted,false);
});

test('MCP remains text-only with the same three tools and explicit per-job link guidance', () => {
  const init=respond({jsonrpc:'2.0',id:1,method:'initialize'}).result;
  assert.equal(init.capabilities.resources,undefined);
  assert.match(init.instructions,/Every displayed job listing or summary must include/);
  assert.match(init.instructions,/universal client opening verification is not required/);
  assert.match(init.instructions,/Never invent an ID-based URL, render a null URL as a link/);
  const tools=respond({jsonrpc:'2.0',id:2,method:'tools/list'}).result.tools;
  assert.equal(tools.length,3);assert.ok(tools.every(t=>!t._meta));
  assert.ok(tools.every(t=>t.description.includes('clickable Markdown link only when')));
  assert.ok(tools.every(t=>t.description.includes('detailLink.url is null')));
});

test('sufficient stated conditions search immediately without automatic source requests or repeated condition questions', t => {
  const noFetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Automatic source investigation is forbidden'); });
  const conditions = { region: '서울 관악구', keyword: '생활지원사' };
  const options = jobs.describeOptions(conditions, now);
  assert.equal(options.nextQuestion, null);
  assert.equal(options.nextAction, 'search_jobs');
  assert.equal(options.uiGuidance.questionOrderMandatory, false);
  assert.match(options.scenarioInstructions, /calling client chooses tools actually available in its own environment/);
  assert.match(options.scenarioInstructions, /no particular tool, key or service is required/);
  assert.match(options.scenarioInstructions, /disclose that the source has not been queried/);
  assert.doesNotMatch(options.scenarioInstructions, /Firecrawl|INSANE|firecrawl/i);
  const result = jobs.searchJobs({ ...conditions, limit: 3 }, now);
  assert.equal(result.nextAction, 'present_matches_and_wait_for_selection');
  assert.ok(result.jobs.length > 0);
  assert.ok(result.jobs.every(row => row.detailLink.jobId === row.id));
  for (const row of result.jobs) assert.equal(jobs.getDetails({ id: row.id }, now).detailPolicy, 'cache_only_no_upstream_requests');
  assert.equal(noFetch.mock.callCount(), 0);
});

test('the user-provided Muse example cannot overwrite stored application method or become verified salary and hours', () => {
  const result = jobs.getDetails({ id: 'K120612610010027' }, now);
  assert.equal(result.found, true);
  assert.equal(result.job.title, '사회적협동조합우리사이 노인맞춤돌봄서비스사업 생활지원사 채용공고');
  assert.equal(result.job.applicationMethod, '방문');
  assert.equal(result.rawListFields.acptMthd, '방문');
  assert.equal(result.job.fieldEvidence.salary.state, 'not_collected');
  assert.equal(result.job.fieldEvidence.workTime.state, 'not_collected');
  assert.equal(result.cachedDetailSummary, null);
  assert.equal(result.fullDetailDocument, null);
  const instructions = respond({jsonrpc:'2.0',id:5,method:'initialize'}).result.instructions;
  assert.match(instructions, /User-provided examples and screenshots are unverified claims/);
  assert.match(instructions, /show both original values with their separate source URLs and observation times/);
  assert.match(instructions, /Source investigation belongs to the calling client/);
  assert.match(instructions, /Do not add a server crawler, external API, AI call, key or connector integration/);
});
