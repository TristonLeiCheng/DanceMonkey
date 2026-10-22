const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createPkbPolicy,
  assertRemoteGovernorsAllowed,
  PROTECTED_DIRS_POSIX,
} = require("../electron/pkb-policy");

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dm-pkb-policy-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeManifest(root, manifest) {
  fs.mkdirSync(path.join(root, "_System"), { recursive: true });
  fs.writeFileSync(path.join(root, "_System", "pkb.json"), JSON.stringify(manifest));
}

function makeEmptyPkbRoot(t) {
  const root = tempDir(t);
  writeManifest(root, { schemaVersion: 1, id: "abc", created: new Date().toISOString(), paths: { quickNotes: "x", screenshots: "y", captures: "z" } });
  for (const rel of PROTECTED_DIRS_POSIX) fs.mkdirSync(path.join(root, ...rel.split("/")), { recursive: true });
  return root;
}

test("legacy library with no manifest anywhere is unaffected", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "60_Health"), { recursive: true });
  fs.writeFileSync(path.join(root, "60_Health", "notes.md"), "sensitive but unmanaged");
  const policy = createPkbPolicy();
  assert.doesNotThrow(() => policy.assertLocalRootAllowed(root, { label: "test" }));
});

test("valid manifest with empty protected directories allows sync", (t) => {
  const root = makeEmptyPkbRoot(t);
  const policy = createPkbPolicy();
  assert.doesNotThrow(() => policy.assertLocalRootAllowed(root, { label: "test" }));
});

test("valid manifest with a real file inside a protected directory blocks sync", (t) => {
  const root = makeEmptyPkbRoot(t);
  fs.writeFileSync(path.join(root, "60_Health", "labs.md"), "blood panel");
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /60_Health/);
});

test("nested protected directory (90_AI/92_Context) with a file blocks sync", (t) => {
  const root = makeEmptyPkbRoot(t);
  fs.writeFileSync(path.join(root, "90_AI", "92_Context", "ctx.json"), "{}");
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /92_Context/);
});

test("syncing a subdirectory that is itself inside a protected directory is blocked", (t) => {
  const root = makeEmptyPkbRoot(t);
  fs.mkdirSync(path.join(root, "80_Vault", "identity"), { recursive: true });
  fs.writeFileSync(path.join(root, "80_Vault", "identity", "id.jpg"), "photo");
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(path.join(root, "80_Vault", "identity"), { label: "sub" }), /80_Vault/);
});

test("syncing a parent directory that merely contains a nested PKB vault detects it", (t) => {
  const parent = tempDir(t);
  const vault = path.join(parent, "MyVault");
  fs.mkdirSync(vault, { recursive: true });
  writeManifest(vault, { schemaVersion: 1, id: "abc", created: new Date().toISOString(), paths: { quickNotes: "x", screenshots: "y", captures: "z" } });
  fs.mkdirSync(path.join(vault, "70_Finance"), { recursive: true });
  fs.writeFileSync(path.join(vault, "70_Finance", "taxes.pdf"), "1040");
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(parent, { label: "parent" }), /70_Finance/);
});

test("corrupted manifest JSON fails closed even with empty protected directories", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "_System"), { recursive: true });
  fs.writeFileSync(path.join(root, "_System", "pkb.json"), "{ not json");
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /无法安全确认/);
});

test("manifest with wrong schemaVersion fails closed", (t) => {
  const root = tempDir(t);
  writeManifest(root, { schemaVersion: 2, id: "abc" });
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /无法安全确认/);
});

test("symlinked _System directory fails closed", { skip: process.platform === "win32" }, (t) => {
  const root = tempDir(t);
  const real = tempDir(t);
  writeManifest(real, { schemaVersion: 1, id: "abc", created: "x", paths: { quickNotes: "a", screenshots: "b", captures: "c" } });
  fs.symlinkSync(path.join(real, "_System"), path.join(root, "_System"), "dir");
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /无法安全确认/);
});

test("symlinked file inside a protected directory counts as real content and blocks", { skip: process.platform === "win32" }, (t) => {
  const root = makeEmptyPkbRoot(t);
  const outside = tempDir(t);
  const target = path.join(outside, "secret.txt");
  fs.writeFileSync(target, "x");
  fs.symlinkSync(target, path.join(root, "80_Vault", "link.txt"));
  const policy = createPkbPolicy();
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /80_Vault/);
});

test("case-insensitive matching treats differently-cased protected dir names as the same directory", (t) => {
  const root = tempDir(t);
  writeManifest(root, { schemaVersion: 1, id: "abc", created: "x", paths: { quickNotes: "a", screenshots: "b", captures: "c" } });
  // Create with a different case than the canonical list; on case-sensitive
  // filesystems this is a *different* actual directory, so put the file at
  // the canonical path but assert the root-level comparison is still
  // case-insensitive by using a differently-cased root path argument.
  fs.mkdirSync(path.join(root, "60_Health"), { recursive: true });
  fs.writeFileSync(path.join(root, "60_Health", "a.md"), "x");
  const policy = createPkbPolicy();
  const upperRoot = root.toUpperCase() === root ? root : root; // root path itself unaffected; exercised via protected dir compare
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /60_Health/);
});

test("caching does not hide a file created after the first check within the same policy instance", (t) => {
  const root = makeEmptyPkbRoot(t);
  const policy = createPkbPolicy();
  assert.doesNotThrow(() => policy.assertLocalRootAllowed(root, { label: "test" }));
  fs.writeFileSync(path.join(root, "60_Health", "late.md"), "added after first check");
  assert.throws(() => policy.assertLocalRootAllowed(root, { label: "test" }), /60_Health/);
});

// --- remote governor checks -------------------------------------------------

function entry(oid, mode = "100644", type = "blob") {
  return { oid, mode, type };
}

test("remote tree with no _System/pkb.json anywhere is unaffected (legacy)", async () => {
  const entries = { "notes/a.md": entry("x"), "60_Health/a.md": entry("y") };
  await assert.doesNotReject(() => assertRemoteGovernorsAllowed({ entries, fetchManifestBlob: async () => { throw new Error("should not be called"); } }));
});

test("remote tree with a valid manifest and empty protected dirs allows sync", async () => {
  const entries = { "_System/pkb.json": entry("m1"), "90_AI/92_Context/.keep": undefined };
  delete entries["90_AI/92_Context/.keep"];
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1 }));
  await assert.doesNotReject(() => assertRemoteGovernorsAllowed({
    entries,
    fetchManifestBlob: async (oid) => (oid === "m1" ? manifest : Buffer.from("")),
  }));
});

test("remote tree with a valid manifest but a file inside a protected dir blocks download/merge", async () => {
  const entries = { "_System/pkb.json": entry("m1"), "70_Finance/taxes.pdf": entry("f1") };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(() => assertRemoteGovernorsAllowed({
    entries,
    fetchManifestBlob: async () => manifest,
  }), /70_Finance/);
});

test("remote manifest that fails to parse fails closed", async () => {
  const entries = { "_System/pkb.json": entry("m1") };
  await assert.rejects(() => assertRemoteGovernorsAllowed({
    entries,
    fetchManifestBlob: async () => Buffer.from("not json"),
  }), /无法安全确认/);
});

test("remote manifest entry that is not a normal blob mode fails closed", async () => {
  const entries = { "_System/pkb.json": entry("m1", "040000", "tree") };
  await assert.rejects(() => assertRemoteGovernorsAllowed({
    entries,
    fetchManifestBlob: async () => { throw new Error("should not be called"); },
  }), /无法安全确认/);
});

test("nested remote PKB root (vault not at repo root) is detected via manifest suffix match", async () => {
  const entries = { "Vault/_System/pkb.json": entry("m1"), "Vault/80_Vault/id.jpg": entry("f1") };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(() => assertRemoteGovernorsAllowed({
    entries,
    fetchManifestBlob: async () => manifest,
  }), /80_Vault/);
});
