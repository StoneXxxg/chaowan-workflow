const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('health and catalog endpoints work without provider keys', async t => {
  const port = 8899;
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', TAVILY_API_KEY: '' } });
  t.after(() => child.kill());
  await new Promise(r => setTimeout(r, 150));
  const health = await fetch(`http://localhost:${port}/api/health`).then(r => r.json());
  assert.deepEqual(health.configured, { ocr: false, search: false });
  const catalog = await fetch(`http://localhost:${port}/api/catalog`).then(r => r.json());
  assert.ok(catalog.items.length > 0);
  const page = await fetch(`http://localhost:${port}/`).then(r => r.text());
  assert.match(page, /潮玩盲盒工作流/);
  const missing = await fetch(`http://localhost:${port}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 400);
  const ocr = await fetch(`http://localhost:${port}/api/ocr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(ocr.status, 503);
});

test('cached research is returned without provider keys', async t => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaowan-test-'));
  const key = crypto.createHash('sha256').update(JSON.stringify(['小野', '测试系列'])).digest('hex');
  await fs.writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify({ savedAt: Date.now(), data: { summary: '已缓存的测试资料', results: [] } }));
  const port = 8900;
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env: { ...process.env, PORT: String(port), CHAOWAN_CACHE_DIR: cacheDir, OPENAI_API_KEY: '', TAVILY_API_KEY: '' } });
  t.after(async () => { child.kill(); await fs.rm(cacheDir, { recursive: true, force: true }); });
  await new Promise(r => setTimeout(r, 150));
  const response = await fetch(`http://localhost:${port}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ip: '小野', series: '测试系列' }) });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.cached, true);
  assert.equal(data.summary, '已缓存的测试资料');
});
