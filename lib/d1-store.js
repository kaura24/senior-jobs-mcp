'use strict';
const { randomUUID } = require('node:crypto');
const { validateEnvelope, StoreFailure } = require('./snapshot-store');

const { readSql, writeSql, archiveSql, reportSql } = require('./d1-queries');

function createD1Store(query) {
  async function read(name) {
    const rows = await query(readSql, [name]);
    if (rows.length === 0) return null;
    const row = rows[0], value = JSON.parse(row.payload);
    if (name === 'current') {
      value.snapshot.jobs = JSON.parse(row.jobs_json);
      const details = JSON.parse(row.details_json);
      value.snapshot.detailSummaries = Object.fromEntries(Object.keys(value.snapshot.detailSummaries).map(id => [id, details[id]]));
      validateEnvelope(value);
    }
    return { value, etag: row.revision };
  }
  async function write(name, value, etag) {
    const payload = structuredClone(value);
    let jobs = null, details = null;
    if (name === 'current') {
      validateEnvelope(value);
      jobs = JSON.stringify(value.snapshot.jobs);
      details = JSON.stringify(value.snapshot.detailSummaries);
      payload.snapshot.jobs = [];
      payload.snapshot.detailSummaries = Object.fromEntries(Object.keys(value.snapshot.detailSummaries).map(id => [id, null]));
    }
    const encoded = JSON.stringify(payload);
    if ([encoded, jobs, details].some(part => part && Buffer.byteLength(part) > 1_900_000)) {
      throw new StoreFailure('SNAPSHOT_TOO_LARGE');
    }
    const revision = randomUUID(), expected = etag || null;
    const rows = await query(writeSql, [name, revision, encoded, jobs, details, expected, name, expected, expected]);
    if (rows.length !== 1 || rows[0].revision !== revision) throw new StoreFailure('PRECONDITION_FAILED');
    return { etag: revision };
  }
  async function archiveObservations(observations) {
    for (let offset = 0; offset < observations.length; offset += 20) {
      const batch = JSON.stringify(observations.slice(offset, offset + 20));
      if (Buffer.byteLength(batch) > 90_000) throw new StoreFailure('SNAPSHOT_TOO_LARGE');
      await query(archiveSql, [batch]);
    }
  }
  async function recordIngestion(plan, completedAt) {
    await query(reportSql, [plan.runId, completedAt, JSON.stringify({ ...plan.counts,
      completedRegions: plan.regionIndex, totalRegions: plan.regions.length, sourceCalls: plan.calls })]);
  }
  return { storageState: 'd1', archiveObservations, recordIngestion, readCurrent: () => read('current'), readControl: () => read('control'),
    writeCurrent: (value, etag) => write('current', value, etag), writeControl: (value, etag) => write('control', value, etag) };
}
module.exports = { createD1Store };
