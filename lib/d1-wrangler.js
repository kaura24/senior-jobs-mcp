'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { StoreFailure } = require('./snapshot-store');
const execute = promisify(execFile);

function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new StoreFailure('INVALID_SQL_PARAMETER');
  return "'" + value.replaceAll("'", "''") + "'";
}
async function command(sql) {
  const config = path.resolve(__dirname, '../wrangler.jsonc');
  const { stdout } = await execute('npx', ['--offline', 'wrangler@4.162.0', 'd1', 'execute', 'senior-jobs-mcp',
    '--remote', '--config', config, '--command', sql, '--json'], { timeout: 30000, maxBuffer: 16000000 });
  const results = JSON.parse(stdout);
  if (!Array.isArray(results) || results.some(result => result.success !== true)) throw new StoreFailure('STORAGE_UNAVAILABLE');
  return results;
}
async function query(sql, params) {
  if (!/^SELECT\s/i.test(sql.trim()) || sql.includes(';')) throw new StoreFailure('WRANGLER_READ_ONLY');
  let index = 0;
  const statement = sql.replace(/\?/g, () => literal(params[index++]));
  if (index !== params.length) throw new StoreFailure('INVALID_SQL_PARAMETER');
  const result = await command(statement);
  if (result.length !== 1 || !Array.isArray(result[0].results)) throw new StoreFailure('STORAGE_UNAVAILABLE');
  return result[0].results;
}
module.exports = { command, query, literal };
