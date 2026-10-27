const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const git = require("isomorphic-git");
const { createGitHubSync, planChanges, validatePaths } = require("../electron/github-sync");
const { createZenTaskStore } = require("../electron/zentask");

const TASK_FILE = "Journal/task-module.json";
const PROJECT_FILE = "Journal/zentask-projects.json";
const TASK_FILES = [TASK_FILE, PROJECT_FILE];

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

test("tasks and projects sync both ways, including record and file deletion, without uploading other JSON", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  const storeA = createZenTaskStore(a.root), storeB = createZenTaskStore(b.root);
  const project = storeA.addProject({ name: "发布", linkedNotes: ["Notes/release.md"] }).projects[0];
  const task = storeA.addTask({ title: "验收", projectId: project.Id, notes: "保留完整记录" }).tasks[0];
  const excluded = ["config.json", "Journal/private.json", "Journal/task-module.json.bak",
    "task-module.json", "Archive/Journal/task-module.json", "Journal/nested/zentask-projects.json", ".hidden/task-module.json"];
  for (const file of excluded) a.put(file, JSON.stringify({ private: file }));
  let preview = await a.service.preview();
  assert.deepEqual(preview.uploads, TASK_FILES);
  await a.service.sync({ previewId: preview.id });
  assert.deepEqual(f.command(["--git-dir", f.remote, "ls-tree", "-r", "--name-only", "main"]).toString().trim().split("\n"), TASK_FILES);
  preview = await b.service.preview();
  assert.deepEqual(preview.downloads, TASK_FILES);
  await b.service.sync({ previewId: preview.id });
  for (const file of TASK_FILES) assert.equal(b.read(file), a.read(file));
  for (const file of excluded) assert.equal(fs.existsSync(path.join(b.root, file)), false, file);
  assert.equal(storeB.load().tasks[0].Id, task.Id);
  assert.equal(storeB.load().tasks[0].ProjectId, project.Id);
  assert.deepEqual(storeB.load().projects[0].LinkedNotes, ["Notes/release.md"]);

  storeB.updateTask(task.Id, { workflowStatus: "Completed", notes: "另一台电脑完成" });
  storeB.updateProject(project.Id, { goal: "已验收", lifecycleStatus: "In Progress" });
  await f.run(b);
  const downloaded = await f.run(a);
  assert.equal(downloaded.downloaded, 2);
  assert.equal(storeA.load().tasks[0].IsDone, true);
  assert.equal(storeA.load().tasks[0].Notes, "另一台电脑完成");
  assert.equal(storeA.load().projects[0].Goal, "已验收");
  for (const file of TASK_FILES) assert.equal(a.read(file), b.read(file));

  storeA.deleteTask(task.Id);
  storeA.deleteProject(project.Id);
  await f.run(a); await f.run(b);
  assert.deepEqual(storeB.load().tasks, []);
  assert.deepEqual(storeB.load().projects, []);
  for (const file of TASK_FILES) {
    assert.deepEqual(JSON.parse(b.read(file)).Items, []);
    b.remove(file);
  }
  preview = await b.service.preview();
  assert.deepEqual(preview.deletions, TASK_FILES.map((file) => ({ path: file, side: "remote" })));
  await b.service.sync({ previewId: preview.id });
  preview = await a.service.preview();
  assert.deepEqual(preview.deletions, TASK_FILES.map((file) => ({ path: file, side: "local" })));
  const deleted = await a.service.sync({ previewId: preview.id });
  for (const file of TASK_FILES) {
    assert.equal(fs.existsSync(path.join(a.root, file)), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(deleted.backupDirectory, "local", file), "utf8")).Items, []);
  }
  for (const file of excluded) assert.equal(JSON.parse(a.read(file)).private, file);
});

test("different task and project edits conflict as whole files and preserve both devices", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  const storeA = createZenTaskStore(a.root), storeB = createZenTaskStore(b.root);
  const project = storeA.addProject({ name: "共同项目" }).projects[0];
  storeA.addTask({ title: "已有任务", projectId: project.Id });
  await f.run(a); await f.run(b);
  // Separate records and fields still conflict: the sync contract is file-level.
  storeA.addTask({ title: "电脑 A 新增", projectId: project.Id });
  storeB.addTask({ title: "电脑 B 新增", projectId: project.Id });
  storeA.updateProject(project.Id, { goal: "电脑 A 的目标" });
  storeB.updateProject(project.Id, { description: "电脑 B 的说明" });
  await f.run(a);
  const head = f.command(["--git-dir", f.remote, "rev-parse", "main"]).toString();
  const local = Object.fromEntries(TASK_FILES.map((file) => [file, b.read(file)]));
  const preview = await b.service.preview();
  assert.deepEqual(preview.conflicts, TASK_FILES);
  assert.deepEqual(preview.uploads, []);
  assert.deepEqual(preview.downloads, []);
  for (const file of TASK_FILES) {
    assert.equal(fs.readFileSync(path.join(preview.conflictDirectory, "local", file), "utf8"), local[file]);
    assert.equal(fs.readFileSync(path.join(preview.conflictDirectory, "remote", file), "utf8"), a.read(file));
  }
  await assert.rejects(b.service.sync({ previewId: preview.id }), /冲突/);
  for (const file of TASK_FILES) assert.equal(b.read(file), local[file]);
  assert.equal(f.command(["--git-dir", f.remote, "rev-parse", "main"]).toString(), head);
});

test("legacy note-only baselines treat task JSON as new files and never overwrite divergent local data", async (t) => {
  const f = setup(t), a = f.client("a"); let b = f.client("b");
  a.put("note.md", "existing baseline"); await f.run(a); await f.run(b);
  const stateFile = path.join(f.folder, "b", "sync", "state.json");
  const oldState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(Object.keys(oldState.base), ["note.md"]);
  for (const file of TASK_FILES) {
    a.put(file, JSON.stringify({ SchemaVersion: 2, Items: [{ Id: "remote-record" }] }));
    b.put(file, JSON.stringify({ SchemaVersion: 2, Items: [{ Id: "local-record" }] }));
  }
  await f.run(a);
  b = f.client("b");
  let preview = await b.service.preview();
  assert.deepEqual(preview.conflicts, TASK_FILES);
  await assert.rejects(b.service.sync({ previewId: preview.id }), /冲突/);
  for (const file of TASK_FILES) assert.equal(JSON.parse(b.read(file)).Items[0].Id, "local-record");
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).base, oldState.base);

  for (const file of TASK_FILES) b.put(file, a.read(file));
  preview = await b.service.preview();
  assert.deepEqual(preview.counts, { uploads: 0, downloads: 0, deletions: 0, conflicts: 0 });
  await b.service.sync({ previewId: preview.id });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, "utf8")).base).sort(), [...TASK_FILES, "note.md"]);
});

test("legacy task arrays and lowercase project envelopes round-trip with all unknown fields intact", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  const tasks = [{ title: "旧任务", Custom: { nested: [1, "保留", false] } }];
  const projects = { schemaVersion: 1, items: [{ name: "旧项目", Custom: { archived: false } }], ExtraEnvelopeField: "keep" };
  a.put(TASK_FILE, JSON.stringify(tasks, null, 2));
  a.put(PROJECT_FILE, JSON.stringify(projects, null, 2));
  await f.run(a); await f.run(b);
  for (const file of TASK_FILES) assert.equal(b.read(file), a.read(file));
  assert.deepEqual(JSON.parse(b.read(TASK_FILE)), tasks);
  assert.deepEqual(JSON.parse(b.read(PROJECT_FILE)), projects);
});

test("invalid task or project JSON is rejected locally before any commit", async (t) => {
  const f = setup(t), a = f.client("a");
  const invalid = ["{broken", "null", "{}", '{"Items":{}}', '{"items":null}', '{"Items":[null]}', '{"items":[[]]}', '["not an object"]'];
  for (const file of TASK_FILES) {
    for (const content of invalid) {
      a.put(file, content);
      await assert.rejects(a.service.preview(), /JSON|任务|项目/, `${file}: ${content}`);
      assert.equal(a.read(file), content);
    }
    a.remove(file);
  }
  assert.deepEqual(await git.listBranches({ fs, gitdir: f.remote }), []);
});

test("case aliases of task and project data are refused instead of ignored", async (t) => {
  for (const file of ["journal/task-module.json", "Journal/Task-Module.json", "Journal/ZENTASK-PROJECTS.json"]) {
    const f = setup(t), a = f.client("a");
    const content = JSON.stringify({ Items: [{ Id: "keep" }] });
    a.put(file, content);
    await assert.rejects(a.service.preview(), /大小写|路径/);
    assert.equal(a.read(file), content);
    assert.deepEqual(await git.listBranches({ fs, gitdir: f.remote }), []);
  }
});

test("merging a new task with a remote project deletion cannot create a dangling project link", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  const storeA = createZenTaskStore(a.root), storeB = createZenTaskStore(b.root);
  const project = storeA.addProject({ name: "并发编辑的项目" }).projects[0];
  await f.run(a); await f.run(b);
  const task = storeA.addTask({ title: "刚创建的任务", projectId: project.Id }).tasks[0];
  storeB.deleteProject(project.Id);
  await f.run(b);
  const local = Object.fromEntries(TASK_FILES.map((file) => [file, a.read(file)]));
  const head = f.command(["--git-dir", f.remote, "rev-parse", "main"]).toString();
  await assert.rejects(a.service.preview(), /关联|项目|引用/);
  for (const file of TASK_FILES) assert.equal(a.read(file), local[file]);
  assert.equal(storeA.load().tasks[0].Id, task.Id);
  assert.equal(storeA.load().projects[0].Id, project.Id);
  assert.equal(f.command(["--git-dir", f.remote, "rev-parse", "main"]).toString(), head);
});

test("invalid remote task or project JSON stops preview without changing local records", async (t) => {
  const f = setup(t), a = f.client("a");
  const valid = JSON.stringify({ SchemaVersion: 2, Items: [{ Id: "local", Custom: "keep" }] });
  for (const file of TASK_FILES) a.put(file, valid);
  await f.run(a);
  for (const [file, invalid] of [[TASK_FILE, "{broken"], [PROJECT_FILE, '{"Items":[null]}']]) {
    const rows = [];
    for (const candidate of TASK_FILES) {
      const oid = await git.writeBlob({ fs, gitdir: f.remote, blob: Buffer.from(candidate === file ? invalid : valid) });
      rows.push({ path: path.posix.basename(candidate), type: "blob", mode: "100644", oid });
    }
    const journal = await git.writeTree({ fs, gitdir: f.remote, tree: rows });
    const tree = await git.writeTree({ fs, gitdir: f.remote, tree: [{ path: "Journal", type: "tree", mode: "040000", oid: journal }] });
    const parent = await git.resolveRef({ fs, gitdir: f.remote, ref: "refs/heads/main" });
    const author = { name: "Test", email: "test@example.invalid", timestamp: 2, timezoneOffset: 0 };
    const commit = await git.writeCommit({ fs, gitdir: f.remote, commit: { tree, parent: [parent], author, committer: author, message: "invalid task data\n" } });
    await git.writeRef({ fs, gitdir: f.remote, ref: "refs/heads/main", value: commit, force: true });
    await assert.rejects(a.service.preview(), /JSON|任务|项目/, file);
    for (const candidate of TASK_FILES) assert.equal(a.read(candidate), valid);
    assert.equal(a.service.status().pending, false);
  }
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

test("partial task/project apply failure preserves backups and resumes from its journal after restart", async (t) => {
  const f = setup(t); const a = f.client("a"); let b = f.client("b");
  const initial = JSON.stringify({ SchemaVersion: 2, Items: [{ Id: "base" }] });
  const updated = JSON.stringify({ SchemaVersion: 2, Items: [{ Id: "new" }] });
  for (const file of TASK_FILES) a.put(file, initial);
  await f.run(a); await f.run(b);
  for (const file of TASK_FILES) a.put(file, updated);
  await f.run(a);
  const preview = await b.service.preview();
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === path.join(fs.realpathSync(b.root), PROJECT_FILE)) throw Object.assign(new Error("disk unavailable"), { code: "EACCES" });
    return rename(source, target);
  };
  try { await assert.rejects(b.service.sync({ previewId: preview.id }), /本地写入未完成/); }
  finally { fs.renameSync = rename; }
  assert.equal(b.read(TASK_FILE), updated); assert.equal(b.read(PROJECT_FILE), initial);
  const pending = JSON.parse(fs.readFileSync(path.join(f.folder, "b", "sync", "pending.json"), "utf8"));
  for (const file of TASK_FILES) assert.equal(fs.readFileSync(path.join(pending.backup, "local", file), "utf8"), initial);
  b = f.client("b"); const resumed = await b.service.preview();
  assert.deepEqual(resumed.conflicts, []); assert.deepEqual(resumed.downloads, [PROJECT_FILE]);
  await b.service.sync({ previewId: resumed.id });
  for (const file of TASK_FILES) assert.equal(b.read(file), updated);
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

for (const strategy of ["local", "remote", "both", "combine"]) {
  test(`click resolution ${strategy} stages without writes then converges both devices`, async (t) => {
    const f = setup(t), a = f.client("a"), b = f.client("b");
    a.put("Notes/note.md", "base"); await f.run(a); await f.run(b);
    a.put("Notes/note.md", "远端内容"); b.put("Notes/note.md", "本地内容"); await f.run(a);
    const p = await b.service.preview();
    assert.deepEqual(p.conflictDetails[0].options, ["local", "remote", "both", "combine"]);
    const detail = b.service.inspectConflict({ previewId: p.id, path: "Notes/note.md" });
    assert.equal(detail.local.text, "本地内容"); assert.equal(detail.remote.text, "远端内容");
    assert.throws(() => b.service.inspectConflict({ previewId: p.id, path: "../private" }), /冲突列表/);
    const head = f.command(["--git-dir", f.remote, "rev-parse", "main"]).toString();
    const resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions: [{ path: "Notes/note.md", strategy }] });
    assert.equal(b.read("Notes/note.md"), "本地内容");
    assert.equal(f.command(["--git-dir", f.remote, "rev-parse", "main"]).toString(), head);
    assert.notEqual(p.id, resolved.id); assert.deepEqual(resolved.conflicts, []);
    const result = await b.service.sync({ previewId: resolved.id }); await f.run(a);
    const expected = strategy === "remote" ? "远端内容" : strategy === "combine" ? "本地内容\n\n---\n\n## 远端版本（拼接保留）\n\n远端内容" : "本地内容";
    assert.equal(a.read("Notes/note.md"), expected); assert.equal(b.read("Notes/note.md"), expected);
    if (strategy === "both") {
      const copy = resolved.resolutions[0].copyPath;
      assert.match(copy, /^Notes\/note\.remote-[a-f0-9]{8}\.md$/);
      assert.equal(a.read(copy), "远端内容"); assert.equal(b.read(copy), "远端内容");
    }
    assert.equal(fs.readFileSync(path.join(result.backupDirectory, "local/Notes/note.md"), "utf8"), "本地内容");
    assert.equal(fs.readFileSync(path.join(p.conflictDirectory, "remote/Notes/note.md"), "utf8"), "远端内容");
    assert.deepEqual((await b.service.preview()).counts, { uploads: 0, downloads: 0, deletions: 0, conflicts: 0 });
  });
}

for (const deletedSide of ["local", "remote"]) {
  for (const strategy of ["local", "remote", "both"]) {
    test(`click resolution ${strategy} handles ${deletedSide} deletion versus modification`, async (t) => {
      const f = setup(t), a = f.client("a"), b = f.client("b");
      a.put("note.md", "base"); await f.run(a); await f.run(b);
      if (deletedSide === "local") { b.remove("note.md"); a.put("note.md", "new"); }
      else { a.remove("note.md"); b.put("note.md", "new"); }
      await f.run(a);
      const p = await b.service.preview();
      assert.equal(p.conflictDetails[0][`${deletedSide}Deleted`], true);
      assert.equal(p.conflictDetails[0].options.includes("combine"), false);
      const resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions: [{ path: "note.md", strategy }] });
      await b.service.sync({ previewId: resolved.id }); await f.run(a);
      for (const client of [a, b]) {
        if (strategy === deletedSide) assert.equal(fs.existsSync(path.join(client.root, "note.md")), false);
        else assert.equal(client.read("note.md"), "new");
      }
    });
  }
}

test("resolution validates all choices, limits text previews and preserves binary bytes", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  a.put("long.md", "r".repeat(20000)); b.put("long.md", "l".repeat(20000));
  const remoteImage = Buffer.from([0, 255, 1, 128]), localImage = Buffer.from([255, 0, 7]);
  a.put("image.png", remoteImage); b.put("image.png", localImage); await f.run(a);
  const p = await b.service.preview();
  const long = b.service.inspectConflict({ previewId: p.id, path: "long.md" });
  assert.equal(long.remote.text.length, 16000); assert.equal(long.remote.truncated, true);
  const image = b.service.inspectConflict({ previewId: p.id, path: "image.png" });
  assert.equal(image.local.text, null); assert.equal(image.local.image, `data:image/png;base64,${localImage.toString("base64")}`);
  for (const resolutions of [[], [{ path: "long.md", strategy: "local" }],
    [{ path: "long.md", strategy: "local" }, { path: "long.md", strategy: "remote" }],
    [{ path: "../secret", strategy: "local" }, { path: "image.png", strategy: "remote" }],
    [{ path: "long.md", strategy: "local" }, { path: "image.png", strategy: "combine" }]]) {
    await assert.rejects(b.service.resolveConflicts({ previewId: p.id, resolutions }), /选择|无效/);
  }
  const resolved = await b.service.resolveConflicts({ previewId: p.id,
    resolutions: [{ path: "long.md", strategy: "combine" }, { path: "image.png", strategy: "both" }] });
  await b.service.sync({ previewId: resolved.id }); await f.run(a);
  assert.ok(b.read("long.md").includes("r".repeat(20000)));
  const copy = resolved.resolutions.find((item) => item.path === "image.png").copyPath;
  assert.deepEqual(fs.readFileSync(path.join(b.root, copy)), remoteImage);
  assert.deepEqual(fs.readFileSync(path.join(a.root, "image.png")), localImage);
});

test("task choices reject broken associations and allow correcting choices without editing files", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  for (const [client, id] of [[a, "a"], [b, "b"]]) {
    client.put(TASK_FILE, JSON.stringify([{ Id: `task-${id}`, ProjectId: id }]));
    client.put(PROJECT_FILE, JSON.stringify([{ Id: id }]));
  }
  await f.run(a); const p = await b.service.preview();
  for (const detail of p.conflictDetails) assert.deepEqual(detail.options, ["local", "remote"]);
  await assert.rejects(b.service.resolveConflicts({ previewId: p.id, resolutions: [
    { path: TASK_FILE, strategy: "local" }, { path: PROJECT_FILE, strategy: "remote" },
  ] }), /悬空引用/);
  await assert.rejects(b.service.resolveConflicts({ previewId: p.id,
    resolutions: p.conflicts.map((file) => ({ path: file, strategy: "both" })) }), /无效/);
  const resolved = await b.service.resolveConflicts({ previewId: p.id,
    resolutions: p.conflicts.map((file) => ({ path: file, strategy: "local" })) });
  await b.service.sync({ previewId: resolved.id }); await f.run(a);
  assert.equal(a.read(TASK_FILE), b.read(TASK_FILE)); assert.equal(a.read(PROJECT_FILE), b.read(PROJECT_FILE));
});

test("resolution refuses stale snapshots and failed upload never applies staged merged data", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  a.put("note.md", "remote"); b.put("note.md", "local"); await f.run(a);
  let p = await b.service.preview(); b.put("note.md", "newer local");
  const resolutions = [{ path: "note.md", strategy: "combine" }];
  await assert.rejects(b.service.resolveConflicts({ previewId: p.id, resolutions }), /本地.*变化/);
  p = await b.service.preview(); let resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions });
  a.put("note.md", "newer remote"); await f.run(a);
  await assert.rejects(b.service.sync({ previewId: resolved.id }), /远端已变化/);
  assert.equal(b.read("note.md"), "newer local");
  p = await b.service.preview(); resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions });
  f.failPush(true);
  await assert.rejects(b.service.sync({ previewId: resolved.id }), /上传未确认/);
  assert.equal(b.read("note.md"), "newer local");
  f.failPush(false); p = await b.service.preview();
  resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions });
  await b.service.sync({ previewId: resolved.id }); await f.run(a);
  assert.equal(a.read("note.md"), b.read("note.md")); assert.match(b.read("note.md"), /newer remote/);
});

test("resolved copy recovers after push and disk failure without duplicating the remote copy", async (t) => {
  const f = setup(t), a = f.client("a"); let b = f.client("b");
  a.put("note.md", "remote"); b.put("note.md", "local"); await f.run(a);
  const p = await b.service.preview();
  const resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions: [{ path: "note.md", strategy: "both" }] });
  const copy = resolved.resolutions[0].copyPath, rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === path.join(fs.realpathSync(b.root), copy)) throw new Error("disk unavailable");
    return rename(source, target);
  };
  try { await assert.rejects(b.service.sync({ previewId: resolved.id }), /本地写入未完成/); }
  finally { fs.renameSync = rename; }
  assert.equal(b.read("note.md"), "local");
  b = f.client("b"); const resumed = await b.service.preview();
  assert.deepEqual(resumed.conflicts, []); assert.deepEqual(resumed.downloads, [copy]);
  await b.service.sync({ previewId: resumed.id }); await f.run(a);
  assert.equal(a.read(copy), "remote"); assert.equal(b.read(copy), "remote");
  assert.equal(b.service.status().pending, false);
});

test("oversized concatenation is rejected while other click choices remain available", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  a.put("large.md", Buffer.alloc(5 * 1024 * 1024, 65));
  b.put("large.md", Buffer.alloc(5 * 1024 * 1024, 66)); await f.run(a);
  const p = await b.service.preview();
  await assert.rejects(b.service.resolveConflicts({ previewId: p.id, resolutions: [{ path: "large.md", strategy: "combine" }] }), /合并后单文件超过/);
  const resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions: [{ path: "large.md", strategy: "remote" }] });
  assert.deepEqual(resolved.conflicts, []);
  assert.equal(fs.readFileSync(path.join(b.root, "large.md"))[0], 66);
});

test("local edits after choosing a resolution invalidate the plan without losing edits", async (t) => {
  const f = setup(t), a = f.client("a"), b = f.client("b");
  a.put("note.md", "remote"); b.put("note.md", "local"); await f.run(a);
  const p = await b.service.preview();
  const resolved = await b.service.resolveConflicts({ previewId: p.id, resolutions: [{ path: "note.md", strategy: "combine" }] });
  b.put("note.md", "new edit after choosing");
  await assert.rejects(b.service.sync({ previewId: resolved.id }), /本地.*变化/);
  assert.equal(b.read("note.md"), "new edit after choosing");
  assert.equal(f.command(["--git-dir", f.remote, "show", "main:note.md"]).toString(), "remote");
});
