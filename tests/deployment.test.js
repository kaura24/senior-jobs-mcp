'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('the static build produces its declared output without publishing source files', async () => {
  const { buildStatic } = require('../scripts/build-static');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'senior-static-test-'));
  try {
    await fs.writeFile(path.join(root, 'index.html'), '<html>public MCP</html>');
    await fs.writeFile(path.join(root, 'private-source.js'), 'not public');
    await buildStatic(root);
    const output = require('../vercel.json').outputDirectory || 'public';
    assert.deepEqual(await fs.readdir(path.join(root, output)), ['index.html']);
    assert.equal(await fs.readFile(path.join(root, output, 'index.html'), 'utf8'), '<html>public MCP</html>');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
