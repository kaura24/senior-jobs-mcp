'use strict';
const { createD1Store } = require('./d1-store');
const { StoreFailure } = require('./snapshot-store');
const accountId = '0ae5b2a5dc0d07651d66b5e4db2b0d0c';
const databaseId = '8df2c092-4e5a-4eb6-a3a2-2e5dd97d5125';
function configured(env = process.env) {
  return env.CLOUDFLARE_ACCOUNT_ID === accountId && env.D1_DATABASE_ID === databaseId
    && (env.D1_WORKER_URL ? require('./d1-worker-client').validWorkerUrl(env.D1_WORKER_URL) : !!env.CLOUDFLARE_D1_API_TOKEN);
}
async function productionStore() {
  if (process.env.D1_WRANGLER_READS === '1' && !process.env.VERCEL) return createD1Store(require('./d1-wrangler').query);
  if (!configured()) throw new StoreFailure('SERVER_CONFIGURATION_REQUIRED');
  if (process.env.D1_WORKER_URL) return createD1Store(require('./d1-worker-client').query);
  return createD1Store(require('./d1-client').query);
}
async function loadDataset(store) {
  const [current, control] = await Promise.all([store.readCurrent(), store.readControl()]);
  if (!current) throw new StoreFailure('D1_DATA_NOT_COLLECTED');
  const refreshState = { ...current.value.refreshState, storageState: 'd1', snapshotReadState: 'available',
    checkpointReadState: control ? 'available' : 'absent', progressEvidence: 'published_snapshot' };
  if (control?.value.lastAttemptAt >= (refreshState.lastAttemptAt || '') && control.value.state !== 'running') {
    Object.assign(refreshState, { state: control.value.state, errorCode: control.value.errorCode,
      lastAttemptAt: control.value.lastAttemptAt, schedulerEnabled: control.value.schedulerEnabled });
  }
  return { snapshot: current.value.snapshot, refreshState };
}
module.exports = { productionStore, loadDataset, configured, accountId, databaseId };
