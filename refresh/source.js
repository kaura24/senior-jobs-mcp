'use strict';
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { withinDeadline } = require('../lib/deadline');
const crypto = require('node:crypto');
const maximumBytes = 3_800_000;
class SourceFailure extends Error { constructor(code) { super(code); this.code = code; } }
function parseBody(xml, trace) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new SourceFailure('UNSAFE_OR_INVALID_XML');
  const result = new XMLParser({ parseTagValue: false, trimValues: true, processEntities: true }).parse(xml);
  const root = result.response;
  const code = root?.header?.resultCode ?? result.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode;
  if (trace) trace.apiResultCode = /^\d{1,4}$/.test(String(code)) ? String(code) : 'UNRECOGNIZED';
  if (!['00', '0000', '0'].includes(String(code))) {
    const known = { '22': 'UPSTREAM_DAILY_LIMIT', '23': 'UPSTREAM_RATE_LIMIT', '29': 'UPSTREAM_IP_DENIED', '30': 'UPSTREAM_KEY_REJECTED', '31': 'UPSTREAM_KEY_EXPIRED' };
    throw new SourceFailure(known[String(code)] || 'UPSTREAM_ERROR');
  }
  if (!root.body || typeof root.body !== 'object') throw new SourceFailure('INVALID_SOURCE_ITEMS');
  return root.body;
}
function parsePage(xml, pageNo, trace) {
  const body = parseBody(xml, trace);
  if (!/^\d+$/.test(String(body?.totalCount))) throw new SourceFailure('INVALID_TOTAL_COUNT');
  let items = body.items?.item || [];
  if (!Array.isArray(items)) items = [items];
  if (items.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new SourceFailure('INVALID_SOURCE_ITEMS');
  return { pageNo, reportedPageNo: body.pageNo, reportedNumOfRows: body.numOfRows, resultCode: '00', totalCount: Number(body.totalCount), items };
}
function parseDetail(xml, id, trace) {
  const body = parseBody(xml, trace);
  let rows = body?.item || body?.items?.item || [];
  if (!Array.isArray(rows)) rows = [rows];
  if (rows.some(row => row.jobId && row.jobId !== id)) throw new SourceFailure('DETAIL_ID_MISMATCH');
  const row = rows.find(row => row.jobId === id);
  return row ? { id, title: row.wantedTitle || row.recrtTitle || '', from: row.frAcptDd || row.frDd || '', to: row.toAcptDd || row.toDd || '' } : null;
}
async function requestXml(operation, params, key, fetchImpl = fetch, trace = {}, timeoutMs = 8000) {
  if (!key) throw new SourceFailure('SOURCE_KEY_NOT_CONFIGURED');
  const url = new URL('https://apis.data.go.kr/B552474/SenuriService/' + operation);
  let decoded; try { decoded = decodeURIComponent(key); } catch { throw new SourceFailure('UPSTREAM_KEY_REJECTED'); }
  url.search = new URLSearchParams({ serviceKey: decoded, ...params });
  if (operation === 'getJobList') {
    trace.requestedPageNo = Number(url.searchParams.get('pageNo'));
    trace.requestedNumOfRows = Number(url.searchParams.get('numOfRows'));
  }
  try {
    return await withinDeadline(async signal => {
      trace.phase = 'headers';
      const response = await fetchImpl(url, { redirect: 'error', signal, cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      trace.httpStatus = response.status;
      const age = response.headers.get('age'), control = response.headers.get('cache-control') || '', date = Date.parse(response.headers.get('date') || '');
      trace.cacheEvidence = { requestCache: 'no-store', requestRevalidation: true,
        ageSeconds: /^\d+$/.test(age || '') ? Number(age) : null,
        responseDate: Number.isFinite(date) ? new Date(date).toISOString() : null,
        responseNoCache: /(?:^|,)\s*no-cache(?:\s|,|$)/i.test(control), responseNoStore: /(?:^|,)\s*no-store(?:\s|,|$)/i.test(control) };
      if (!response.ok || !response.body) throw new SourceFailure('UPSTREAM_HTTP_ERROR');
      if (Number(response.headers.get('content-length')) > maximumBytes) { void response.body.cancel().catch(() => {}); throw new SourceFailure('UPSTREAM_TOO_LARGE'); }
      trace.phase = 'body';
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; trace.responseBytes = size;
          if (size > maximumBytes) { void reader.cancel().catch(() => {}); throw new SourceFailure('UPSTREAM_TOO_LARGE'); }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks).toString('utf8');
      } finally { reader.releaseLock(); }
    }, timeoutMs, () => new SourceFailure('UPSTREAM_TIMEOUT'));
  } catch (cause) {
    if (cause instanceof SourceFailure) throw cause;
    throw new SourceFailure(['TimeoutError', 'AbortError'].includes(cause.name) ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK_ERROR');
  }
}
async function fetchPage(pageNo, key, { fetchImpl = fetch, pageSize = 1000, search } = {}) {
  return parsePage(await requestXml('getJobList', { pageNo: String(pageNo), numOfRows: String(pageSize), ...(search ? { search } : {}) }, key, fetchImpl), pageNo);
}
function createSource(key, fetchImpl = fetch, { timeoutMs = 8000, onEvent = () => {} } = {}) {
  let lastStarted = 0;
  const stats = { requests: 0, totalElapsedMs: 0, maximumElapsedMs: 0, recent: [] };
  async function measured(operation, params, parse, safe = {}) {
    const wait = Math.max(0, 500 - (Date.now() - lastStarted));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastStarted = Date.now();
    const trace = { operation, ...safe, state: 'started', startedAt: new Date(lastStarted).toISOString(),
      timeoutMs, attempt: 1, maxAttempts: 1, pacingWaitMs: wait, phase: 'headers', httpStatus: null, apiResultCode: null, responseBytes: 0 };
    onEvent({ ...trace });
    try {
      const xml = await requestXml(operation, params, key, fetchImpl, trace, timeoutMs);
      trace.phase = 'parse';
      const result = parse(xml, trace);
      if (operation === 'getJobList') {
        trace.totalCount = result.totalCount; trace.returnedItems = result.items.length;
        trace.regionFieldPresence = { sourceField: 'workPlcNm',
          providedItems: result.items.filter(row => typeof row.workPlcNm === 'string' && row.workPlcNm.trim()).length,
          absentItems: result.items.filter(row => !Object.hasOwn(row, 'workPlcNm')).length,
          emptyItems: result.items.filter(row => Object.hasOwn(row, 'workPlcNm') && !String(row.workPlcNm || '').trim()).length };
        trace.reportedPageNo = /^\d+$/.test(String(result.reportedPageNo)) ? Number(result.reportedPageNo) : null;
        trace.reportedNumOfRows = /^\d+$/.test(String(result.reportedNumOfRows)) ? Number(result.reportedNumOfRows) : null;
        const ids = [...new Set(result.items.map(row => row.jobId).filter(id => typeof id === 'string'))].sort();
        trace.distinctJobIds = ids.length;
        trace.idSetDigest = crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
        const safeId = id => /^[A-Za-z0-9_-]{1,100}$/.test(id || '') ? id : null;
        trace.firstJobId = safeId(ids[0]); trace.lastJobId = safeId(ids.at(-1));
      }
      trace.state = 'succeeded';
      return result;
    } catch (cause) {
      trace.state = 'failed'; trace.errorCode = cause instanceof SourceFailure ? cause.code : 'UPSTREAM_ERROR';
      throw cause;
    } finally {
      trace.finishedAt = new Date().toISOString(); trace.elapsedMs = Date.now() - lastStarted;
      stats.requests++; stats.totalElapsedMs += trace.elapsedMs; stats.maximumElapsedMs = Math.max(stats.maximumElapsedMs, trace.elapsedMs);
      stats.recent.push({ ...trace }); if (stats.recent.length > 8) stats.recent.shift();
      onEvent({ ...trace });
    }
  }
  return { detail: id => measured('getJobInfo', { id }, (xml, trace) => parseDetail(xml, id, trace), { jobId: id }),
    list: (pageNo, pageSize, search) => measured('getJobList', { pageNo: String(pageNo), numOfRows: String(pageSize), ...(search ? { search } : {}) },
      (xml, trace) => parsePage(xml, pageNo, trace), { pageNo }),
    diagnostics: () => structuredClone(stats) };
}
module.exports = { fetchPage, parsePage, parseDetail, createSource, SourceFailure };
