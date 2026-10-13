'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jobs = require('../lib/jobs');
const publicFields = ['jobId', 'recrtTitle', 'oranNm', 'organYn', 'workPlcNm', 'workPlc', 'frDd', 'toDd', 'deadline',
  'emplymShp', 'emplymShpNm', 'acptMthd', 'jobcls', 'jobclsNm', 'stmId', 'stmNm'];
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
class RefreshFailure extends Error {
  constructor(code) { super(code); this.name = 'RefreshFailure'; this.code = code; }
}

function prepare(previous, pages, observedAt, pageSize) {
  const now = new Date(observedAt);
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !pages.length) throw new RefreshFailure('INVALID_SCAN_PLAN');
  let total = null, rawCount = 0, duplicateIds = 0;
  const unique = new Map(), hashes = new Set();
  pages.forEach((page, index) => {
    if (page.pageNo !== index + 1 || (page.reportedPageNo && Number(page.reportedPageNo) !== page.pageNo)) throw new RefreshFailure('PAGE_SEQUENCE_MISMATCH');
    if (!Array.isArray(page.items) || !Number.isInteger(page.totalCount) || page.totalCount < 0 || page.items.length > pageSize) throw new RefreshFailure('INVALID_PAGE');
    if (page.resultCode && !['00', '0000', '0'].includes(String(page.resultCode))) throw new RefreshFailure('UPSTREAM_ERROR');
    if (total !== null && total !== page.totalCount) throw new RefreshFailure('TOTAL_CHANGED_DURING_SCAN');
    total = page.totalCount;
    const rows = page.items.map(row => Object.fromEntries(publicFields.filter(field => typeof row[field] === 'string').map(field => [field, row[field]])));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    if (rows.length && hashes.has(fingerprint)) throw new RefreshFailure('REPEATED_PAGE');
    hashes.add(fingerprint);
    for (const row of rows) {
      rawCount++;
      if (!row.jobId?.trim()) throw new RefreshFailure('MISSING_ID');
      if (unique.has(row.jobId)) {
        if (canonical(unique.get(row.jobId)) !== canonical(row)) throw new RefreshFailure('ID_CONTENT_CONFLICT');
        duplicateIds++;
      } else unique.set(row.jobId, row);
    }
  });
  const expectedPages = Math.ceil(total / pageSize);
  if (unique.size > total || pages.length > Math.max(1, expectedPages)) throw new RefreshFailure('TOTAL_INCONSISTENT');
  const coverageVerified = unique.size === total && pages.length === Math.max(1, expectedPages) && duplicateIds === 0;
  const active = [...unique.values()].filter(row => jobs.eligibility(row, now).eligible);
  const activeIds = new Set(active.map(row => row.jobId));
  const retained = previous.jobs.filter(row => !unique.has(row.jobId) && jobs.eligibility(row, now).eligible);
  const completeActive = coverageVerified ? active : [...active, ...retained];
  const summaries = Object.fromEntries(Object.entries(previous.detailSummaries).filter(([id]) => completeActive.some(row => row.jobId === id)));
  const sourceObservedById = Object.fromEntries(completeActive.map(row => [row.jobId, activeIds.has(row.jobId) ? observedAt
    : previous.metadata.sourceObservedById?.[row.jobId] || previous.metadata.observedAt]));
  const metadata = { ...previous.metadata, datasetState: coverageVerified ? 'complete_refreshed_snapshot' : 'partial_refreshed_snapshot', observedAt,
    referenceDayKst: jobs.kstDay(now), coverageVerified, storedListJobs: completeActive.length,
    cachedDetailSummaries: Object.keys(summaries).length, fullDetailDocuments: 0,
    jobsWithoutDetail: completeActive.length - Object.keys(summaries).length, sourceObservedById,
    refresh: { sourceTotalCount: total, scannedRawRows: rawCount, uniqueScannedIds: unique.size, duplicateOccurrences: duplicateIds,
      completedPages: pages.length, expectedPages, pageSize, scanScope: coverageVerified ? 'all_pages_verified' : 'explicit_prefix_partial_scan',
      newlyObservedActive: active.filter(row => !previous.jobs.some(old => old.jobId === row.jobId)).length,
      excludedInObservedScope: unique.size - active.length, removedExpiredCached: previous.jobs.filter(row => !jobs.eligibility(row, now).eligible).length,
      retainedNotRevalidated: retained.length, latestStatusRevalidatedIds: active.map(row => row.jobId) } };
  return { metadata, jobs: completeActive, detailSummaries: summaries };
}

function publish(directory, snapshot, beforeSwitch) {
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, '.refresh.lock');
  const lock = fs.openSync(lockPath, 'wx');
  try {
    const revision = crypto.randomUUID();
    const releases = path.join(directory, 'releases');
    fs.mkdirSync(releases, { recursive: true });
    const target = path.join(releases, revision + '.json');
    const data = JSON.stringify(snapshot, null, 2) + '\n';
    fs.writeFileSync(target, data, { flag: 'wx' });
    const file = fs.openSync(target, 'r'); try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
    const pointer = path.join(directory, revision + '.pointer');
    fs.writeFileSync(pointer, revision + '.json\n', { flag: 'wx' });
    if (beforeSwitch) beforeSwitch();
    fs.renameSync(pointer, path.join(directory, 'CURRENT'));
    return { revision, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

function current(directory) {
  const pointer = fs.readFileSync(path.join(directory, 'CURRENT'), 'utf8').trim();
  if (!/^[a-f0-9-]{36}\.json$/.test(pointer)) throw new RefreshFailure('INVALID_POINTER');
  return JSON.parse(fs.readFileSync(path.join(directory, 'releases', pointer), 'utf8'));
}

module.exports = { prepare, publish, current, RefreshFailure };
