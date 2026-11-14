CREATE TABLE IF NOT EXISTS source_observations (
  job_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  PRIMARY KEY(job_id,source_hash)
);
CREATE TABLE IF NOT EXISTS public_ingestion_runs (
  run_id TEXT PRIMARY KEY,
  completed_at TEXT,
  report_json TEXT CHECK(json_valid(report_json))
);
