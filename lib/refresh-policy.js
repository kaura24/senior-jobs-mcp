'use strict';
function isRefreshPaused() { return true; }
function pausedResult() {
  return { state: 'paused_by_request', schedulerEnabled: false, continue: false,
    sourceRevalidationExecuted: false, discoveryExecuted: false };
}
module.exports = { isRefreshPaused, pausedResult };
