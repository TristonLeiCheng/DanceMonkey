const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPkb } = require("../electron/pkb");
const { createFolderSyncService, defaultProfile } = require("../electron/folder-sync");
const { assertRemoteGovernorsAllowed } = require("../electron/pkb-policy");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dm-pkb-sync-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  return { root, a, b };
}

test("local PKB protects against remote files even without a remote manifest", async () => {
  await assert.rejects(assertRemoteGovernorsAllowed({
    entries: { "60_health/report.md": { type: "blob", mode: "100644", oid: "x" } },
    localPkb: true, fetchManifestBlob: async () => { throw new Error("not needed"); },
  }), /保护目录/);
});

test("folder sync rejects protected files from an uninitialized peer in either direction", async (t) => {
  const { root, a, b } = fixture(t);
  createPkb(a).initialize();
  fs.mkdirSync(path.join(b, "60_Health"));
  fs.writeFileSync(path.join(b, "60_Health/private.pdf"), "fixture");
  const service = createFolderSyncService(path.join(root, "app-data"));
  for (const [masterPath, slavePath] of [[a, b], [b, a]]) {
    const profile = { ...defaultProfile(), masterPath, slavePath };
    await assert.rejects(async () => service.preview(profile), /保护目录/);
  }
  assert.equal(fs.existsSync(path.join(a, "60_Health/private.pdf")), false);
});
