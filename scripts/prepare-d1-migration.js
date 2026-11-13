'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { validateEnvelope } = require('../lib/blob-store');

function prepareMigration(current, control) {
  validateEnvelope(current);
  if (!control || typeof control !== 'object' || !control.plan || !Array.isArray(control.plan.targetIds)) {
    throw new Error('A full original refresh checkpoint is required');
  }
  const id = randomUUID(), template = structuredClone(current);
  template.snapshot.jobs = [];
  template.snapshot.detailSummaries = Object.fromEntries(Object.keys(current.snapshot.detailSummaries).map(key => [key, null]));
  const parts = { current: template, jobs: current.snapshot.jobs, details: current.snapshot.detailSummaries, control };
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const sql = [
    'CREATE TABLE IF NOT EXISTS migration_inputs (migration_id TEXT, kind TEXT, ordinal INTEGER, part TEXT, PRIMARY KEY(migration_id, kind, ordinal));'
  ];
  for (const [kind, value] of Object.entries(parts)) {
    const text = Array.from(JSON.stringify(value));
    for (let offset = 0, ordinal = 0; offset < text.length; offset += 10000, ordinal++) {
      sql.push(`INSERT INTO migration_inputs VALUES (${quote(id)},${quote(kind)},${ordinal},${quote(text.slice(offset, offset + 10000).join(''))});`);
    }
  }
  const input = kind => `(SELECT group_concat(part, '') FROM (SELECT part FROM migration_inputs WHERE migration_id=${quote(id)} AND kind=${quote(kind)} ORDER BY ordinal))`;
  sql.push(`INSERT INTO storage_documents(name,revision,payload,incoming_jobs,incoming_details) VALUES ('current',${quote(id)},${input('current')},${input('jobs')},${input('details')});`);
  sql.push(`INSERT INTO storage_documents(name,revision,payload) VALUES ('control',${quote(randomUUID())},${input('control')});`);
  sql.push(`DELETE FROM migration_inputs WHERE migration_id=${quote(id)};`);
  return sql.join('\n') + '\n';
}
if (require.main === module) {
  const [currentPath, controlPath, outputPath] = process.argv.slice(2);
  if (!currentPath || !controlPath || !outputPath) throw new Error('Usage: node scripts/prepare-d1-migration.js CURRENT_JSON CONTROL_JSON OUTPUT_SQL');
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
  fs.writeFileSync(outputPath, prepareMigration(current, control), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ prepared: true, jobs: current.snapshot.jobs.length, observedAt: current.snapshot.metadata.observedAt,
    sourceDigest: current.sha256, phase: control.plan.phase, nextPage: control.plan.discovery?.nextPage }));
}
module.exports = { prepareMigration };
