const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const git = require("isomorphic-git");
const { createGitHubSync, planChanges, validatePaths } = require("../electron/github-sync");

function setup(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "dm-git-sync-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const remote = path.join(folder, "remote.git");
  function command(args, input) {
    const result = spawnSync("git", args, { input, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout;
  }
  command(["init", "--bare", "--initial-branch=main", remote]);
  command(["--git-dir", remote, "config", "receive.denyNonFastForwards", "true"]);
  let failPush = false;
  const http = { request: async ({ url, method, body }) => {
    assert.match(url, /^https:\/\/github\.com\/test\/notes\.git\//);
    const parsed = new URL(url);
    const advertise = parsed.pathname.endsWith("/info/refs");
    const service = advertise ? parsed.searchParams.get("service") : parsed.pathname.split("/").at(-1);
    assert.ok(["git-upload-pack", "git-receive-pack"].includes(service));
    if (service === "git-receive-pack" && !advertise && failPush) throw new Error("offline TOKEN");
    const buffers = [];
    if (body) for await (const chunk of body) buffers.push(Buffer.from(chunk));
    const output = command([service.slice(4), "--stateless-rpc", ...(advertise ? ["--advertise-refs"] : []), remote], Buffer.concat(buffers));
    const banner = Buffer.from(`# service=${service}\n`);
    const payload = advertise ? Buffer.concat([Buffer.from((banner.length + 4).toString(16).padStart(4, "0")), banner, Buffer.from("0000"), output]) : output;
    return { url, method, statusCode: 200, statusMessage: "OK", headers: { "content-type": `application/x-${service}-${advertise ? "advertisement" : "result"}` }, body: [payload] };
  } };
  function client(name, gitImpl = git) {
    const root = path.join(folder, name, "vault");
    const service = createGitHubSync({ root, directory: path.join(folder, name, "sync"), http, git: gitImpl, getToken: async () => "FAKE_TOKEN" });
    service.configure({ owner: "test", repo: "notes", branch: "main" });
    return { root, service, put: (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); },
      read: (file) => fs.readFileSync(path.join(root, file), "utf8"), remove: (file) => fs.unlinkSync(path.join(root, file)) };
  }
  const run = async (client) => { const p = await client.service.preview(); return client.service.sync({ previewId: p.id }); };
  return { folder, remote, command, client, run, http, failPush: (value) => { failPush = value; } };
}

test("three-way planner detects modifications, deletes and initial same-path conflicts", () => {
  assert.deepEqual(planChanges({ "a.md": "base" }, { "a.md": "local" }, { "a.md": "remote" }).conflicts, ["a.md"]);
  assert.deepEqual(planChanges({ "a.md": "base" }, {}, { "a.md": "remote" }).conflicts, ["a.md"]);
  assert.deepEqual(planChanges({}, { "a.md": "same" }, { "a.md": "same" }).conflicts, []);
  assert.deepEqual(planChanges({ "a.md": "base" }, {}, { "a.md": "base" }).deletions, [{ path: "a.md", side: "remote" }]);
});

test("portable paths reject traversal, case collisions and Windows reserved names", () => {
  for (const files of [["../a.md"], ["x\\a.md"], ["CON.md"], ["Notes/a.md", "notes/b.md"], ["a.md", "a.md/b.md"]]) {
    assert.throws(() => validatePaths(files));
  }
});

test("two local clients upload, download, merge different files and propagate deletion", async (t) => {
  const fixture = setup(t);
  const a = fixture.client("a"), b = fixture.client("b");
  a.put("folder/a.md", "hello"); a.put("image.png", Buffer.from([1, 2, 3])); a.put("config.json", "SECRET"); a.put(".hidden/private.md", "PRIVATE");
  const first = await a.service.preview();
  assert.deepEqual(first.uploads, ["folder/a.md", "image.png"]);
  await a.service.sync({ previewId: first.id });
  await fixture.run(b);
  assert.equal(b.read("folder/a.md"), "hello");
  assert.equal(fs.existsSync(path.join(b.root, "config.json")), false);
  a.put("folder/a.md", "edit A"); b.put("b.md", "edit B");
  await fixture.run(a); await fixture.run(b); await fixture.run(a);
  assert.equal(a.read("b.md"), "edit B"); assert.equal(b.read("folder/a.md"), "edit A");
  a.remove("folder/a.md"); await fixture.run(a); await fixture.run(b);
  assert.equal(fs.existsSync(path.join(b.root, "folder/a.md")), false);
  const p = await b.service.preview();
  assert.deepEqual(p.uploads, []); assert.deepEqual(p.downloads, []); assert.deepEqual(p.deletions, []);
  const status = b.service.status();
  assert.ok(status.lastSync);
  assert.equal(JSON.stringify(status).includes("FAKE_TOKEN"), false);
});

test("same-file conflicts export both copies and never overwrite or push", async (t) => {
  const f = setup(t); const a = f.client("a"), b = f.client("b");
  a.put("note.md", "base"); await f.run(a); await f.run(b);
  a.put("note.md", "from A"); b.put("note.md", "from B"); await f.run(a);
  const p = await b.service.preview();
  assert.deepEqual(p.conflicts, ["note.md"]);
  assert.equal(fs.readFileSync(path.join(p.conflictDirectory, "remote/note.md"), "utf8"), "from A");
  assert.equal(fs.readFileSync(path.join(p.conflictDirectory, "local/note.md"), "utf8"), "from B");
  await assert.rejects(b.service.sync({ previewId: p.id }), /冲突/);
  assert.equal(b.read("note.md"), "from B");
  b.put("saved-B.md", "from B"); b.put("note.md", "from A"); await f.run(b);
  await f.run(a); assert.equal(a.read("saved-B.md"), "from B");
});

test("stale local or remote previews refuse execution and failed push can retry", async (t) => {
  const f = setup(t); const a = f.client("a"), b = f.client("b");
  a.put("note.md", "base"); await f.run(a); await f.run(b);
  a.put("note.md", "draft"); let p = await a.service.preview(); a.put("note.md", "newer");
  await assert.rejects(a.service.sync({ previewId: p.id }), /本地.*变化/);
  p = await a.service.preview(); b.put("other.md", "remote changed"); await f.run(b);
  await assert.rejects(a.service.sync({ previewId: p.id }), /远端已变化/);
  p = await a.service.preview(); f.failPush(true);
  await assert.rejects(a.service.sync({ previewId: p.id }), (error) => { assert.equal(error.message.includes("TOKEN"), false); return true; });
  assert.equal(a.read("note.md"), "newer");
  f.failPush(false); await f.run(a); await f.run(b);
  assert.equal(b.read("note.md"), "newer");
});

test("remote non-note files survive commits and only one binding is allowed", async (t) => {
  const f = setup(t), a = f.client("a");
  const blob = await git.writeBlob({ fs, gitdir: f.remote, blob: Buffer.from("keep json") });
  const tree = await git.writeTree({ fs, gitdir: f.remote, tree: [{ path: "data.json", type: "blob", mode: "100644", oid: blob }] });
  const author = { name: "Test", email: "test@example.invalid", timestamp: 1, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, gitdir: f.remote, commit: { tree, parent: [], author, committer: author, message: "initial\n" } });
  await git.writeRef({ fs, gitdir: f.remote, ref: "refs/heads/main", value: commit });
  a.put("note.md", "new note"); await f.run(a);
  assert.equal(f.command(["--git-dir", f.remote, "show", "main:data.json"]).toString(), "keep json");
  assert.throws(() => a.service.configure({ owner: "test", repo: "another", branch: "main" }), /更换/);
});

test("non-fast-forward push race preserves both devices and retries safely", async (t) => {
  const f = setup(t); const b = f.client("b");
  let race = false;
  const a = f.client("a", { ...git, push: async (options) => {
    if (race) { race = false; b.put("raced.md", "other device"); await f.run(b); }
    return git.push(options);
  } });
  a.put("note.md", "base"); await f.run(a); await f.run(b);
  a.put("note.md", "local newer"); const p = await a.service.preview(); race = true;
  await assert.rejects(a.service.sync({ previewId: p.id }), /上传未确认/);
  assert.equal(a.read("note.md"), "local newer");
  assert.equal(f.command(["--git-dir", f.remote, "show", "main:raced.md"]).toString(), "other device");
  await f.run(a); await f.run(b);
  assert.equal(b.read("note.md"), "local newer");
});

test("push succeeded but external local edit prevents apply; recovery never overwrites new edits", async (t) => {
  const f = setup(t); const b = f.client("b");
  let interrupt = false;
  let a;
  a = f.client("a", { ...git, push: async (options) => {
    const result = await git.push(options);
    if (interrupt) { interrupt = false; a.put("local.md", "edited while pushing"); }
    return result;
  } });
  a.put("note.md", "base"); await f.run(a); await f.run(b);
  b.put("download.md", "remote content"); await f.run(b);
  a.put("local.md", "to upload"); let p = await a.service.preview(); interrupt = true;
  await assert.rejects(a.service.sync({ previewId: p.id }), /本地.*变化/);
  assert.equal(a.service.status().pending, true);
  assert.equal(a.read("local.md"), "edited while pushing");
  assert.equal(fs.existsSync(path.join(a.root, "download.md")), false);
  p = await a.service.preview(); assert.deepEqual(p.conflicts, ["local.md"]);
  a.put("preserved.md", a.read("local.md")); a.put("local.md", "to upload");
  await f.run(a); assert.equal(a.read("download.md"), "remote content");
  assert.equal(a.read("preserved.md"), "edited while pushing");
});

test("partial local apply failure resumes from its journal after restart", async (t) => {
  const f = setup(t); const a = f.client("a"); let b = f.client("b");
  a.put("one.md", "base one"); a.put("two.md", "base two"); await f.run(a); await f.run(b);
  a.put("one.md", "new one"); a.put("two.md", "new two"); await f.run(a);
  const preview = await b.service.preview();
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === path.join(fs.realpathSync(b.root), "two.md")) throw Object.assign(new Error("disk unavailable"), { code: "EACCES" });
    return rename(source, target);
  };
  try { await assert.rejects(b.service.sync({ previewId: preview.id }), /本地写入未完成/); }
  finally { fs.renameSync = rename; }
  assert.equal(b.read("one.md"), "new one"); assert.equal(b.read("two.md"), "base two");
  b = f.client("b"); const resumed = await b.service.preview();
  assert.deepEqual(resumed.conflicts, []); assert.deepEqual(resumed.downloads, ["two.md"]);
  await b.service.sync({ previewId: resumed.id }); assert.equal(b.read("two.md"), "new two");
  assert.equal(b.service.status().pending, false);
});

test("remote case-only rename is rejected before applying aliases on case-insensitive filesystems", async (t) => {
  const f = setup(t); const a = f.client("a"), b = f.client("b");
  a.put("Note.md", "base"); await f.run(a); await f.run(b);
  a.remove("Note.md"); a.put("note.md", "base");
  // Commit the case-only rename externally; clients refuse to materialize both spellings.
  const oid = await git.writeBlob({ fs, gitdir: f.remote, blob: Buffer.from("base") });
  const tree = await git.writeTree({ fs, gitdir: f.remote, tree: [{ path: "note.md", oid, type: "blob", mode: "100644" }] });
  const parent = await git.resolveRef({ fs, gitdir: f.remote, ref: "refs/heads/main" });
  const author = { name: "Test", email: "test@example.invalid", timestamp: 2, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, gitdir: f.remote, commit: { tree, parent: [parent], author, committer: author, message: "rename\n" } });
  await git.writeRef({ fs, gitdir: f.remote, ref: "refs/heads/main", value: commit, force: true });
  await assert.rejects(b.service.preview(), /大小写冲突/);
  assert.equal(b.read("Note.md"), "base");
});

test("binding and baseline survive restart without treating missing local files as remote deletions", async (t) => {
  const f = setup(t); let a = f.client("a"); const b = f.client("b");
  a.put("note.md", "base"); await f.run(a); await f.run(b);
  a = f.client("a"); b.put("remote.md", "new remote"); await f.run(b);
  const p = await a.service.preview(); assert.deepEqual(p.downloads, ["remote.md"]);
  await a.service.sync({ previewId: p.id }); assert.equal(a.read("remote.md"), "new remote");
});

test("oversized files and symlink paths stop before upload", async (t) => {
  const f = setup(t), a = f.client("a");
  a.put("large.png", Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(a.service.preview(), /10 MiB/);
  a.remove("large.png");
  if (process.platform !== "win32") {
    fs.symlinkSync(f.remote, path.join(a.root, "link"));
    await assert.rejects(a.service.preview(), /符号链接/);
  }
});
