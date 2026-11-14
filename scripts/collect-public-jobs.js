'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { discoverRegions, fetchRegionPage, posting } = require('../refresh/public-source');
async function collect(output) {
  const discovered = await discoverRegions(), startedAt = new Date().toISOString();
  const accepted = new Map(), conflicts = new Set(), failures = [], reports = [];
  const counts = { fetchedRows: 0, duplicates: 0, invalidRecords: 0, excluded: {} };
  let cursor = 0, nextStart = 0;
  async function paced(region, page) {
    const slot = Math.max(Date.now(), nextStart); nextStart = slot + 500;
    if (slot > Date.now()) await new Promise(resolve => setTimeout(resolve, slot - Date.now()));
    return fetchRegionPage(region, page);
  }
  async function worker() {
    while (cursor < discovered.regions.length) {
      const region = discovered.regions[cursor++];
      let page = 1, targetPages = 1;
      const seen = new Set();
      try {
        do {
          const result = await paced(region, page);
          targetPages = Math.max(1, Math.ceil(result.total / 30));
          if (targetPages > 100) throw new Error('PUBLIC_REGION_PAGE_LIMIT');
          const fingerprint = createHash('sha256').update(JSON.stringify(result.rows.map(row => row.JOB_ID).sort())).digest('hex');
          if (result.rows.length && seen.has(fingerprint)) throw new Error('REPEATED_PUBLIC_PAGE');
          seen.add(fingerprint); counts.fetchedRows += result.rows.length;
          for (const record of result.rows) {
            let value;
            try { value = posting(record, result.observedAt); }
            catch { counts.invalidRecords++; continue; }
            if (!value.eligible) { counts.excluded[value.reason] = (counts.excluded[value.reason] || 0) + 1; continue; }
            const id = value.row.jobId, prior = accepted.get(id);
            if (prior && JSON.stringify(prior.row) !== JSON.stringify(value.row)) { conflicts.add(id); continue; }
            if (prior) counts.duplicates++;
            else accepted.set(id, value);
          }
          page++;
        } while (page <= targetPages);
        reports.push({ ...region, pages: page - 1 });
      } catch (error) { failures.push({ ...region, page, errorCode: error.code || error.message }); }
      if ((reports.length + failures.length) % 20 === 0) console.log(JSON.stringify({ completedRegions: reports.length,
        failedRegions: failures.length, totalRegions: discovered.regions.length, accepted: accepted.size, fetchedRows: counts.fetchedRows }));
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  for (const id of conflicts) accepted.delete(id);
  const result = { source: 'https://www.seniorro.or.kr/noin/main.do', startedAt, completedAt: new Date().toISOString(),
    counts: { ...counts, accepted: accepted.size, conflictingIds: conflicts.size, discoveredRegions: discovered.regions.length,
      excludedLookupEntries: discovered.excluded, completedRegions: reports.length, failedRegions: failures.length },
    regions: reports, failures, postings: [...accepted.values()] };
  if (!accepted.size) throw new Error('NO_VERIFIABLE_ACTIVE_POSTINGS');
  fs.writeFileSync(output, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ output, ...result.counts, failures }));
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/collect-public-jobs.js OUTPUT_JSON');
  collect(process.argv[2]).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { collect };
