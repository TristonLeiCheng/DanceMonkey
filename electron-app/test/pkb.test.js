const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPkb, getPkbPaths, PROTECTED_DIRECTORIES, NOTE_TYPES } = require("../electron/pkb");

function tempRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dm-pkb-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("status() is false on an empty directory and getPkbPaths() falls back to legacy layout", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  assert.deepEqual(pkb.status(), { initialized: false });
  assert.deepEqual(getPkbPaths(root), {
    quickNotes: "Journal/Stickies",
    screenshots: "Inbox/Screenshots",
    captures: "Inbox/Captures",
  });
});

test("preview() reports planned directories/files without writing anything", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  const preview = pkb.preview();
  assert.ok(preview.directories.includes("00_Inbox/quick-notes"));
  assert.ok(preview.directories.includes("80_Vault/identity"));
  assert.ok(preview.files.includes("_System/pkb.json"));
  assert.ok(preview.files.some((f) => f.startsWith("_System/templates/")));
  assert.deepEqual(preview.warnings, []);
  // Nothing should have been created by preview.
  assert.equal(fs.existsSync(path.join(root, "00_Inbox")), false);
  assert.equal(fs.existsSync(path.join(root, "_System", "pkb.json")), false);
});

test("initialize() creates the full category tree, manifest and templates; status() reflects it", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  const result = pkb.initialize();
  assert.equal(result.initialized, true);
  assert.equal(result.schemaVersion, 1);
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.ok(result.created);
  assert.deepEqual(result.paths, {
    quickNotes: "00_Inbox/quick-notes",
    screenshots: "00_Inbox/attachments",
    captures: "00_Inbox/captures",
  });

  for (const dir of [
    "00_Inbox/quick-notes",
    "00_Inbox/downloads",
    "00_Inbox/ai-pending",
    "00_Inbox/attachments",
    "00_Inbox/captures",
    "10_Self/13_Skills",
    "10_Self/15_Reflection",
    "40_Life/42_Family",
    "40_Life/43_Travel",
    "40_Life/44_Vehicles",
    "40_Life/45_Purchases",
    "20_Work/22_Tasks/active",
    "20_Work/22_Tasks/done",
    "20_Work/23_Projects/company",
    "20_Work/23_Projects/personal",
    "30_Knowledge/topics",
    "40_Life/46_Hobbies",
    "50_Social/people",
    "60_Health/mental",
    "70_Finance/assets-liabilities",
    "80_Vault/credentials",
    "90_AI/91_Outputs/digests",
    "90_AI/92_Context",
    "99_Archive",
    "_System/templates",
  ]) {
    assert.ok(fs.statSync(path.join(root, dir)).isDirectory(), `expected directory ${dir}`);
  }

  assert.ok(fs.statSync(path.join(root, "20_Work/22_Tasks/backlog.md")).isFile());
  for (const type of NOTE_TYPES) {
    assert.ok(fs.statSync(path.join(root, `_System/templates/${type}.md`)).isFile());
  }
  for (const doc of ["index.md", "conventions.md", "schema.md", "storage-policy.md"]) {
    const content = fs.readFileSync(path.join(root, "_System", doc), "utf8");
    assert.ok(content.length > 0);
  }
  const policy = fs.readFileSync(path.join(root, "_System/storage-policy.md"), "utf8");
  assert.match(policy, /没有加密/);
  assert.match(policy, /80_Vault/);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "_System/pkb.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.paths.quickNotes, "00_Inbox/quick-notes");

  assert.deepEqual(pkb.status(), result);
});

test("initialize() is idempotent: re-running only adds, never overwrites user edits", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  const first = pkb.initialize();

  // Simulate a user editing a template and adding their own file.
  const templatePath = path.join(root, "_System/templates/note.md");
  fs.writeFileSync(templatePath, "# user edited\n");
  fs.writeFileSync(path.join(root, "30_Knowledge/topics", "mine.md"), "# mine\n");

  const second = pkb.initialize();
  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(templatePath, "utf8"), "# user edited\n");
  assert.ok(fs.existsSync(path.join(root, "30_Knowledge/topics", "mine.md")));
});

test("preview() after initialize() reports nothing left to create and warns it is already initialized", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();
  const preview = pkb.preview();
  assert.deepEqual(preview.directories, []);
  assert.deepEqual(preview.files, []);
  assert.ok(preview.warnings.some((w) => w.includes("已初始化")));
});

test("initialize() fails closed on symlink conflicts without creating anything, and status() stays uninitialized", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "00_Inbox"));
  fs.symlinkSync(os.tmpdir(), path.join(root, "00_Inbox", "quick-notes"));

  const pkb = createPkb(root);
  const preview = pkb.preview();
  assert.ok(preview.warnings.some((w) => w.includes("符号链接")));
  assert.throws(() => pkb.initialize(), /符号链接/);
  assert.deepEqual(pkb.status(), { initialized: false });
  assert.equal(fs.existsSync(path.join(root, "_System", "pkb.json")), false);
});

test("initialize() fails closed when a planned directory path collides with an existing file", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "80_Vault"));
  fs.writeFileSync(path.join(root, "80_Vault", "identity"), "not a directory");

  const pkb = createPkb(root);
  assert.throws(() => pkb.initialize(), /已存在同名文件/);
  assert.deepEqual(pkb.status(), { initialized: false });
});

test("status() fails closed (treats as uninitialized) when the manifest file is invalid JSON", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "_System"), { recursive: true });
  fs.writeFileSync(path.join(root, "_System", "pkb.json"), "{not valid json");

  const pkb = createPkb(root);
  const status = pkb.status();
  assert.equal(status.initialized, false);
  assert.ok(status.warnings?.some((w) => w.includes("无效")));
  assert.throws(() => getPkbPaths(root), /配置无效/);
});

test("status() fails closed when the manifest schemaVersion is unsupported", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "_System"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_System", "pkb.json"),
    JSON.stringify({ schemaVersion: 99, id: "x", created: "y", paths: { quickNotes: "a", screenshots: "b", captures: "c" } }),
  );
  const pkb = createPkb(root);
  assert.equal(pkb.status().initialized, false);
});

test("initialize() preserves an existing non-empty legacy Stickies folder by routing quick notes there", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "Journal", "Stickies"), { recursive: true });
  fs.writeFileSync(path.join(root, "Journal", "Stickies", "old-note.md"), "<!-- lumen-quick-note:abc -->\nhello");

  const pkb = createPkb(root);
  const result = pkb.initialize();
  assert.equal(result.paths.quickNotes, "Journal/Stickies");
  assert.deepEqual(getPkbPaths(root), {
    quickNotes: "Journal/Stickies",
    screenshots: "00_Inbox/attachments",
    captures: "00_Inbox/captures",
  });
  // Old data untouched.
  assert.equal(
    fs.readFileSync(path.join(root, "Journal", "Stickies", "old-note.md"), "utf8"),
    "<!-- lumen-quick-note:abc -->\nhello",
  );
});

test("initialize() routes a fresh/empty vault's quick notes to 00_Inbox/quick-notes", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  const result = pkb.initialize();
  assert.equal(result.paths.quickNotes, "00_Inbox/quick-notes");
});

test("initialize() routes an empty (but present) legacy Stickies folder to the new quick-notes path too", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "Journal", "Stickies"), { recursive: true });
  const pkb = createPkb(root);
  const result = pkb.initialize();
  assert.equal(result.paths.quickNotes, "00_Inbox/quick-notes");
});

test("createNote() produces a stable frontmatter id per template type across calls' expected shape, filename includes title, parent defaults by type", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();

  const note = pkb.createNote({ type: "note", title: "我的笔记" });
  assert.equal(note.path, "30_Knowledge/notes/我的笔记.md");

  const daily = pkb.createNote({ type: "daily", title: "2026-10-21" });
  assert.match(daily.path, /^01_Journal\/daily\/\d{4}\/2026-10-21\.md$/);

  const meeting = pkb.createNote({ type: "meeting", title: "周会" });
  assert.equal(meeting.path, "20_Work/24_Meetings/周会.md");

  const person = pkb.createNote({ type: "person", title: "张三" });
  assert.equal(person.path, "50_Social/people/张三.md");

  const project = pkb.createNote({ type: "project", title: "新项目" });
  assert.equal(project.path, "20_Work/23_Projects/personal/新项目.md");

  const content = fs.readFileSync(path.join(root, note.path), "utf8");
  assert.match(content, /^---\n/);
  assert.match(content, /type: "note"/);
  assert.match(content, /title: "我的笔记"/);
  assert.match(content, /sensitivity: "normal"/);
  assert.doesNotMatch(content, /\nupdated:/);

  // Explicit parent override.
  const custom = pkb.createNote({ type: "note", title: "自定义位置", parent: "99_Archive" });
  assert.equal(custom.path, "99_Archive/自定义位置.md");
});

test("createNote() rejects unknown type and path traversal via parent, and de-duplicates filenames", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();
  assert.throws(() => pkb.createNote({ type: "bogus", title: "x" }), /不支持的笔记类型/);
  assert.throws(() => pkb.createNote({ type: "note", title: "x", parent: "../../etc" }), /非法路径/);

  const a = pkb.createNote({ type: "note", title: "重复" });
  const b = pkb.createNote({ type: "note", title: "重复" });
  assert.notEqual(a.path, b.path);
  assert.match(b.path, /重复 2\.md$/);
});

test("the shipped templates carry fixed, stable UUIDs across installs", (t) => {
  const rootA = tempRoot(t);
  const rootB = tempRoot(t);
  createPkb(rootA).initialize();
  createPkb(rootB).initialize();
  for (const type of NOTE_TYPES) {
    const a = fs.readFileSync(path.join(rootA, `_System/templates/${type}.md`), "utf8");
    const b = fs.readFileSync(path.join(rootB, `_System/templates/${type}.md`), "utf8");
    assert.equal(a, b);
    assert.match(a, /^id: "[0-9a-f-]{36}"/m);
  }
});

test("search() finds matches by content and by filename, case-insensitively, and returns title+snippet", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();
  pkb.createNote({ type: "note", title: "特定关键词笔记" });
  fs.writeFileSync(path.join(root, "30_Knowledge/notes", "plain.md"), "# Plain\n\nThis mentions Unicorn somewhere in the body.\n");

  const byContent = pkb.search("unicorn");
  assert.equal(byContent.length, 1);
  assert.equal(byContent[0].path, "30_Knowledge/notes/plain.md");
  assert.equal(byContent[0].title, "Plain");
  assert.match(byContent[0].snippet, /Unicorn/i);

  const byName = pkb.search("特定关键词");
  assert.ok(byName.some((r) => r.path.endsWith("特定关键词笔记.md")));

  assert.deepEqual(pkb.search(""), []);
  assert.deepEqual(pkb.search("   "), []);
});

test("search() skips symlinks, dotfiles, and protected template/vault/_System directories", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();

  fs.writeFileSync(path.join(root, "80_Vault/identity", "secret-zylophone.md"), "# zylophone secret\n");
  fs.mkdirSync(path.join(root, "30_Knowledge/notes", ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(root, "30_Knowledge/notes", ".hidden", "zylophone.md"), "# zylophone hidden\n");

  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-pkb-link-target-"));
  fs.writeFileSync(path.join(targetDir, "zylophone.md"), "# zylophone linked\n");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  try {
    fs.symlinkSync(targetDir, path.join(root, "30_Knowledge/notes", "linked"));
  } catch {
    // Symlink creation can fail on some restricted environments (e.g. no
    // privilege on Windows); skip that assertion branch if so.
  }

  // Template files contain "{{title}}" which should not leak into search
  // for an unrelated query, and explicitly should not match 'zylophone'.
  assert.deepEqual(pkb.search("zylophone"), []);
});

test("search() respects the 100 result cap", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();
  const dir = path.join(root, "30_Knowledge/notes");
  for (let i = 0; i < 130; i += 1) {
    fs.writeFileSync(path.join(dir, `bulk-haystack-${i}.md`), `# haystack ${i}\n`);
  }
  const results = pkb.search("haystack");
  assert.equal(results.length, 100);
});

test("getPkbPaths() uses the frozen manifest paths and does not re-derive from current directory contents", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "Journal", "Stickies"), { recursive: true });
  fs.writeFileSync(path.join(root, "Journal", "Stickies", "old.md"), "hi");
  const pkb = createPkb(root);
  pkb.initialize();
  assert.equal(getPkbPaths(root).quickNotes, "Journal/Stickies");

  // Even if the legacy folder is emptied after the fact, the manifest's
  // frozen path keeps winning (no silent re-routing).
  fs.rmSync(path.join(root, "Journal", "Stickies", "old.md"));
  assert.equal(getPkbPaths(root).quickNotes, "Journal/Stickies");
});

test("protected directories list used by sync policy matches the sensitive categories", () => {
  for (const dir of [
    "60_Health",
    "70_Finance",
    "80_Vault",
    "90_AI/92_Context",
    "90_AI/94_Datasets",
    "90_AI/95_Logs",
    "00_Inbox/ai-pending",
  ]) {
    assert.ok(PROTECTED_DIRECTORIES.includes(dir), `expected ${dir} to be protected`);
  }
});

test("unsafe manifest routing cannot escape the vault or silently fall back", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();
  const file = path.join(root, "_System/pkb.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const route of ["../../outside", "/tmp/outside", "C:\\outside", "00_Inbox/../other", ""]) {
    fs.writeFileSync(file, JSON.stringify({ ...manifest, paths: { ...manifest.paths, quickNotes: route } }));
    assert.equal(pkb.status().initialized, false);
    assert.throws(() => getPkbPaths(root), /配置无效/);
    assert.throws(() => pkb.initialize(), /初始化被拒绝/);
  }
});

test("preview does not create a missing root", (t) => {
  const root = path.join(tempRoot(t), "missing");
  assert.throws(() => createPkb(root).preview(), /存在/);
  assert.equal(fs.existsSync(root), false);
});

test("reinitialization repairs missing templates without changing the vault ID", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  const initial = pkb.initialize();
  fs.unlinkSync(path.join(root, "_System/templates/note.md"));
  assert.equal(pkb.initialize().id, initial.id);
  assert.ok(fs.existsSync(path.join(root, "_System/templates/note.md")));
});

test("template creation uses edited template body and generates fresh note IDs", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  assert.throws(() => pkb.createNote({ type: "note", title: "before" }), /初始化/);
  pkb.initialize();
  fs.writeFileSync(path.join(root, "_System/templates/note.md"), "---\nid: old-template\n---\n# {{title}}\n\nCustom section\n");
  const a = pkb.createNote({ type: "note", title: "A" });
  const b = pkb.createNote({ type: "note", title: "B" });
  const textA = fs.readFileSync(path.join(root, a.path), "utf8");
  const textB = fs.readFileSync(path.join(root, b.path), "utf8");
  assert.match(textA, /Custom section/);
  assert.doesNotMatch(textA, /old-template/);
  assert.notEqual(textA.match(/^id: (.+)$/m)[1], textB.match(/^id: (.+)$/m)[1]);
});

test("initialize() creates protected directories empty, never pre-populated with files", (t) => {
  const root = tempRoot(t);
  const pkb = createPkb(root);
  pkb.initialize();
  for (const dir of PROTECTED_DIRECTORIES) {
    const absolute = path.join(root, dir);
    assert.ok(fs.statSync(absolute).isDirectory());
    const walk = (d) => {
      let files = 0;
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) files += walk(path.join(d, entry.name));
        else files += 1;
      }
      return files;
    };
    assert.equal(walk(absolute), 0, `${dir} should be created empty`);
  }
});
