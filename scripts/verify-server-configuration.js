'use strict';
const { productionStore, configured } = require('../lib/runtime-store');
async function verify() {
  const missing = ['CRON_SECRET', 'D1_DATABASE_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_API_TOKEN'].filter(name => !process.env[name]);
  if (missing.length) return { success: false, proofKind: 'server_configuration', missingVariableNames: missing, discoveryExecuted: false };
  if (!configured()) return { success: false, errorCode: 'PROJECT_D1_CONFIGURATION_MISMATCH' };
  try {
    const store = await productionStore();
    const [snapshot, control] = await Promise.all([store.readCurrent(), store.readControl()]);
    if (!snapshot) return { success: false, errorCode: 'D1_DATA_NOT_COLLECTED' };
    return { success: true, proofKind: 'server_configuration', d1ReadVerified: true,
      currentSnapshotPresent: !!snapshot, controlPresent: !!control, sourceRevalidationExecuted: false, discoveryExecuted: false };
  } catch { return { success: false, proofKind: 'server_configuration', d1ReadVerified: false,
    errorCode: 'D1_ACCESS_NOT_VERIFIED', sourceRevalidationExecuted: false, discoveryExecuted: false }; }
}
if (require.main === module) verify().then(result => { process.stdout.write(JSON.stringify(result) + '\n'); if (!result.success) process.exitCode = 1; });
module.exports = { verify };

