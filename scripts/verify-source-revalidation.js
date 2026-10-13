'use strict';
const { createSource } = require('../refresh/source');
const { createDay, advance, progress } = require('../refresh/daily');
const snapshot = require('../data/jobs.json');
async function probe(source, input = snapshot, now = () => new Date(), budgetMs = 45000, onProgress = () => {}) {
  const started = now(), plan = createDay(input, null, started.toISOString());
  const elapsed = [];
  try {
    while (plan.phase === 'revalidation') {
      if (now().getTime() - started.getTime() >= budgetMs) return { success: false, errorCode: 'PROBE_TIME_BUDGET',
        existingIds: progress(plan), elapsedMs: now().getTime() - started.getTime(), sourceDiagnostics: source.diagnostics?.(), discoveryExecuted: false };
      const before = now().getTime();
      await advance(plan, source, now().toISOString(), 1000, now);
      elapsed.push(now().getTime() - before);
      onProgress({ event: 'source_probe_progress', sourceCalls: plan.calls, confirmedIds: progress(plan).confirmedIds,
        targetIds: plan.targetIds.length, elapsedMs: now().getTime() - started.getTime(), sourceDiagnostics: source.diagnostics?.() });
    }
    return { success: progress(plan).complete, existingIds: progress(plan), discoveryExecuted: false,
      elapsedMs: now().getTime() - started.getTime(), operationsMeasured: elapsed.length,
      maximumOperationMs: Math.max(0, ...elapsed), averageOperationMs: elapsed.length ? elapsed.reduce((sum, n) => sum + n, 0) / elapsed.length : 0 };
  } catch (cause) {
    plan.errorCode = require('../refresh/runner').errorCode(cause);
    return { success: false, existingIds: progress(plan), errorCode: plan.errorCode, discoveryExecuted: false };
  }
}
if (require.main === module) {
  if (!process.env.DATA_GO_KR_SERVICE_KEY) { process.stdout.write(JSON.stringify({ success: false, errorCode: 'SOURCE_KEY_NOT_CONFIGURED' }) + '\n'); process.exitCode = 1; }
  else probe(createSource(process.env.DATA_GO_KR_SERVICE_KEY), snapshot, () => new Date(), 45000,
    result => process.stdout.write(JSON.stringify(result) + '\n')).then(result => { process.stdout.write(JSON.stringify(result) + '\n'); if (!result.success) process.exitCode = 1; });
}
module.exports = { probe };
