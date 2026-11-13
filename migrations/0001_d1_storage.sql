CREATE TABLE storage_documents (
  name TEXT PRIMARY KEY CHECK (name IN ('current', 'control')),
  revision TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  incoming_jobs TEXT CHECK (incoming_jobs IS NULL OR json_valid(incoming_jobs)),
  incoming_details TEXT CHECK (incoming_details IS NULL OR json_valid(incoming_details))
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL,
  raw TEXT NOT NULL CHECK (json_valid(raw)),
  region TEXT GENERATED ALWAYS AS (json_extract(raw, '$.workPlcNm')) VIRTUAL,
  deadline TEXT GENERATED ALWAYS AS (json_extract(raw, '$.deadline')) VIRTUAL,
  application_to TEXT GENERATED ALWAYS AS (json_extract(raw, '$.toDd')) VIRTUAL
);
CREATE INDEX jobs_region ON jobs(region);
CREATE INDEX jobs_deadline ON jobs(deadline, application_to);

CREATE TABLE job_details (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);

CREATE TRIGGER publish_jobs_insert AFTER INSERT ON storage_documents
WHEN NEW.name = 'current' AND NEW.incoming_jobs IS NOT NULL
BEGIN
  INSERT INTO jobs(job_id, ordinal, raw)
    SELECT json_extract(value, '$.jobId'), CAST(key AS INTEGER), value
    FROM json_each(NEW.incoming_jobs) WHERE TRUE
    ON CONFLICT(job_id) DO UPDATE SET ordinal = excluded.ordinal, raw = excluded.raw
    WHERE jobs.ordinal <> excluded.ordinal OR jobs.raw <> excluded.raw;
  DELETE FROM job_details WHERE job_id NOT IN (SELECT key FROM json_each(NEW.incoming_details));
  DELETE FROM jobs WHERE job_id NOT IN (SELECT json_extract(value, '$.jobId') FROM json_each(NEW.incoming_jobs));
  INSERT INTO job_details(job_id, payload)
    SELECT key, value FROM json_each(NEW.incoming_details) WHERE TRUE
    ON CONFLICT(job_id) DO UPDATE SET payload = excluded.payload
    WHERE job_details.payload <> excluded.payload;
  UPDATE storage_documents SET incoming_jobs = NULL, incoming_details = NULL WHERE name = NEW.name;
END;

CREATE TRIGGER publish_jobs_update AFTER UPDATE OF revision ON storage_documents
WHEN NEW.name = 'current' AND NEW.incoming_jobs IS NOT NULL
BEGIN
  INSERT INTO jobs(job_id, ordinal, raw)
    SELECT json_extract(value, '$.jobId'), CAST(key AS INTEGER), value
    FROM json_each(NEW.incoming_jobs) WHERE TRUE
    ON CONFLICT(job_id) DO UPDATE SET ordinal = excluded.ordinal, raw = excluded.raw
    WHERE jobs.ordinal <> excluded.ordinal OR jobs.raw <> excluded.raw;
  DELETE FROM job_details WHERE job_id NOT IN (SELECT key FROM json_each(NEW.incoming_details));
  DELETE FROM jobs WHERE job_id NOT IN (SELECT json_extract(value, '$.jobId') FROM json_each(NEW.incoming_jobs));
  INSERT INTO job_details(job_id, payload)
    SELECT key, value FROM json_each(NEW.incoming_details) WHERE TRUE
    ON CONFLICT(job_id) DO UPDATE SET payload = excluded.payload
    WHERE job_details.payload <> excluded.payload;
  UPDATE storage_documents SET incoming_jobs = NULL, incoming_details = NULL WHERE name = NEW.name;
END;
