'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const { isRefreshPaused } = require('./refresh-policy');
const bundled = { snapshot: require('../data/jobs.json'), refreshState: require('../data/refresh-state.json') };
function datasetContext() {
  const dataset = scope.getStore() || bundled;
  if (!isRefreshPaused()) return dataset;
  return { ...dataset, refreshState: { ...dataset.refreshState, state: 'paused_by_request', schedulerEnabled: false,
    refreshObservedState: dataset.refreshState.refreshObservedState || dataset.refreshState.state } };
}
function withDataset(dataset, callback) { return scope.run(dataset, callback); }
module.exports = { datasetContext, withDataset, bundled };
