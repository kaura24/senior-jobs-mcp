'use strict';
const { createHash } = require('node:crypto');
class StoreFailure extends Error { constructor(code) { super(code); this.code = code; } }
function digest(snapshot) { return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
function validateEnvelope(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.snapshot?.jobs) || !value.snapshot.metadata || !value.snapshot.detailSummaries
    || !value.refreshState || value.sha256 !== digest(value.snapshot)) throw new StoreFailure('SNAPSHOT_INVALID');
  const ids = new Set();
  for (const row of value.snapshot.jobs) {
    if (typeof row.jobId !== 'string' || !row.jobId.trim() || ids.has(row.jobId)) throw new StoreFailure('SNAPSHOT_INVALID');
    ids.add(row.jobId);
  }
  return value;
}
module.exports = { StoreFailure, digest, validateEnvelope };
