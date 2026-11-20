'use strict';
const { productionStore, configured } = require('../lib/runtime-store');
const { enqueue } = require('../lib/refresh-queue');
const { kstDay } = require('../lib/jobs');
const { isRefreshPaused, pausedResult } = require('../lib/refresh-policy');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (!['GET', 'POST'].includes(req.method)) return send(405, { errorCode: 'METHOD_NOT_ALLOWED' });
  if (isRefreshPaused()) return send(200, pausedResult());
  if (!configured()) return send(503, { errorCode: 'SERVER_CONFIGURATION_REQUIRED' });
  const day = kstDay(new Date());
  if (req.method === 'POST' && req.headers['x-refresh-run-day'] !== day) return send(409, { errorCode: 'STALE_CONTINUATION' });
  const sourceRefresh = req.headers['user-agent'] !== 'vercel-cron/1.0';
  const started = Date.now();
  try {
    await enqueue(day, undefined, sourceRefresh);
    console.log(JSON.stringify({ event: 'refresh_dispatch', delivery: 'private_queue', state: 'queued', sourceRefresh, elapsedMs: Date.now() - started }));
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

