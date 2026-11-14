'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { digest, validateEnvelope } = require('./blob-store');
const { eligibility, kstDay } = require('./jobs');
const { posting: parsePosting } = require('../refresh/public-source');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function preparePublicImport(collection, current) {
  if (!Array.isArray(collection.postings) || !collection.completedAt || !collection.source?.startsWith('https://www.seniorro.or.kr/')) {
    throw new Error('INVALID_PUBLIC_COLLECTION');
  }
  if (current) validateEnvelope(current.value);
  const previous = current?.value.snapshot;
  const jobs = new Map((previous?.jobs || []).map(row => [row.jobId, row]));
  const metadata = structuredClone(previous?.metadata || {});
  const sourceObservedById = { ...metadata.sourceObservedById }, sourceLinksById = { ...metadata.sourceLinksById };
  const counts = { new: 0, updated: 0, unchanged: 0, failed: 0, retained: 0 };
  const observations = [], verifiedIds = new Set();
  for (const posting of collection.postings) {
    const { row, source } = posting;
    const expected = `SR_${source.projectType}_${source.sourceJobId}_${source.institutionId}`;
    const parsed = parsePosting(source.fields, source.observedAt);
    if (row.jobId !== expected || sha(parsed.row) !== sha(row) || parsed.source.url !== source.url
      || !eligibility(row, new Date(collection.completedAt)).eligible) { counts.failed++; continue; }
    const prior = jobs.get(row.jobId);
    if (!prior) counts.new++;
    else if (sha(prior) === sha(row)) counts.unchanged++;
    else {
      counts.updated++;
      observations.push({ jobId: prior.jobId, hash: sha(prior), url: sourceLinksById[prior.jobId]?.url || '',
        at: sourceObservedById[prior.jobId] || metadata.observedAt, raw: prior });
    }
    jobs.set(row.jobId, row);
    sourceObservedById[row.jobId] = source.observedAt;
    verifiedIds.add(row.jobId);
    const { fields, ...link } = source;
    sourceLinksById[row.jobId] = link;
    observations.push({ jobId: row.jobId, hash: sha(fields), url: source.url, at: source.observedAt, raw: fields });
  }
  counts.retained = (previous?.jobs || []).filter(row => !observations.some(entry => entry.jobId === row.jobId)).length;
  const at = collection.completedAt, rows = [...jobs.values()];
  const snapshot = { metadata: { ...metadata, observedAt: at, referenceDayKst: kstDay(new Date(at)),
    datasetState: 'official_public_recollection', coverageVerified: false, storedListJobs: rows.length,
    cachedDetailSummaries: Object.keys(previous?.detailSummaries || {}).length, fullDetailDocuments: 0,
    jobsWithoutDetail: rows.length - Object.keys(previous?.detailSummaries || {}).length,
    sourceObservedById, sourceLinksById, collection: { ...collection.counts, source: collection.source,
      failures: collection.failures, observedRegions: collection.regions },
    refresh: { scanScope: 'official_public_region_search', retainedNotRevalidated: counts.retained,
      latestStatusRevalidatedIds: [...verifiedIds] } },
    jobs: rows, detailSummaries: previous?.detailSummaries || {} };
  const envelope = { schemaVersion: 1, snapshot, sha256: digest(snapshot), refreshState: { state: 'public_recollection_completed',
    schedulerEnabled: false, lastAttemptAt: collection.startedAt, lastPublishedAt: at, lastSuccessfulAt: null,
    errorCode: collection.failures.length ? 'PUBLIC_REGIONS_INCOMPLETE' : null } };
  validateEnvelope(envelope);
  return { envelope, counts, observations, expectedRevision: current?.etag || null };
}

function importSql(prepared) {
  const runId = randomUUID(), template = structuredClone(prepared.envelope);
  template.snapshot.jobs = [];
  template.snapshot.detailSummaries = Object.fromEntries(Object.keys(prepared.envelope.snapshot.detailSummaries).map(key => [key, null]));
  const parts = { current: template, jobs: prepared.envelope.snapshot.jobs, details: prepared.envelope.snapshot.detailSummaries,
    observations: prepared.observations, report: prepared.counts };
  const sql = ['CREATE TABLE IF NOT EXISTS public_import_inputs(run_id TEXT, kind TEXT, ordinal INTEGER, part TEXT, PRIMARY KEY(run_id,kind,ordinal));',
    'CREATE TABLE IF NOT EXISTS source_observations(job_id TEXT, source_hash TEXT, source_url TEXT, observed_at TEXT, source_json TEXT, PRIMARY KEY(job_id,source_hash));',
    'CREATE TABLE IF NOT EXISTS public_ingestion_runs(run_id TEXT PRIMARY KEY, completed_at TEXT, report_json TEXT);'];
  for (const [kind, value] of Object.entries(parts)) {
    const characters = Array.from(JSON.stringify(value));
    for (let offset = 0, ordinal = 0; offset < characters.length; offset += 10000, ordinal++) {
      sql.push(`INSERT INTO public_import_inputs VALUES(${quote(runId)},${quote(kind)},${ordinal},${quote(characters.slice(offset,offset+10000).join(''))});`);
    }
  }
  const input = kind => `(SELECT group_concat(part,'') FROM (SELECT part FROM public_import_inputs WHERE run_id=${quote(runId)} AND kind=${quote(kind)} ORDER BY ordinal))`;
  const expected = prepared.expectedRevision ? quote(prepared.expectedRevision) : 'NULL';
  const ready = `EXISTS(SELECT 1 FROM storage_documents WHERE name='current' AND revision=${quote(runId)})`;
  sql.push(`INSERT OR IGNORE INTO source_observations SELECT json_extract(value,'$.jobId'),json_extract(value,'$.hash'),json_extract(value,'$.url'),json_extract(value,'$.at'),json_extract(value,'$.raw') FROM json_each(${input('observations')});`);
  sql.push(`INSERT INTO storage_documents(name,revision,payload,incoming_jobs,incoming_details)
    SELECT 'current',${quote(runId)},${input('current')},${input('jobs')},${input('details')}
    WHERE ${expected} IS NULL OR EXISTS(SELECT 1 FROM storage_documents WHERE name='current' AND revision=${expected})
    ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,incoming_jobs=excluded.incoming_jobs,incoming_details=excluded.incoming_details
    WHERE storage_documents.revision=${expected};`);
  sql.push(`INSERT INTO public_ingestion_runs SELECT ${quote(runId)},${quote(prepared.envelope.snapshot.metadata.observedAt)},${input('report')} WHERE ${ready};`);
  return { sql: sql.join('\n'), runId };
}
module.exports = { preparePublicImport, importSql };
