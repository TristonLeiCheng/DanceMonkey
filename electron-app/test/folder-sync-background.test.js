const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackgroundFolderSync } = require('../electron/folder-sync-background');
const { defaultProfile } = require('../electron/folder-sync');

test('folder scan and copy run off the main thread with progress and cancellation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-folder-background-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const masterPath = path.join(root, 'source'), slavePath = path.join(root, 'target');
  fs.mkdirSync(masterPath); fs.mkdirSync(slavePath);
  for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(masterPath, `${i}.md`), 'note '.repeat(100));
  const service = createBackgroundFolderSync(path.join(root, 'appdata'));
  const profile = defaultProfile({ id: 'test', masterPath, slavePath });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const progress = [];
  try {
    await service.preview(profile);
    const result = await service.run(profile, { onProgress: event => progress.push(event) });
    assert.equal(result.errorCount, 0); assert.equal(result.copiedCount, 500);
  } finally { clearInterval(timer); }
  assert.ok(ticks > 5);
  assert.ok(progress.length > 0);
  assert.equal(fs.readFileSync(path.join(slavePath, '1.md'), 'utf8'), 'note '.repeat(100));
  const controller = new AbortController(); controller.abort();
  fs.writeFileSync(path.join(masterPath, 'cancelled.md'), 'should not copy');
  const cancelled = await service.run(profile, { signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
  assert.equal(fs.existsSync(path.join(slavePath, 'cancelled.md')), false);
});
