'use strict';
const { withinDeadline } = require('./deadline');
const { StoreFailure } = require('./snapshot-store');

async function query(sql, params) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, database = process.env.D1_DATABASE_ID,
    token = process.env.CLOUDFLARE_D1_API_TOKEN;
  if (!/^[a-f0-9]{32}$/.test(account || '') || !/^[a-f0-9-]{36}$/.test(database || '') || !token) {
    throw new StoreFailure('SERVER_CONFIGURATION_REQUIRED');
  }
  const result = await withinDeadline(async signal => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal, redirect: 'error', cache: 'no-store' });
    if (!response.ok) {
      console.log(JSON.stringify({ event: 'd1_query_failed', httpStatus: response.status }));
      throw new StoreFailure('STORAGE_UNAVAILABLE');
    }
    return response.json();
  }, 8000, () => new StoreFailure('STORAGE_UNAVAILABLE'));
  if (result.success !== true || !Array.isArray(result.result) || result.result.length !== 1
    || result.result[0].success !== true || !Array.isArray(result.result[0].results)) {
    throw new StoreFailure('STORAGE_UNAVAILABLE');
  }
  return result.result[0].results;
}
module.exports = { query };
