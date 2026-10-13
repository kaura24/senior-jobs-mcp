'use strict';
const { productionStore } = require('../lib/blob-store');
async function verify() {
  const missing = ['DATA_GO_KR_SERVICE_KEY', 'CRON_SECRET', 'BLOB_STORE_ID'].filter(name => !process.env[name]);
  if (missing.length) return { success: false, proofKind: 'server_configuration', missingVariableNames: missing, discoveryExecuted: false };
  try {
    const store = await productionStore();
    const [snapshot, control] = await Promise.all([store.readCurrent(), store.readControl()]);
    return { success: true, proofKind: 'server_configuration', blobReadVerified: true,
      currentSnapshotPresent: !!snapshot, controlPresent: !!control, sourceRevalidationExecuted: false, discoveryExecuted: false };
  } catch { return { success: false, proofKind: 'server_configuration', blobReadVerified: false,
    errorCode: 'BLOB_ACCESS_NOT_VERIFIED', sourceRevalidationExecuted: false, discoveryExecuted: false }; }
}
if (require.main === module) verify().then(result => { process.stdout.write(JSON.stringify(result) + '\n'); if (!result.success) process.exitCode = 1; });
module.exports = { verify };
