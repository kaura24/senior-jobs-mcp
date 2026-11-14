'use strict';
const { discoverRegions, fetchRegionPage, posting } = require('../refresh/public-source');
async function verify() {
  const discovered = await discoverRegions();
  if (!discovered.regions.length) throw new Error('INVALID_PUBLIC_REGIONS');
  const page = await fetchRegionPage(discovered.regions[0], 1);
  for (const record of page.rows) posting(record, page.observedAt);
  return { proofKind: 'official_public_source_preflight', regionCount: discovered.regions.length,
    firstRegionRows: page.rows.length, observedAt: page.observedAt, fullCoverageVerified: false };
}
if (require.main === module) verify().then(result => console.log(JSON.stringify(result))).catch(cause => {
  console.error(cause.code || 'SOURCE_PREFLIGHT_FAILED'); process.exitCode = 1;
});
module.exports = { verify };
