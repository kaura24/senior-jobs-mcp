'use strict';
async function writeCheckpoint(store, state, etag) {
  try {
    const result = await store.writeControl(state, etag);
    return { ...result, compact: false, bytes: Buffer.byteLength(JSON.stringify(state)) };
  } catch (cause) {
    if (cause.code !== 'SNAPSHOT_TOO_LARGE') throw cause;
    const durable = await store.readCurrent(), committed = durable?.value.runPlan;
    const { plan: omitted, ...summary } = state;
    const attemptDayKst = state.plan?.runDayKst || state.attemptDayKst || state.runDayKst || committed?.runDayKst;
    const attemptSourceCalls = Math.max(state.plan?.runDayKst === attemptDayKst ? state.plan.calls || 0 : 0,
      state.attemptDayKst === attemptDayKst ? state.attemptSourceCalls || 0 : 0,
      committed?.runDayKst === attemptDayKst ? committed.calls || 0 : 0);
    const compact = { ...summary, runDayKst: committed?.runDayKst || state.plan?.runDayKst || state.runDayKst,
      resumeSource: 'current_snapshot', attemptDayKst, attemptSourceCalls,
      dailyProgress: durable?.value.snapshot.metadata.refresh?.dailyRevalidation || null };
    const result = await store.writeControl(compact, etag);
    return { ...result, compact: true, bytes: Buffer.byteLength(JSON.stringify(compact)) };
  }
}
module.exports = { writeCheckpoint };
