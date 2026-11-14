'use strict';
const { getVercelOidcToken } = require('@vercel/functions/oidc');
const { operations } = require('./d1-queries');
const { StoreFailure } = require('./snapshot-store');
const { withinDeadline } = require('./deadline');
function validWorkerUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^senior-jobs-mcp-storage\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
      && url.origin === value;
  } catch { return false; }
}
async function query(sql, parameters) {
  const operation = Object.keys(operations).find(name => operations[name] === sql);
  if (!operation || !validWorkerUrl(process.env.D1_WORKER_URL)) throw new StoreFailure('SERVER_CONFIGURATION_REQUIRED');
  return withinDeadline(async signal => {
    const token = await getVercelOidcToken();
    const response = await fetch(process.env.D1_WORKER_URL + '/storage', { method: 'POST', signal, redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, parameters }) });
    if (!response.ok) {
      console.log(JSON.stringify({ event: 'd1_bridge_failed', operation, httpStatus: response.status }));
      throw new StoreFailure('STORAGE_UNAVAILABLE');
    }
    const result = await response.json();
    if (!Array.isArray(result.rows)) throw new StoreFailure('STORAGE_UNAVAILABLE');
    return result.rows;
  }, 8000, () => new StoreFailure('STORAGE_UNAVAILABLE'));
}
module.exports = { query, validWorkerUrl };
