'use strict';
const { eligibility } = require('../lib/jobs');
const origin = 'https://www.seniorro.or.kr';
class PublicSourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
async function post(path, body) {
  try {
    const response = await fetch(origin + path, { method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new PublicSourceError(`PUBLIC_SOURCE_HTTP_${response.status}`);
    return await response.json();
  } catch (cause) {
    if (cause instanceof PublicSourceError) throw cause;
    if (cause instanceof SyntaxError) throw new PublicSourceError('INVALID_PUBLIC_RESPONSE');
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') throw new PublicSourceError('PUBLIC_SOURCE_TIMEOUT');
    throw new PublicSourceError('PUBLIC_SOURCE_NETWORK');
  }
}
async function discoverRegions() {
  const regions = new Map();
  let excluded = 0;
  for (const keyword of ['시', '도']) {
    const data = await post('/noin/searchAreaList.do', { keyword });
    if (data.result !== 'success' || !Array.isArray(data.list)) throw new PublicSourceError('INVALID_PUBLIC_REGIONS');
    for (const row of data.list) {
      if (typeof row.areaNm !== 'string' || typeof row.areaSgngNm !== 'string' || row.areaNm === '임시') { excluded++; continue; }
      regions.set(`${row.areaNm}/${row.areaSgngNm}`, { province: row.areaNm, district: row.areaSgngNm });
    }
  }
  return { regions: [...regions.values()], excluded };
}
async function fetchRegionPage(region, page) {
  const request = { sst01: region.province, sst02: region.district, projTypeList: ['A', 'C', 'B', 'E'],
    orderType: 'i', currentPageNo: page, pageSize: 30 };
  const data = await post('/noin/searchJobList.do', request);
  if (!Number.isInteger(data.totalCnt) || data.totalCnt < 0 || (data.list !== null && !Array.isArray(data.list))) {
    throw new PublicSourceError('INVALID_PUBLIC_PAGE');
  }
  if (data.totalCnt > 0 && !data.list?.length) throw new PublicSourceError('EMPTY_PUBLIC_PAGE');
  return { total: data.totalCnt, rows: data.list || [], request, observedAt: new Date().toISOString() };
}
function posting(record, observedAt) {
  for (const key of ['JOB_ID', 'PROJ_TYPE', 'INSTN_ID']) {
    if (typeof record[key] !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(record[key])) throw new PublicSourceError('INVALID_PUBLIC_JOB_ID');
  }
  if (typeof record.RECRT_TITLE !== 'string' || !record.RECRT_TITLE.trim()) throw new PublicSourceError('PUBLIC_TITLE_MISSING');
  const row = { jobId: `SR_${record.PROJ_TYPE}_${record.JOB_ID}_${record.INSTN_ID}` };
  const mapping = { recrtTitle: 'RECRT_TITLE', oranNm: 'ORAN_NM', workPlcNm: 'WORK_PLC_NM', workPlc: 'WORK_PLC',
    frDd: 'FR_DD', toDd: 'TO_DD', deadline: 'DEADLINE', jobcls: 'JOBCLS', jobclsNm: 'JOBCLS_NM', stmId: 'STM_ID', stmNm: 'STM_NM' };
  for (const [key, raw] of Object.entries(mapping)) if (typeof record[raw] === 'string') row[key] = record[raw];
  const eligible = eligibility(row, new Date(observedAt));
  const currentYear = String(new Date(Date.parse(observedAt) + 9 * 3600000).getUTCFullYear());
  const expiredProject = typeof record.PROJ_YEAR === 'string' && record.PROJ_YEAR < currentYear;
  const params = new URLSearchParams({ jobId: record.JOB_ID, projType: record.PROJ_TYPE, instnId: record.INSTN_ID });
  return { row, eligible: eligible.eligible && !expiredProject,
    reason: expiredProject ? 'expired_project_year' : eligible.reason,
    source: { url: `${origin}/noin/jobDetail.do?${params}`, sourceJobId: record.JOB_ID,
      projectType: record.PROJ_TYPE, institutionId: record.INSTN_ID, observedAt, fields: record } };
}
module.exports = { discoverRegions, fetchRegionPage, posting, PublicSourceError };
