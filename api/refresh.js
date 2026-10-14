'use strict';
const crypto = require('node:crypto');
const { productionStore } = require('../lib/blob-store');
const { enqueue } = require('../lib/refresh-queue');
const { kstDay } = require('../lib/jobs');
const { isRefreshPaused, pausedResult } = require('../lib/refresh-policy');
function authorized(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const expected = Buffer.from('Bearer ' + secret), actual = Buffer.from(header);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (!['GET', 'POST'].includes(req.method)) return send(405, { errorCode: 'METHOD_NOT_ALLOWED' });
  if (!authorized(req.headers.authorization, process.env.CRON_SECRET)) return send(401, { errorCode: 'UNAUTHORIZED' });
  if (isRefreshPaused()) return send(200, pausedResult());
  if (!process.env.BLOB_STORE_ID || !process.env.DATA_GO_KR_SERVICE_KEY) return send(503, { errorCode: 'SERVER_CONFIGURATION_REQUIRED' });
  const day = kstDay(new Date());
  if (req.method === 'POST' && req.headers['x-refresh-run-day'] !== day) return send(409, { errorCode: 'STALE_CONTINUATION' });
  const started = Date.now();
  try {
    await enqueue(day);
    console.log(JSON.stringify({ event: 'refresh_dispatch', delivery: 'private_queue', state: 'queued', elapsedMs: Date.now() - started }));
    return send(202, { state: 'queued', dayKst: day, completionVerified: false });
  } catch {
    const code = 'QUEUE_DISPATCH_FAILED';
    console.log(JSON.stringify({ event: 'refresh_dispatch_failed', errorCode: code, elapsedMs: Date.now() - started }));
    try {
      const store = await productionStore(), state = await store.readControl();
      if (!(Date.parse(state?.value.leaseUntil || '') > Date.now())) {
        await store.writeControl({ ...state?.value, lastAttemptAt: new Date().toISOString(), leaseUntil: null,
          schedulerEnabled: true, state: 'paused_incomplete', errorCode: code }, state?.etag);
      }
    } catch { console.log(JSON.stringify({ event: 'refresh_error_checkpoint', checkpointSaved: false, errorCode: code })); }
    return send(503, { errorCode: code, completionVerified: false });
  }
};
module.exports.authorized = authorized;
