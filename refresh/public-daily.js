'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { preparePublicImport } = require('../lib/public-import');
const { digest, StoreFailure } = require('../lib/snapshot-store');
const { kstDay } = require('../lib/jobs');
const publicSource = require('./public-source');

// Each delivery commits one official page and its cursor in the same D1 snapshot.
async function runPublicChunk({ store, source = publicSource, now = () => new Date(), schedulerEnabled = true }) {
  const at = now().toISOString(), day = kstDay(now());
  const [control, current] = await Promise.all([store.readControl(), store.readCurrent()]);
  if (Date.parse(control?.value.leaseUntil || '') > now().getTime()) return { state: 'already_running', continue: false };
  const saved = current?.value.runPlan;
  if (saved?.kind === 'official_public' && saved.runDayKst === day && saved.phase === 'done') {
    await store.recordIngestion(saved, current.value.snapshot.metadata.observedAt);
    return { state: 'already_completed', continue: false, counts: saved.counts };
  }
  const lease = { state: 'running', leaseId: randomUUID(), leaseUntil: new Date(now().getTime() + 90000).toISOString(),
    runDayKst: day, lastAttemptAt: at, schedulerEnabled, errorCode: null };
  const claim = await store.writeControl(lease, control?.etag);
  try {
    let plan;
    if (saved?.kind === 'official_public' && saved.runDayKst === day) plan = structuredClone(saved);
    else {
      const discovered = await source.discoverRegions();
      if (!discovered.regions.length) throw new StoreFailure('INVALID_PUBLIC_REGIONS');
      plan = { kind: 'official_public', runId: randomUUID(), runDayKst: day, startedAt: at, phase: 'collection',
        regions: discovered.regions, regionIndex: 0, nextPage: 1, pageSignatures: [], regionTotal: null, calls: 0,
        verifiedIds: [], counts: { new: 0, updated: 0, unchanged: 0, failed: 0, fetchedRows: 0, duplicates: 0, excluded: 0 } };
      const initial = preparePublicImport({ source: 'https://www.seniorro.or.kr/noin/main.do', startedAt: at,
        completedAt: now().toISOString(), postings: [], counts: {}, failures: [], regions: [] }, current).envelope;
      initial.runPlan = plan;
      initial.refreshState = { state: 'in_progress_partial', schedulerEnabled, lastAttemptAt: at, errorCode: null };
      await store.writeCurrent(initial, current?.etag);
      await store.writeControl({ ...lease, state: 'in_progress_partial', leaseUntil: null }, claim.etag);
      return { state: 'in_progress_partial', continue: true,
        progress: { sourceCalls: 0, phase: 'collection', attemptedIds: 0, totalRegions: plan.regions.length, completedRegions: 0 } };
    }
    const region = plan.regions[plan.regionIndex], page = await source.fetchRegionPage(region, plan.nextPage);
    const pages = Math.max(1, Math.ceil(page.total / 30));
    if (pages > 100 || plan.nextPage > pages || (plan.regionTotal !== null && plan.regionTotal !== page.total)
      || page.rows.length !== Math.min(30, Math.max(0, page.total - (plan.nextPage - 1) * 30))) {
      throw new StoreFailure('INVALID_PUBLIC_PAGE');
    }
    const signature = createHash('sha256').update(JSON.stringify(page.rows.map(row => [row.PROJ_TYPE, row.JOB_ID, row.INSTN_ID]).sort())).digest('hex');
    if (page.rows.length && plan.pageSignatures.includes(signature)) throw new StoreFailure('REPEATED_PUBLIC_PAGE');
    const accepted = new Map(), excludedEvidence = [], verified = new Set(plan.verifiedIds);
    for (const record of page.rows) {
      let posting;
      try { posting = source.posting(record, page.observedAt); }
      catch (cause) {
        if (!(cause instanceof publicSource.PublicSourceError)) throw cause;
        plan.counts.failed++; continue;
      }
      if (!posting.eligible) {
        plan.counts.excluded++; verified.delete(posting.row.jobId); accepted.delete(posting.row.jobId);
        excludedEvidence.push({ jobId: posting.row.jobId,
          hash: createHash('sha256').update(JSON.stringify(record)).digest('hex'), url: posting.source.url,
          at: page.observedAt, raw: record });
        continue;
      }
      const prior = accepted.get(posting.row.jobId);
      if (prior && JSON.stringify(prior.row) !== JSON.stringify(posting.row)) throw new StoreFailure('PUBLIC_ID_CONFLICT');
      if (verified.has(posting.row.jobId)) plan.counts.duplicates++;
      verified.add(posting.row.jobId); accepted.set(posting.row.jobId, posting);
    }
    const collection = { source: 'https://www.seniorro.or.kr/noin/main.do', startedAt: plan.startedAt,
      completedAt: now().toISOString(), postings: [...accepted.values()], failures: [], regions: [region], counts: { failedRegions: 0 } };
    const prepared = preparePublicImport(collection, current);
    if (prepared.counts.failed) throw new StoreFailure('PUBLIC_IMPORT_HAS_INVALID_RECORDS');
    for (const name of ['new', 'updated', 'unchanged']) plan.counts[name] += prepared.counts[name];
    plan.calls++; plan.counts.fetchedRows += page.rows.length;
    plan.verifiedIds = [...verified]; plan.pageSignatures.push(signature); plan.regionTotal = page.total;
    if (plan.nextPage === pages) {
      plan.regionIndex++; plan.nextPage = 1; plan.pageSignatures = []; plan.regionTotal = null;
    } else plan.nextPage++;
    if (plan.regionIndex === plan.regions.length) plan.phase = 'done';
    const state = plan.phase !== 'done' ? 'in_progress_partial' : plan.counts.failed ? 'paused_incomplete' : 'public_collection_completed';
    const envelope = prepared.envelope, metadata = envelope.snapshot.metadata;
    metadata.collection = { source: collection.source, completedRegions: plan.regionIndex, totalRegions: plan.regions.length,
      counts: plan.counts, sourceCalls: plan.calls };
    metadata.refresh = { scanScope: 'official_public_region_search', latestStatusRevalidatedIds: plan.verifiedIds,
      queryableIds: plan.verifiedIds, retainedNotRevalidated: envelope.snapshot.jobs.length - verified.size };
    envelope.refreshState = { state, schedulerEnabled, lastAttemptAt: at, lastPublishedAt: collection.completedAt,
      lastSuccessfulAt: state === 'public_collection_completed' ? collection.completedAt : null,
      errorCode: plan.counts.failed ? 'PUBLIC_INVALID_RECORDS' : null };
    envelope.runPlan = plan; envelope.sha256 = digest(envelope.snapshot);
    // Evidence is durable before a changed posting becomes visible; failed CAS leaves only audit history.
    await store.archiveObservations([...prepared.observations, ...excludedEvidence]);
    await store.writeCurrent(envelope, current?.etag);
    if (plan.phase === 'done') await store.recordIngestion(plan, collection.completedAt);
    await store.writeControl({ ...lease, ...envelope.refreshState, leaseUntil: null }, claim.etag);
    return { state, continue: plan.phase !== 'done', counts: plan.counts,
      progress: { sourceCalls: plan.calls, phase: plan.phase, attemptedIds: verified.size,
        completedRegions: plan.regionIndex, totalRegions: plan.regions.length } };
  } catch (cause) {
    await store.writeControl({ ...lease, state: 'paused_incomplete', leaseUntil: null,
      errorCode: cause.code || 'STORAGE_UNAVAILABLE' }, claim.etag);
    throw cause;
  }
}
module.exports = { runPublicChunk };
