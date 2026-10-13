'use strict';
const { queue, retry } = require('../lib/refresh-queue');
const { executeChunk } = require('../refresh/task');
module.exports = queue.handleNodeCallback(async (message, metadata) => {
  if (typeof message?.dayKst !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(message.dayKst)) return;
  console.log(JSON.stringify({ event: 'refresh_delivery', dayKst: message.dayKst, deliveryCount: metadata.deliveryCount }));
  await executeChunk(message.dayKst);
}, { retry, visibilityTimeoutSeconds: 90 });
