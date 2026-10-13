'use strict';
const crypto = require('node:crypto');
const { QueueClient } = require('@vercel/queue');
const { withinDeadline } = require('./deadline');
const topic = 'senior-jobs-refresh';
const queue = new QueueClient({ region: 'iad1' });
const retryable = code => ['UPSTREAM_TIMEOUT', 'UPSTREAM_NETWORK_ERROR', 'UPSTREAM_HTTP_ERROR',
  'UPSTREAM_RATE_LIMIT', 'STORAGE_UNAVAILABLE', 'QUEUE_DISPATCH_FAILED', 'REFRESH_LEASE_ACTIVE', 'REPEATED_PAGE'].includes(code);
async function enqueue(dayKst, progress) {
  const cursor = progress ? `${progress.sourceCalls}:${progress.phase}:${progress.attemptedIds}` : crypto.randomUUID();
  const key = `${dayKst}:${cursor}`;
  return withinDeadline(() => queue.send(topic, { dayKst }, { idempotencyKey: key, retentionSeconds: 3600 }),
    5000, () => Object.assign(new Error('QUEUE_DISPATCH_FAILED'), { code: 'QUEUE_DISPATCH_FAILED' }));
}
function retry(cause, metadata) {
  const willRetry = retryable(cause.code) && metadata.deliveryCount < 5;
  const directive = willRetry ? { afterSeconds: 30 * metadata.deliveryCount } : { acknowledge: true };
  console.log(JSON.stringify({ event: 'refresh_delivery_retry', errorCode: retryable(cause.code) ? cause.code : 'PERMANENT_ERROR',
    deliveryCount: metadata.deliveryCount, willRetry, ...directive }));
  return directive;
}
module.exports = { enqueue, retryable, retry, queue, topic };
