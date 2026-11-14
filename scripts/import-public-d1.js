'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createD1Store } = require('../lib/d1-store');
const { query } = require('../lib/d1-wrangler');
const { preparePublicImport, importSql } = require('../lib/public-import');
const execute = promisify(execFile);

async function run(inputPath, outputPrefix) {
  const collection = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const store = createD1Store(query), current = await store.readCurrent();
  if (current) fs.writeFileSync(outputPrefix + '.before.json', JSON.stringify(current), { flag: 'wx', mode: 0o600 });
  const prepared = preparePublicImport(collection, current);
  if (prepared.counts.failed) throw new Error('PUBLIC_IMPORT_HAS_INVALID_RECORDS');
  if (prepared.counts.new === 0 && prepared.counts.updated === 0 && current?.value.sha256 === prepared.envelope.sha256) {
    const result = { ...prepared.counts, committed: false, reason: 'no_content_changes', storedJobs: current.value.snapshot.jobs.length };
    fs.writeFileSync(outputPrefix + '.report.json', JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result)); return result;
  }
  const generated = importSql(prepared), sqlPath = outputPrefix + '.sql';
  fs.writeFileSync(sqlPath, generated.sql, { flag: 'wx', mode: 0o600 });
  await execute('npx', ['--offline', 'wrangler@4.162.0', 'd1', 'execute', 'senior-jobs-mcp', '--remote',
    '--config', path.resolve(__dirname, '../wrangler.jsonc'), '--file', sqlPath, '--json'], { timeout: 120000, maxBuffer: 4000000 });
  const restored = await store.readCurrent();
  if (restored?.etag !== generated.runId || restored.value.sha256 !== prepared.envelope.sha256) throw new Error('PUBLIC_IMPORT_READBACK_MISMATCH');
  const beforeIds = new Set((current?.value.snapshot.jobs || []).map(row => row.jobId));
  const afterIds = new Set(restored.value.snapshot.jobs.map(row => row.jobId));
  if ([...beforeIds].some(id => !afterIds.has(id))) throw new Error('PUBLIC_IMPORT_LOST_EXISTING_ID');
  const result = { ...prepared.counts, committed: true, runId: generated.runId, storedJobs: afterIds.size,
    snapshotHashVerified: true, existingIdsPreserved: beforeIds.size, source: collection.source,
    observedAt: collection.completedAt, sourceFailedRegions: collection.counts.failedRegions,
    sourceInvalidRecords: collection.counts.invalidRecords, sourceConflictingIds: collection.counts.conflictingIds };
  fs.writeFileSync(outputPrefix + '.report.json', JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result)); return result;
}
if (require.main === module) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/import-public-d1.js COLLECTION_JSON OUTPUT_PREFIX');
  run(process.argv[2], process.argv[3]).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { run };
