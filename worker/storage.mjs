import queries from '../lib/d1-queries.js';
import snapshots from '../lib/snapshot-store.js';
import { createHash } from 'node:crypto';
const { validateEnvelope } = snapshots;
export class InvalidOperation extends Error { constructor() { super('INVALID_STORAGE_OPERATION'); } }
const invalid = () => { throw new InvalidOperation(); };
const nameValid = name => name === 'current' || name === 'control';
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function json(value, limit = 1_900_000) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) invalid();
  try { return JSON.parse(value); } catch { return invalid(); }
}
const guardedWrite = `INSERT INTO storage_documents(name,revision,payload,incoming_jobs,incoming_details)
  SELECT ?,?,?,?,? WHERE (? IS NULL OR EXISTS(SELECT 1 FROM storage_documents WHERE name=? AND revision=?))
    AND (?='control' OR (
      NOT EXISTS(SELECT 1 FROM jobs WHERE job_id NOT IN(SELECT json_extract(value,'$.jobId') FROM json_each(?)))
      AND NOT EXISTS(SELECT 1 FROM job_details WHERE job_id NOT IN(SELECT key FROM json_each(?)))))
  ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,
    incoming_jobs=excluded.incoming_jobs,incoming_details=excluded.incoming_details
  WHERE storage_documents.revision=? RETURNING revision`;
export function operation(body) {
  if (!body || Object.keys(body).sort().join(',') !== 'operation,parameters'
    || !Object.hasOwn(queries.operations, body.operation) || !Array.isArray(body.parameters)) invalid();
  const p = body.parameters;
  if (body.operation === 'readDocument') {
    if (p.length !== 1 || !nameValid(p[0])) invalid();
    return { sql: p[0] === 'control' ? `SELECT revision,payload,NULL AS jobs_json,NULL AS details_json
      FROM storage_documents WHERE name=?` : queries.readSql, parameters: p };
  }
  if (body.operation === 'writeDocument') {
    if (p.length !== 9 || !nameValid(p[0]) || !uuid(p[1]) || !(p[5] === null || uuid(p[5]))
      || p[6] !== p[0] || p[7] !== p[5] || p[8] !== p[5]) invalid();
    const payload = json(p[2]);
    if (p[0] === 'current') {
      payload.snapshot.jobs = json(p[3]);
      const details = json(p[4]);
      payload.snapshot.detailSummaries = Object.fromEntries(Object.keys(payload.snapshot.detailSummaries).map(id => [id, details[id]]));
      try { validateEnvelope(payload); } catch { invalid(); }
    } else if (!payload || typeof payload !== 'object' || Array.isArray(payload) || p[3] !== null || p[4] !== null) invalid();
    return { sql: guardedWrite, parameters: [...p.slice(0, 8), p[0], p[3], p[4], p[8]] };
  }
  if (body.operation === 'archiveEvidence') {
    if (p.length !== 1) invalid();
    const rows = json(p[0], 90000);
    if (!Array.isArray(rows) || rows.length > 20) invalid();
    for (const row of rows) {
      const match = /^SR_([ACBE])_([A-Za-z0-9_-]{1,40})_([A-Za-z0-9_-]{1,40})$/.exec(row.jobId || '');
      if (!match || !row.raw || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) invalid();
      const expected = new URL('https://www.seniorro.or.kr/noin/jobDetail.do');
      expected.search = new URLSearchParams({ jobId: match[2], projType: match[1], instnId: match[3] }).toString();
      if (row.url !== expected.href || row.hash !== createHash('sha256').update(JSON.stringify(row.raw)).digest('hex')) invalid();
    }
    return { sql: queries.archiveSql, parameters: p };
  }
  if (p.length !== 3 || !uuid(p[0]) || !Number.isFinite(Date.parse(p[1]))) invalid();
  const report = json(p[2], 10000);
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || !Object.values(report).every(value => Number.isInteger(value) && value >= 0)) invalid();
  return { sql: queries.reportSql, parameters: p };
}
