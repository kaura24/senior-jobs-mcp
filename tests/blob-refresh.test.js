'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, loadDataset, digest } = require('../lib/blob-store');
const { runRefresh } = require('../refresh/runner');
const { parsePage, fetchPage } = require('../refresh/source');
const { withDataset } = require('../lib/job-context');
const jobs = require('../lib/jobs');
const { authorized } = require('../api/refresh');
const now = () => new Date('2026-10-12T11:00:00Z');
test('Blob failure telemetry identifies the SDK failure without exposing its message or credentials', async () => {
  const events = [];
  class BlobPreconditionFailedError extends Error {}
  const sdk = { put: async () => { throw new BlobPreconditionFailedError('serviceKey=secret-do-not-log'); } };
  const store = createStore(sdk, { onEvent: event => events.push(event) });
  await assert.rejects(store.writeControl({}, 'W/"revision"'), BlobPreconditionFailedError);
  assert.equal(events.length, 1);
  assert.equal(events[0].sdkErrorClass, 'BlobPreconditionFailedError');
  assert.equal(events[0].etagWeak, true);
  assert.equal(events[0].operation, 'writeControl');
  assert.ok(!JSON.stringify(events).includes('secret-do-not-log'));
  assert.ok(!JSON.stringify(events).includes('revision'));
});
test('Blob reads avoid compression-derived weak ETags so subsequent conditional writes succeed', async () => {
  const sdk = memorySdk(), get = sdk.get;
  sdk.get = async (pathname, options) => {
    const result = await get.call(sdk, pathname, options);
    if (result && new Headers(options.headers).get('accept-encoding') !== 'identity') result.blob.etag = 'W/"' + result.blob.etag + '"';
    return result;
  };
  const store = createStore(sdk);
  const original = await store.readCurrent();
  await store.writeCurrent(original.value, original.etag);
  const first = await store.writeControl({ state: 'running' });
  await store.writeControl({ state: 'in_progress_partial' }, first.etag);
  const checkpoint = await store.readControl();
  await store.writeControl({ state: 'running' }, checkpoint.etag);
  const latest = await store.readControl();
  await assert.rejects(store.writeControl({ state: 'stale' }, checkpoint.etag), /precondition failed/);
  assert.equal(latest.value.state, 'running');
});
test('Blob deadline bounds stalled SDK get, body and put and uses AbortError to stop SDK retries', async () => {
  for (const phase of ['get', 'body', 'put']) {
    let signal;
    const sdk = { get: async (_path, opts) => {
      signal = opts.abortSignal;
      if (phase === 'get') return new Promise(() => {});
      return { statusCode: 200, blob: { size: 0, etag: 'v1' }, stream: new ReadableStream() };
    }, put: async (_path, _body, opts) => { signal = opts.abortSignal; return new Promise(() => {}); } };
    const store = createStore(sdk, { timeoutMs: 20 });
    let watchdog;
    try {
      await assert.rejects(Promise.race([phase === 'put' ? store.writeControl({}, undefined) : store.readControl(),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('UNBOUNDED_BLOB_WAIT')), 150); })]),
        error => error.code === 'STORAGE_UNAVAILABLE');
      assert.equal(signal.aborted, true); assert.equal(signal.reason.name, 'AbortError');
    } finally { clearTimeout(watchdog); }
  }
});
const row = (id, deadline = '접수중', toDd = '20261020') => ({ jobId: id, recrtTitle: '경비원 모집', oranNm: '기관',
  workPlcNm: '강원 원주시', frDd: '20261001', toDd, deadline });
test('MCP progress separates source status plus period evidence from period-only exclusions and unverified IDs', async () => {
  const sdk = memorySdk();
  sdk.objects.set('senior-jobs/control.json', { etag: 'control', data: JSON.stringify({ state: 'in_progress_partial',
    lastAttemptAt: '2026-10-12T12:00:00Z', dailyProgress: { targetIds: 4, confirmedIds: 3 },
    plan: { outcomes: { a: { state: 'verified_accepting' }, b: { state: 'verified_ineligible' },
      c: { state: 'verified_period_ineligible' }, d: { state: 'unverified_not_returned_by_title_search' } } } }) });
  const loaded = await loadDataset(createStore(sdk), true);
  const evidence = loaded.refreshState.dailyRevalidation.verificationEvidence;
  assert.equal(evidence.statusAndPeriodAccepting, 1);
  assert.equal(evidence.statusAndPeriodIneligible, 1);
  assert.equal(evidence.periodOnlyIneligible, 1);
  assert.equal(evidence.periodOnlyAccepting, 0);
  assert.equal(evidence.unverifiedIds, 1);
  assert.equal(evidence.outcomesByState.unverified_not_returned_by_title_search, 1);
});
test('an expired running lease is exposed as interrupted when the failure checkpoint was lost', async () => {
  const sdk = memorySdk();
  sdk.objects.set('senior-jobs/control.json', { data: JSON.stringify({ state: 'running', schedulerEnabled: true,
    lastAttemptAt: '2026-10-12T08:00:00Z', leaseUntil: '2026-10-12T08:01:30Z', errorCode: null }), etag: 'control' });
  const loaded = await loadDataset(createStore(sdk), true, now);
  assert.equal(loaded.refreshState.state, 'interrupted_incomplete');
  assert.equal(loaded.refreshState.errorCode, 'LEASE_EXPIRED_WITHOUT_CHECKPOINT');
});
const snapshot = { metadata: { observedAt: '2026-10-11T08:00:00Z', referenceDayKst: '2026-10-11', storedListJobs: 2,
  cachedDetailSummaries: 0, fullDetailDocuments: 0, jobsWithoutDetail: 2 }, jobs: [row('old'), row('expired', '접수중', '20261011')], detailSummaries: {} };
const envelope = value => ({ schemaVersion: 1, snapshot: value, sha256: digest(value),
  refreshState: { state: 'succeeded', schedulerEnabled: true, lastAttemptAt: value.metadata.observedAt, lastSuccessfulAt: value.metadata.observedAt } });
function memorySdk() {
  const objects = new Map([['senior-jobs/current.json', { data: JSON.stringify(envelope(snapshot)), etag: 'v1' }]]);
  const options = []; let revision = 1;
  return { objects, options, failCurrentWrite: false, failReads: false,
    async get(pathname, opts) {
      options.push({ action: 'get', pathname, opts });
      if (this.failReads) throw new Error('quota exhausted');
      const item = objects.get(pathname); if (!item) return null;
      return { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(item.data)); controller.close(); } }),
        blob: { size: Buffer.byteLength(item.data), etag: item.etag } };
    },
    async put(pathname, data, opts) {
      options.push({ action: 'put', pathname, opts });
      const prior = objects.get(pathname);
      if (pathname.endsWith('/current.json') && this.failCurrentWrite) throw new Error('quota exhausted');
      if (prior && (!opts.allowOverwrite || opts.ifMatch !== prior.etag)) throw new Error('precondition failed');
      if (!prior && opts.ifMatch) throw new Error('precondition failed');
      const etag = 'v' + (++revision); objects.set(pathname, { data, etag }); return { etag };
    } };
}
test('refresh commits observed changes atomically, keeps unobserved evidence old, and uses only two private objects', async () => {
  const sdk = memorySdk(), store = createStore(sdk);
  const result = await runRefresh({ store, now, schedulerEnabled: true, maximumPages: 1, pageSize: 2,
    fetchPage: async () => ({ pageNo: 1, totalCount: 100, items: [row('new')] }) });
  assert.equal(result.state, 'succeeded'); assert.equal(result.coverageVerified, false);
  const current = (await store.readCurrent()).value;
  assert.deepEqual(current.snapshot.jobs.map(job => job.jobId), ['new', 'old']);
  assert.equal(current.snapshot.metadata.sourceObservedById.old, snapshot.metadata.observedAt);
  assert.equal(current.snapshot.metadata.refresh.retainedNotRevalidated, 1);
  assert.equal(sdk.objects.size, 2);
  assert.ok(sdk.options.every(call => call.opts.access === 'private'));
  assert.ok(sdk.options.filter(call => call.action === 'get').every(call => call.opts.useCache === false));
  const commit = sdk.options.find(call => call.action === 'put' && call.pathname.endsWith('/current.json'));
  assert.equal(commit.opts.ifMatch, 'v1');
});
test('fresh observed closure is removed and a repeated Cron delivery does not call the source again', async () => {
  const store = createStore(memorySdk()); let calls = 0;
  const args = { store, now, maximumPages: 1, pageSize: 2, fetchPage: async () => { calls++; return { pageNo: 1, totalCount: 2, items: [row('old', '마감'), row('new')] }; } };
  assert.equal((await runRefresh(args)).state, 'succeeded');
  assert.deepEqual((await store.readCurrent()).value.snapshot.jobs.map(job => job.jobId), ['new']);
  assert.equal((await runRefresh(args)).state, 'already_refreshed'); assert.equal(calls, 1);
});
test('storage quota or publish failure leaves the previous JSON byte-for-byte unchanged', async () => {
  const sdk = memorySdk(), before = sdk.objects.get('senior-jobs/current.json').data; sdk.failCurrentWrite = true;
  const result = await runRefresh({ store: createStore(sdk), now, maximumPages: 1,
    fetchPage: async () => ({ pageNo: 1, totalCount: 10000, items: [row('new')] }) });
  assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'STORAGE_UNAVAILABLE');
  assert.equal(sdk.objects.get('senior-jobs/current.json').data, before);
  const loaded = await loadDataset(createStore(sdk), true);
  assert.equal(loaded.refreshState.state, 'failed');
});
test('a lost publish response is recovered by the stored digest; unavailable readback never claims preservation', async () => {
  for (const committed of [true, false]) {
    const sdk = memorySdk(), store = createStore(sdk), original = store.writeCurrent;
    store.writeCurrent = async (...args) => {
      if (committed) await original(...args); else sdk.failReads = true;
      throw new Error('lost response');
    };
    const result = await runRefresh({ store, now, maximumPages: 1,
      fetchPage: async () => ({ pageNo: 1, totalCount: 10000, items: [row('new')] }) });
    if (committed) assert.equal(result.state, 'succeeded');
    else { assert.equal(result.state, 'failed'); assert.equal(result.previousSnapshotPreserved, null); }
  }
});
test('source failure and repeated pages preserve current JSON and expose only a safe error code', async () => {
  for (const repeated of [false, true]) {
    const sdk = memorySdk(), before = sdk.objects.get('senior-jobs/current.json').data;
    const result = await runRefresh({ store: createStore(sdk), now, maximumPages: 2, pageSize: 1,
      fetchPage: async pageNo => { if (!repeated) { const error = new Error('serviceKey=must-never-be-returned'); error.code = 'UPSTREAM_RATE_LIMIT'; throw error; }
        return { pageNo, totalCount: 100, items: [row('new')] }; } });
    assert.equal(result.errorCode, repeated ? 'REPEATED_PAGE' : 'UPSTREAM_RATE_LIMIT');
    assert.equal(sdk.objects.get('senior-jobs/current.json').data, before);
    assert.ok(!JSON.stringify([...sdk.objects.values(), result]).includes('must-never-be-returned'));
  }
});
test('concurrent runners acquire only one lease and publish only one snapshot', async () => {
  const sdk = memorySdk(), store = createStore(sdk); let calls = 0;
  const args = { store, now, maximumPages: 1, fetchPage: async () => { calls++; return { pageNo: 1, totalCount: 10000, items: [row('new')] }; } };
  const results = await Promise.all([runRefresh(args), runRefresh(args)]);
  assert.equal(results.filter(result => result.state === 'succeeded').length, 1);
  assert.equal(calls, 1);
});
test('query context isolates parallel datasets and excludes KST expired rows from a Blob snapshot', async () => {
  const sdk = memorySdk(), data = await loadDataset(createStore(sdk), true);
  const first = withDataset(data, () => jobs.searchJobs({}, new Date('2030-01-01T00:00:00Z')));
  const second = jobs.searchJobs({}, now());
  assert.equal(first.totalMatches, 0); assert.equal(first.context.storedListJobs, 2);
  assert.equal(first.context.statusRevalidation.storageState, 'private_blob');
  assert.equal(second.context.storedListJobs, 314);
  sdk.failReads = true;
  const unavailable = await loadDataset(createStore(sdk), true);
  assert.equal(unavailable.refreshState.state, 'storage_unavailable');
  assert.equal(unavailable.snapshot.metadata.observedAt, snapshot.metadata.observedAt);
});
test('upstream XML checks result code, page metadata, unsafe declarations and encoded characters', () => {
  const xml = '<response><header><resultCode>00</resultCode></header><body><totalCount>1</totalCount><pageNo>1</pageNo><items><item><jobId>x</jobId><recrtTitle>A &amp; B</recrtTitle></item></items></body></response>';
  assert.equal(parsePage(xml, 1).items[0].recrtTitle, 'A & B');
  assert.throws(() => parsePage(xml.replace('<resultCode>00', '<resultCode>23'), 1), /UPSTREAM_RATE_LIMIT/);
  assert.throws(() => parsePage('<!DOCTYPE x>'+xml, 1), /UNSAFE_OR_INVALID_XML/);
  assert.throws(() => parsePage(xml.replace('<totalCount>1', '<totalCount>bad'), 1), /INVALID_TOTAL_COUNT/);
});
test('source network errors are redacted and redirects are never followed with the service credential', async () => {
  await assert.rejects(fetchPage(1, 'test-value', { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(url.hostname, 'apis.data.go.kr');
    throw new Error(url.toString());
  } }), error => error.code === 'UPSTREAM_NETWORK_ERROR' && !error.message.includes('test-value'));
});
test('Cron authentication fails closed with no secret, wrong secret or missing authorization', () => {
  assert.equal(authorized('Bearer test-value', 'test-value'), true);
  assert.equal(authorized('Bearer wrong', 'test-value'), false);
  assert.equal(authorized(undefined, 'test-value'), false);
  assert.equal(authorized('Bearer ', ''), false);
});

test('MCP exposes newer paused discovery independently of existing-scope success even if the attempt began before verification', async () => {
  const sdk = memorySdk(), snapshotScope = structuredClone(snapshot);
  const scope = { state: 'succeeded', dayKst: '2026-10-12', targetIds: 1, confirmedIds: 1, unverifiedIds: 0,
    verifiedAt: '2026-10-12T11:01:00Z', publishedAt: '2026-10-12T11:02:00Z' };
  snapshotScope.metadata.refresh = { existingIdsRevalidation: scope, dailyRevalidation: { targetIds: 1, confirmedIds: 1 } };
  const current = envelope(snapshotScope);
  current.runPlan = { runDayKst: '2026-10-12', calls: 3, targetIds: ['a'], outcomes: { a: { state: 'verified_accepting', checkedAt: scope.verifiedAt } } };
  current.refreshState.state = 'in_progress_partial'; current.refreshState.lastSuccessfulAt = scope.verifiedAt;
  sdk.objects.set('senior-jobs/current.json', { etag: 'current', data: JSON.stringify(current) });
  sdk.objects.set('senior-jobs/control.json', { etag: 'control', data: JSON.stringify({ state: 'paused_incomplete',
    lastAttemptAt: '2026-10-12T11:00:00Z', errorCode: 'REPEATED_PAGE', dailyProgress: { targetIds: 1, confirmedIds: 1 },
    plan: { ...current.runPlan, calls: 4 } }) });
  const loaded = await loadDataset(createStore(sdk), true, now);
  assert.equal(loaded.refreshState.state, 'paused_incomplete'); assert.equal(loaded.refreshState.errorCode, 'REPEATED_PAGE');
  assert.deepEqual(loaded.refreshState.existingIdsRevalidation, scope);
});
test('a committed snapshot newer than its failed control write keeps the published daily progress', async () => {
  const sdk = memorySdk(), value = structuredClone(snapshot);
  value.metadata.refresh = { dailyRevalidation: { targetIds: 1, confirmedIds: 1 } };
  const current = envelope(value);
  current.runPlan = { runDayKst: '2026-10-12', startedAt: now().toISOString(), calls: 4, targetIds: ['a'], outcomes: { a: { state: 'verified_accepting', checkedAt: now().toISOString() } } };
  sdk.objects.set('senior-jobs/current.json', { etag: 'current', data: JSON.stringify(current) });
  sdk.objects.set('senior-jobs/control.json', { etag: 'control', data: JSON.stringify({ state: 'running', lastAttemptAt: now().toISOString(),
    dailyProgress: { targetIds: 1, confirmedIds: 0 }, plan: { ...current.runPlan, calls: 3, outcomes: {} } }) });
  const loaded = await loadDataset(createStore(sdk), true, now);
  assert.equal(loaded.refreshState.dailyRevalidation.confirmedIds, 1);
  assert.equal(loaded.refreshState.dailyRevalidation.verificationEvidence.statusAndPeriodAccepting, 1);
  assert.equal(loaded.refreshState.existingIdsRevalidation.state, 'succeeded');
});

test('a compact control checkpoint older than the committed snapshot cannot replace its progress or error state', async () => {
  const sdk = memorySdk(), value = structuredClone(snapshot);
  value.metadata.refresh = { dailyRevalidation: { dayKst: '2026-10-12', sourceCalls: 4, targetIds: 1, confirmedIds: 1 } };
  const current = envelope(value);
  current.runPlan = { runDayKst: '2026-10-12', startedAt: now().toISOString(), calls: 4, phase: 'discovery', targetIds: ['a'], outcomes: { a: { state: 'verified_accepting', checkedAt: now().toISOString() } } };
  sdk.objects.set('senior-jobs/current.json', { etag: 'current', data: JSON.stringify(current) });
  sdk.objects.set('senior-jobs/control.json', { etag: 'control', data: JSON.stringify({ state: 'paused_incomplete', errorCode: 'UPSTREAM_TIMEOUT',
    lastAttemptAt: '2026-10-12T12:00:00Z', resumeSource: 'current_snapshot', dailyProgress: { dayKst: '2026-10-12', sourceCalls: 3, targetIds: 1, confirmedIds: 0 } }) });
  const loaded = await loadDataset(createStore(sdk), true, now);
  assert.equal(loaded.refreshState.dailyRevalidation.confirmedIds, 1);
  assert.equal(loaded.refreshState.state, 'succeeded');
  assert.ok(!loaded.refreshState.errorCode);
});

test('a transient Blob socket read retries once without exposing its message or restarting the whole refresh', async () => {
  const sdk = memorySdk(), get = sdk.get, events = []; let attempts = 0;
  sdk.objects.set('senior-jobs/control.json', { etag: 'control', data: JSON.stringify({ state: 'in_progress_partial' }) });
  sdk.get = async function(pathname, options) {
    if (pathname.endsWith('control.json') && ++attempts === 1) throw new TypeError('fixture-secret https://private.example', { cause: { code: 'UND_ERR_SOCKET' } });
    return get.call(this, pathname, options);
  };
  const result = await createStore(sdk, { onEvent: e => events.push(e) }).readControl();
  assert.equal(result.value.state, 'in_progress_partial'); assert.equal(attempts, 2);
  assert.equal(events[0].networkCode, 'UND_ERR_SOCKET'); assert.equal(events[0].willRetry, true);
  assert.ok(events.some(e => e.event === 'blob_read_recovered'));
  assert.equal(JSON.stringify(events).includes('fixture-secret'), false); assert.equal(JSON.stringify(events).includes('https://'), false);
});
test('Blob retry shares a whole-operation deadline and never retries a conditional write or a permanent read error', async () => {
  let attempts = 0, signal;
  const sdk = { get: async (_path, options) => {
    attempts++; signal = options.abortSignal;
    if (attempts === 1) { await new Promise(r => setTimeout(r, 15)); throw new TypeError('fixture', { cause: { code: 'ECONNRESET' } }); }
    return new Promise(() => {});
  } };
  await assert.rejects(createStore(sdk, { timeoutMs: 25 }).readControl(), e => e.code === 'STORAGE_UNAVAILABLE');
  assert.equal(attempts, 2); assert.equal(signal.aborted, true);
  for (const status of [403, 503]) {
    class BlobError extends Error {}
    let gets = 0;
    await assert.rejects(createStore({ get: async () => { gets++; throw new BlobError('Vercel Blob: Failed to fetch blob: ' + status + ' fixture-private-message'); } }).readControl());
    assert.equal(gets, status === 403 ? 1 : 2);
  }
  let puts = 0;
  await assert.rejects(createStore({ put: async () => { puts++; throw new TypeError('fixture', { cause: { code: 'ECONNRESET' } }); } }).writeControl({}, 'etag'));
  assert.equal(puts, 1);
});
test('truncated JSON can be fetched again but a complete malformed object is not retried', async () => {
  for (const truncated of [true, false]) {
    let reads = 0;
    const sdk = { get: async () => {
      reads++; const content = reads === 1 ? '{"state":' : '{"state":"ok"}';
      return { statusCode: 200, blob: { size: truncated && reads === 1 ? 100 : Buffer.byteLength(content), etag: 'revision' },
        stream: new ReadableStream({ start(c) { c.enqueue(Buffer.from(content)); c.close(); } }) };
    } };
    const result = createStore(sdk).readControl();
    if (truncated) { assert.equal((await result).value.state, 'ok'); assert.equal(reads, 2); }
    else { await assert.rejects(result, SyntaxError); assert.equal(reads, 1); }
  }
});
test('a failed control read still serves and caches the newest published snapshot instead of reporting a worker failure', async () => {
  const value = structuredClone(snapshot); value.metadata.observedAt = '2026-10-12T17:17:31Z';
  value.metadata.refresh = { discovery: { nextPage: 93 }, dailyRevalidation: { discoveryNextPage: 93, confirmedIds: 314, targetIds: 314 } };
  const state = { ...envelope(value), refreshState: { state: 'in_progress_partial', schedulerEnabled: true, lastSuccessfulAt: null } };
  const store = { readCurrent: async () => ({ value: state }), readControl: async () => { throw new TypeError('fixture network failure'); } };
  const loaded = await loadDataset(store, true, now);
  assert.equal(loaded.snapshot.metadata.observedAt, value.metadata.observedAt);
  assert.equal(loaded.refreshState.state, 'in_progress_partial');
  assert.equal(loaded.refreshState.storageReadErrorCode, 'CONTROL_READ_UNAVAILABLE');
  assert.equal(loaded.refreshState.checkpointReadState, 'unavailable');
  assert.equal(loaded.refreshState.progressEvidence, 'published_snapshot');
  const unavailable = await loadDataset({ ...store, readCurrent: async () => { throw new Error('fixture'); } }, true, now);
  assert.equal(unavailable.snapshot.metadata.observedAt, value.metadata.observedAt);
  assert.equal(unavailable.refreshState.storageReadErrorCode, 'CURRENT_READ_UNAVAILABLE');
});

test('MCP read notices distinguish a missing control object, a failed control read and an unavailable current snapshot', async () => {
  const current = envelope(snapshot);
  const store = { readCurrent: async () => ({ value: current }), readControl: async () => null };
  const absent = await loadDataset(store, true, now);
  assert.equal(absent.refreshState.checkpointReadState, 'absent'); assert.equal(absent.refreshState.storageReadErrorCode, null);
  const controlFailure = await loadDataset({ ...store, readControl: async () => { throw new Error('fixture'); } }, true, now);
  const result = withDataset(controlFailure, () => jobs.describeOptions({}, now()));
  assert.equal(result.context.statusRevalidation.snapshotReadState, 'available');
  assert.equal(result.context.statusRevalidation.storageReadErrorCode, 'CONTROL_READ_UNAVAILABLE');
  assert.match(result.answerNotice.text, /체크포인트 상태는 확인하지 못했습니다/);
  const unavailable = await loadDataset({ ...store, readCurrent: async () => { throw new Error('fixture'); } }, true, now);
  const cached = withDataset(unavailable, () => jobs.describeOptions({}, now()));
  assert.equal(cached.context.statusRevalidation.snapshotReadState, 'unavailable');
  assert.match(cached.answerNotice.text, /현재 갱신 실행 상태는 미확인/);
});

test('cached snapshot fallback reports the current control-read outcome rather than inheriting an earlier result', async () => {
  const store = { readCurrent: async () => ({ value: envelope(snapshot) }), readControl: async () => ({ value: { state: 'succeeded' } }) };
  await loadDataset(store, true, now);
  const bothFail = await loadDataset({ readCurrent: async () => { throw new Error('fixture'); }, readControl: async () => { throw new Error('fixture'); } }, true, now);
  assert.equal(bothFail.refreshState.checkpointReadState, 'unavailable');
  await loadDataset({ ...store, readControl: async () => { throw new Error('fixture'); } }, true, now);
  const onlyCurrentFails = await loadDataset({ ...store, readCurrent: async () => { throw new Error('fixture'); } }, true, now);
  assert.equal(onlyCurrentFails.refreshState.checkpointReadState, 'available');
});

test('an expired checkpoint from the earlier same-day morning cycle cannot mark a newer cycle interrupted', async () => {
  const sdk = memorySdk(), value = structuredClone(snapshot);
  value.metadata.refresh = { dailyRevalidation: { dayKst: '2026-10-13', refreshCycleKst: '2026-10-13', sourceCalls: 10, confirmedIds: 0 } };
  const current = envelope(value); current.refreshState.state = 'in_progress_partial';
  current.runPlan = { runDayKst: '2026-10-13', refreshCycleKst: '2026-10-13', calls: 10, phase: 'revalidation' };
  sdk.objects.set('senior-jobs/current.json', { etag: 'current', data: JSON.stringify(current) });
  sdk.objects.set('senior-jobs/control.json', { etag: 'control', data: JSON.stringify({ state: 'running',
    lastAttemptAt: '2026-10-12T17:00:00Z', leaseUntil: '2026-10-12T17:01:30Z',
    dailyProgress: { dayKst: '2026-10-13', refreshCycleKst: '2026-10-12', sourceCalls: 10, confirmedIds: 314 },
    plan: { runDayKst: '2026-10-13', refreshCycleKst: '2026-10-12', calls: 10 } }) });
  const loaded = await loadDataset(createStore(sdk), true, () => new Date('2026-10-12T21:05:00Z'));
  assert.equal(loaded.refreshState.state, 'in_progress_partial');
  assert.equal(loaded.refreshState.dailyRevalidation.confirmedIds, 0);
});

test('a legacy compact checkpoint uses its attempt time to avoid overriding the new morning cycle', async () => {
  const sdk = memorySdk(), value = structuredClone(snapshot);
  value.metadata.refresh = { dailyRevalidation: { dayKst: '2026-10-13', refreshCycleKst: '2026-10-13', sourceCalls: 10, confirmedIds: 0 } };
  const current = envelope(value); current.refreshState.state = 'in_progress_partial';
  current.runPlan = { runDayKst: '2026-10-13', refreshCycleKst: '2026-10-13', calls: 10, phase: 'revalidation' };
  sdk.objects.set('senior-jobs/current.json', { etag: 'current', data: JSON.stringify(current) });
  sdk.objects.set('senior-jobs/control.json', { etag: 'control', data: JSON.stringify({ state: 'paused_incomplete',
    errorCode: 'DISCOVERY_REPEATED_PAGE_LIMIT', lastAttemptAt: '2026-10-12T17:00:00Z', resumeSource: 'current_snapshot',
    dailyProgress: { dayKst: '2026-10-13', sourceCalls: 10, confirmedIds: 314 } }) });
  const loaded = await loadDataset(createStore(sdk), true, () => new Date('2026-10-12T21:05:00Z'));
  assert.equal(loaded.refreshState.state, 'in_progress_partial'); assert.equal(loaded.refreshState.dailyRevalidation.confirmedIds, 0);
});
