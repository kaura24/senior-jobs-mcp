'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSource } = require('../refresh/source');

async function withinBound(promise, milliseconds = 150) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('source exceeded the whole-request deadline'),
        { code: 'DIAGNOSTIC_BOUND_EXCEEDED' })), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const xml = code => '<response><header><resultCode>' + code + '</resultCode></header>' +
  '<body><totalCount>0</totalCount><items></items></body></response>';

test('a fetch that ignores abort still stops at the whole-request deadline without retrying', async () => {
  let attempts = 0;
  const events = [];
  const source = createSource('fixture-key-only', async () => { attempts++; return new Promise(() => {}); },
    { timeoutMs: 20, onEvent: event => events.push(event) });
  await assert.rejects(withinBound(source.list(1, 1000)), error => error.code === 'UPSTREAM_TIMEOUT');
  assert.equal(attempts, 1);
  assert.ok(events.some(event => event.errorCode === 'UPSTREAM_TIMEOUT'));
});

test('a response body that ignores abort still stops at the whole-request deadline', async () => {
  let controller;
  const source = createSource('fixture-key-only', async () => new Response(new ReadableStream({
    start(value) { controller = value; },
  })), { timeoutMs: 20 });
  try {
    await assert.rejects(withinBound(source.list(1, 1000)), error => error.code === 'UPSTREAM_TIMEOUT');
  } finally {
    controller?.error(new Error('fixture cleanup'));
  }
});

test('a timeout raised while reading the body remains UPSTREAM_TIMEOUT', async () => {
  let timer;
  const source = createSource('fixture-key-only', async () => new Response(new ReadableStream({
    start(controller) {
      timer = setTimeout(() => controller.error(new DOMException('fixture body timeout', 'TimeoutError')), 10);
    },
  })), { timeoutMs: 20 });
  try {
    await assert.rejects(withinBound(source.list(1, 1000)), error => error.code === 'UPSTREAM_TIMEOUT');
  } finally { clearTimeout(timer); }
});

test('successful source telemetry preserves HTTP and API codes and duration while excluding credentials and search text', async () => {
  const events = [];
  const credential = 'fixture-credential-contains-secret';
  const title = 'fixture-sensitive-title';
  const source = createSource(credential, async () => new Response(xml('0000'), { status: 200 }),
    { timeoutMs: 20, onEvent: event => events.push(event) });
  await source.list(1, 1000, title);
  const terminal = events.find(event => event.httpStatus === 200 && event.apiResultCode === '0000');
  assert.ok(terminal, 'telemetry must retain the observed HTTP status and original API result code');
  assert.ok(Number.isFinite(terminal.elapsedMs) && terminal.elapsedMs >= 0);
  assert.equal(terminal.operation, 'getJobList');
  assert.equal(terminal.attempt, 1);
  assert.equal(terminal.maxAttempts, 1);
  const serialized = JSON.stringify(events);
  for (const prohibited of [credential, title, 'serviceKey', 'https://', '?', 'search=']) {
    assert.equal(serialized.includes(prohibited), false, 'source diagnostics must exclude ' + prohibited);
  }
});

test('HTTP errors retain only the numeric status in safe telemetry and make one attempt', async () => {
  const events = [];
  let attempts = 0;
  const source = createSource('fixture-key-only', async () => { attempts++; return new Response('fixture', { status: 429 }); },
    { timeoutMs: 20, onEvent: event => events.push(event) });
  await assert.rejects(source.list(1, 1000), error => error.code === 'UPSTREAM_HTTP_ERROR');
  assert.equal(attempts, 1);
  assert.ok(events.some(event => event.httpStatus === 429 && event.errorCode === 'UPSTREAM_HTTP_ERROR'));
});

test('unknown numeric upstream API errors retain their original result code in safe telemetry', async () => {
  const events = [];
  const source = createSource('fixture-key-only', async () => new Response(xml('04'), { status: 200 }),
    { timeoutMs: 20, onEvent: event => events.push(event) });
  await assert.rejects(source.list(1, 1000), error => error.code === 'UPSTREAM_ERROR');
  assert.ok(events.some(event => event.httpStatus === 200 && event.apiResultCode === '04' && event.errorCode === 'UPSTREAM_ERROR'));
});

test('page telemetry compares actual request and response numbers plus an ID set digest without leaking keys or headers', async () => {
  const events = [], credential = 'fixture-secret-value', hiddenHeader = 'fixture-hidden-header';
  const body = '<response><header><resultCode>00</resultCode></header><body><totalCount>1000</totalCount><pageNo>23</pageNo><numOfRows>1000</numOfRows><items><item><jobId>b</jobId></item><item><jobId>a</jobId></item></items></body></response>';
  const source = createSource(credential, async (url, options) => {
    assert.equal(url.searchParams.get('pageNo'), '23'); assert.equal(url.searchParams.get('numOfRows'), '1000');
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers['cache-control'], 'no-cache');
    return new Response(body, { headers: { age: '0', date: 'Mon, 12 Oct 2026 16:00:00 GMT', 'cache-control': 'no-cache, extension=' + hiddenHeader } });
  }, { onEvent: e => events.push(e) });
  await source.list(23,1000);
  const terminal = events.at(-1);
  assert.equal(terminal.requestedPageNo, 23); assert.equal(terminal.reportedPageNo, 23);
  assert.equal(terminal.requestedNumOfRows, 1000); assert.equal(terminal.reportedNumOfRows, 1000);
  assert.equal(terminal.distinctJobIds, 2); assert.match(terminal.idSetDigest, /^[a-f0-9]{64}$/);
  assert.equal(terminal.firstJobId, 'a'); assert.equal(terminal.lastJobId, 'b');
  assert.equal(terminal.cacheEvidence.ageSeconds, 0); assert.equal(terminal.cacheEvidence.responseNoCache, true);
  assert.equal(JSON.stringify(events).includes(credential), false); assert.equal(JSON.stringify(events).includes(hiddenHeader), false);
});
test('ID set telemetry has the same digest when only order and duplicate multiplicity differ', async () => {
  const fingerprints = [];
  for (const ids of [['a','a','b'], ['b','a','b']]) {
    const body = '<response><header><resultCode>00</resultCode></header><body><totalCount>3</totalCount><items>' + ids.map(id => '<item><jobId>' + id + '</jobId></item>').join('') + '</items></body></response>';
    const source = createSource('fixture-only', async () => new Response(body));
    await source.list(1,3); fingerprints.push(source.diagnostics().recent.at(-1).idSetDigest);
  }
  assert.equal(fingerprints[0], fingerprints[1]);
});

test('source location telemetry distinguishes actual XML provided, empty and absent fields', async () => {
  const xml = '<response><header><resultCode>00</resultCode></header><body><totalCount>3</totalCount><items>'
    + '<item><jobId>provided</jobId><workPlcNm>전북 전주시 완산구</workPlcNm></item>'
    + '<item><jobId>empty</jobId><workPlcNm/></item><item><jobId>absent</jobId><plDetAddr>서울 사업장</plDetAddr></item>'
    + '</items></body></response>';
  const source = createSource('fixture-only', async()=>new Response(xml));
  const result = await source.list(1,3);
  assert.equal(result.items[0].workPlcNm,'전북 전주시 완산구');
  assert.equal(Object.hasOwn(result.items[2],'workPlcNm'),false);
  assert.deepEqual(source.diagnostics().recent.at(-1).regionFieldPresence,
    {sourceField:'workPlcNm',providedItems:1,absentItems:1,emptyItems:1});
});
