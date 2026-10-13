'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const bundled = { snapshot: require('../data/jobs.json'), refreshState: require('../data/refresh-state.json') };
function datasetContext() { return scope.getStore() || bundled; }
function withDataset(dataset, callback) { return scope.run(dataset, callback); }
module.exports = { datasetContext, withDataset, bundled };
