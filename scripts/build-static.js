'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
async function buildStatic(root = path.resolve(__dirname, '..')) {
  const output = path.join(root, 'public');
  await fs.mkdir(output, { recursive: true });
  await fs.copyFile(path.join(root, 'index.html'), path.join(output, 'index.html'));
}
if (require.main === module) buildStatic().catch(() => { process.stderr.write('STATIC_OUTPUT_FAILED\n'); process.exitCode = 1; });
module.exports = { buildStatic };
