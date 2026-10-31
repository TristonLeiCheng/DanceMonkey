const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { copySourceToFile } = require('../electron/app-update');

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-download-test-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, destination: path.join(root, 'package.zip'), url: `http://127.0.0.1:${server.address().port}/package`,
    options: { fetch: globalThis.fetch, retryDelayMs: 0 } };
}

test('download streams progress before completion and retries a broken response without appending partial bytes', async t => {
  const bytes = Buffer.alloc(128 * 1024, 42), messages = [];
  let requests = 0, sawLiveProgress = false;
  const f = await fixture(t, (req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.write(bytes.subarray(0, 4096));
    if (requests === 1) setTimeout(() => res.destroy(), 30);
    else setTimeout(() => { sawLiveProgress = messages.some(message => /正在下载.*%/.test(message)); res.end(bytes.subarray(4096)); }, 40);
  });
  await copySourceToFile(f.url, f.destination, message => messages.push(message), f.options);
  assert.equal(requests, 2);
  assert.equal(sawLiveProgress, true);
  assert.ok(messages.some(message => message.includes('重试')));
  assert.deepEqual(fs.readFileSync(f.destination), bytes);
  assert.deepEqual(fs.readdirSync(f.root), ['package.zip']);
});

test('stalled download aborts, cleans partial files and leaves an existing package untouched', async t => {
  let requests = 0;
  const f = await fixture(t, (req, res) => { requests++; res.writeHead(200, { 'Content-Length': 100 }); res.write('partial'); });
  fs.writeFileSync(f.destination, 'existing');
  await assert.rejects(copySourceToFile(f.url, f.destination, null,
    { ...f.options, idleTimeoutMs: 40, maxAttempts: 2 }), error => error.updateStage === 'download');
  assert.equal(requests, 2);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'existing');
  assert.deepEqual(fs.readdirSync(f.root), ['package.zip']);
});

test('retry transient HTTP errors, but do not retry missing assets or install an empty response', async t => {
  for (const status of [503, 404, 200]) {
    let requests = 0;
    const f = await fixture(t, (req, res) => { requests++; res.writeHead(status); res.end(); });
    await assert.rejects(copySourceToFile(f.url, f.destination, null, { ...f.options, maxAttempts: 2 }));
    assert.equal(requests, status === 404 ? 1 : 2);
    assert.deepEqual(fs.readdirSync(f.root), []);
  }
});
