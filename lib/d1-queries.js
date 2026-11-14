'use strict';
const readSql = `SELECT revision, payload,
  (SELECT json_group_array(json(raw)) FROM (SELECT raw FROM jobs ORDER BY ordinal)) AS jobs_json,
  (SELECT json_group_object(job_id, json(payload)) FROM job_details) AS details_json
  FROM storage_documents WHERE name = ?`;
const writeSql = `INSERT INTO storage_documents(name, revision, payload, incoming_jobs, incoming_details)
  SELECT ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS
    (SELECT 1 FROM storage_documents WHERE name = ? AND revision = ?)
  ON CONFLICT(name) DO UPDATE SET revision = excluded.revision, payload = excluded.payload,
    incoming_jobs = excluded.incoming_jobs, incoming_details = excluded.incoming_details
  WHERE storage_documents.revision = ? RETURNING revision`;
const archiveSql = `INSERT OR IGNORE INTO source_observations(job_id,source_hash,source_url,observed_at,source_json)
        SELECT json_extract(value,'$.jobId'),json_extract(value,'$.hash'),json_extract(value,'$.url'),
          json_extract(value,'$.at'),json_extract(value,'$.raw') FROM json_each(?) RETURNING job_id`;
const reportSql = `INSERT OR IGNORE INTO public_ingestion_runs(run_id,completed_at,report_json)
      VALUES(?,?,?) RETURNING run_id`;
const operations = { readDocument: readSql, writeDocument: writeSql, archiveEvidence: archiveSql, recordRun: reportSql };
module.exports = { readSql, writeSql, archiveSql, reportSql, operations };
