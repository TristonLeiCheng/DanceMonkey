const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorkspace } = require("../electron/workspace");
const { createGitHubCoordinator } = require("../electron/github-coordinator");
const { createGitHubTransport } = require("../electron/github-transport");

function vault(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-sync-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace: createWorkspace(root) };
}

test("workspace hides Git internals and rejects direct access", (t) => {
  const { root, workspace } = vault(t);
  fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "private.md"), "internal");
  assert.equal(workspace.list().some((item) => item.name === ".git"), false);
  assert.throws(() => workspace.read(".git/private.md"), /Git/);
  assert.throws(() => workspace.remove(".git"), /Git/);
});

test("workspace atomically writes Markdown and quick notes without leftover temporary files", (t) => {
  const { root, workspace } = vault(t);
  const file = workspace.createFile("", "hello");
  workspace.write(file, "new content");
  assert.equal(workspace.read(file), "new content");
  const [note] = workspace.syncQuickNotes([{ id: "id-1", title: "Sticky", body: "old" }]);
  workspace.write(note.filePath, "new sticky");
  assert.equal(workspace.listQuickNotes()[0].body, "new sticky");
  assert.equal(fs.readdirSync(root).some((entry) => entry.endsWith(".tmp")), false);
});

test("workspace refuses symlink paths", { skip: process.platform === "win32" }, (t) => {
  const { root, workspace } = vault(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dm-sync-outside-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "secret.md"), "do not read");
  fs.symlinkSync(directory, path.join(root, "linked"));
  assert.equal(workspace.list().some((item) => item.name === "linked"), false);
  assert.throws(() => workspace.read("linked/secret.md"), /符号链接/);
  assert.throws(() => workspace.write("linked/secret.md", "oops"), /符号链接/);
  assert.equal(fs.readFileSync(path.join(directory, "secret.md"), "utf8"), "do not read");
});

test("coordinator flushes both editors, locks writes, resumes before resolving, rejects stale generations", async () => {
  const phases = [];
  let coordinator;
  const participants = [0, 1].map((index) => ({
    isDestroyed: () => false,
    send: (_channel, payload) => {
      phases.push(`${payload.phase}:${index}`);
      queueMicrotask(() => coordinator.acknowledge(participants[index], payload));
    },
  }));
  coordinator = createGitHubCoordinator({ getParticipants: () => participants });
  const result = await coordinator.run(async () => {
    phases.push("operation");
    assert.throws(() => coordinator.assertWritable(0), /正在同步/);
    await assert.rejects(coordinator.run(() => {}), /正在进行/);
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(phases, ["prepare:0", "prepare:1", "operation", "resume:0", "resume:1"]);
  assert.equal(coordinator.busy, false);
  assert.equal(coordinator.generation, 1);
  assert.throws(() => coordinator.assertWritable(0), /版本已更新/);
  coordinator.assertWritable(1);
});

test("coordinator always resumes on failure and ignores foreign acknowledgements", async () => {
  let coordinator;
  let resumed = false;
  const sender = { isDestroyed: () => false, send: (_channel, payload) => {
    coordinator.acknowledge({}, payload);
    if (payload.phase === "resume") resumed = true;
    queueMicrotask(() => coordinator.acknowledge(sender, payload));
  } };
  coordinator = createGitHubCoordinator({ getParticipants: () => [sender] });
  await assert.rejects(coordinator.run(() => { throw new Error("offline"); }), /offline/);
  assert.equal(resumed, true);
  assert.equal(coordinator.busy, false);
});

test("coordinator times out safely when an editor never responds", async () => {
  let coordinator;
  const sender = { isDestroyed: () => false, send: (_channel, payload) => {
    if (payload.phase === "resume") queueMicrotask(() => coordinator.acknowledge(sender, payload));
  } };
  coordinator = createGitHubCoordinator({ getParticipants: () => [sender], timeout: 15 });
  let ran = false;
  await assert.rejects(coordinator.run(() => { ran = true; }), /超时/);
  assert.equal(ran, false);
  assert.equal(coordinator.busy, false);
  coordinator.assertWritable(coordinator.generation);
});

test("coordinator does not run if editor save fails", async () => {
  let coordinator;
  const sender = { isDestroyed: () => false, send: (_channel, payload) => {
    queueMicrotask(() => coordinator.acknowledge(sender, { ...payload, error: payload.phase === "prepare" }));
  } };
  coordinator = createGitHubCoordinator({ getParticipants: () => [sender] });
  let ran = false;
  await assert.rejects(coordinator.run(() => { ran = true; }), /保存或刷新/);
  assert.equal(ran, false);
  assert.equal(coordinator.busy, false);
});

test("Git transport handles isomorphic-git byte arrays and forbids redirects/foreign hosts", async () => {
  let bytes;
  const transport = createGitHubTransport(async (url, options) => {
    bytes = [];
    for await (const chunk of options.body) bytes.push(...chunk);
    assert.equal(options.redirect, "manual");
    assert.equal(options.duplex, "half");
    return new Response(new Uint8Array([4, 5]), { status: 200 });
  });
  const response = await transport.request({ url: "https://github.com/owner/notes.git/git-receive-pack", method: "POST", body: [new Uint8Array([1]), new Uint8Array([2, 3])] });
  assert.deepEqual(bytes, [1, 2, 3]);
  assert.equal(response.statusCode, 200);
  await assert.rejects(transport.request({ url: "https://example.com/owner/notes.git/info/refs" }), /仅允许/);
  await assert.rejects(transport.request({ url: "https://token@github.com/owner/notes.git/info/refs" }), /仅允许/);
  const redirected = createGitHubTransport(async () => new Response(null, { status: 301 }));
  await assert.rejects(redirected.request({ url: "https://github.com/owner/notes.git/info/refs" }), /重定向/);
});

test("Git transport limits streamed pack size and sanitizes mid-stream failures", async () => {
  const makeTransport = (body) => createGitHubTransport(async () => ({ status: 200, statusText: "OK", headers: new Headers(), body }));
  const oversized = await makeTransport((async function* () { yield { byteLength: 257 * 1024 * 1024 }; })()).request({ url: "https://github.com/owner/notes.git/git-upload-pack" });
  await assert.rejects(async () => { for await (const chunk of oversized.body) void chunk; }, /256 MiB/);
  const failed = await makeTransport((async function* () { throw new Error("PRIVATE TOKEN"); })()).request({ url: "https://github.com/owner/notes.git/git-upload-pack" });
  await assert.rejects(async () => { for await (const chunk of failed.body) void chunk; }, (error) => {
    assert.equal(error.message.includes("PRIVATE TOKEN"), false);
    assert.match(error.message, /传输中断/);
    return true;
  });
});

test("Git transport does not expose token or proxy errors", async () => {
  const transport = createGitHubTransport(async () => { throw new Error("SECRET-TOKEN in proxy URL"); });
  await assert.rejects(transport.request({ url: "https://github.com/owner/notes.git/info/refs" }), (error) => {
    assert.equal(error.message.includes("SECRET-TOKEN"), false);
    return true;
  });
});
