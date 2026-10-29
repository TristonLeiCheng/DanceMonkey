const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getPkbPaths, createPkb } = require("./pkb");
const notesHome = require("../src/notes-home");

function noteMetadata(target, stat) {
  const fallback = { createdAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : null, createdAtSource: "filesystem" };
  const buffer = Buffer.alloc(8192);
  let fd;
  let head;
  try { fd = fs.openSync(target, "r"); head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"); }
  catch { return fallback; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const header = head.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header) return fallback;
  const scalar = (key) => {
    const value = header.match(new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)$`, "m"))?.[1]?.trim();
    if (!value) return "";
    if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return ""; } }
    return value.replace(/^'(.*)'$/, "$1");
  };
  const created = scalar("created") || scalar("createdAt");
  const date = typeof created === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(created) ? Date.parse(created) : NaN;
  const title = scalar("title");
  return { ...fallback, ...(Number.isFinite(date) ? { createdAt: date, createdAtSource: "metadata" } : {}),
    ...(typeof title === "string" && title ? { title } : {}) };
}

const QUICK_NOTE_MARKER = /^<!-- lumen-quick-note:([^\s>]+) -->\r?\n?/i;
const QUICK_NOTE_MARKERS = /^(?:<!-- lumen-quick-note:[^\s>]+ -->\r?\n?)+/i;

function writeAtomic(target, content) {
  const temporary = path.join(path.dirname(target), `.dm-write-${crypto.randomUUID()}.tmp`);
  try {
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function createWorkspace(notesRootPath, { initializeQuickNotes = true } = {}) {
  fs.mkdirSync(path.resolve(notesRootPath), { recursive: true });
  const root = fs.realpathSync(path.resolve(notesRootPath));

  // Resolved dynamically (not cached at creation time) because a PKB
  // manifest may be initialized after this workspace object already exists,
  // which should immediately redirect where quick notes live.
  function quickNotesFolder() {
    return getPkbPaths(root).quickNotes;
  }

  function quickNotesRootDir() {
    return path.join(root, quickNotesFolder());
  }

  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true });
    resolveSafe(quickNotesFolder());
    fs.mkdirSync(quickNotesRootDir(), { recursive: true });
  }

  function resolveSafe(relativePath = "") {
    const normalized = String(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
    const resolved = path.resolve(root, normalized);
    const rootResolved = path.resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error("非法路径");
    }
    const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
    let current = root;
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error("笔记库不能是符号链接");
    for (const segment of segments) {
      if (segment.toLowerCase() === ".git") throw new Error("不能访问 Git 内部文件");
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("不支持符号链接笔记路径");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return resolved;
  }

  function safeName(name, type) {
    let value = String(name || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
    value = value.replace(/^\.+/, "").replace(/[. ]+$/, "");
    if (!value) value = type === "folder" ? "新建文件夹" : "未命名笔记";
    if (type === "file" && !value.toLowerCase().endsWith(".md")) value += ".md";
    return value;
  }

  function uniquePath(parentRelative, name, type) {
    const parent = resolveSafe(parentRelative);
    const parsed = path.parse(safeName(name, type));
    let candidate = path.join(parent, parsed.base);
    let index = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(parent, `${parsed.name} ${index}${parsed.ext}`);
      index += 1;
    }
    return candidate;
  }

  function toRelative(absolutePath) {
    return path.relative(root, absolutePath).replaceAll("\\", "/");
  }

  function readTree(directory = root) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.toLowerCase() !== ".git" && !entry.isSymbolicLink() &&
        (entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      })
      .map((entry) => {
        const absolute = path.join(directory, entry.name);
        const relative = toRelative(absolute);
        if (entry.isDirectory()) {
          return {
            type: "folder",
            name: entry.name,
            path: relative,
            children: readTree(absolute),
          };
        }
        const stat = fs.statSync(absolute);
        return {
          type: "file",
          name: entry.name,
          path: relative,
          updatedAt: stat.mtimeMs,
          size: stat.size,
          ...noteMetadata(absolute, stat),
        };
      });
  }

  function isQuickNote(absolutePath) {
    const relative = path.relative(quickNotesRootDir(), absolutePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  function parseQuickNote(raw, fallbackId = null) {
    const match = String(raw).match(QUICK_NOTE_MARKER);
    return {
      id: match?.[1] || fallbackId || crypto.randomUUID(),
      body: String(raw).replace(QUICK_NOTE_MARKERS, ""),
    };
  }

  function quickNoteId(absolutePath) {
    return crypto
      .createHash("sha256")
      .update(toRelative(absolutePath).toLowerCase())
      .digest("hex")
      .slice(0, 24);
  }

  function quickNoteRaw(id, body) {
    return `<!-- lumen-quick-note:${id} -->\n${String(body)}`;
  }

  function readQuickNote(absolutePath) {
    const raw = fs.readFileSync(absolutePath, "utf8");
    return parseQuickNote(raw, quickNoteId(absolutePath));
  }

  function listQuickNotes() {
    ensureRoot();
    const quickNotesRoot = quickNotesRootDir();
    return fs
      .readdirSync(quickNotesRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => {
        const absolute = path.join(quickNotesRoot, entry.name);
        const parsed = readQuickNote(absolute);
        const stat = fs.statSync(absolute);
        return {
          id: parsed.id,
          filePath: toRelative(absolute),
          notebookId: "inbox",
          title: path.parse(entry.name).name,
          body: parsed.body,
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          updatedAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function syncQuickNotes(notes) {
    ensureRoot();
    const existing = new Map(listQuickNotes().map((note) => [note.id, note]));
    const synced = [];

    for (const note of notes) {
      const current = existing.get(note.id);
      let absolute;
      if (current) {
        absolute = resolveSafe(current.filePath);
        const wantedName = safeName(note.title || "未命名便签", "file");
        if (path.basename(absolute) !== wantedName) {
          const target = uniquePath(quickNotesFolder(), note.title || "未命名便签", "file");
          fs.renameSync(absolute, target);
          absolute = target;
        }
      } else {
        absolute = uniquePath(quickNotesFolder(), note.title || "未命名便签", "file");
      }

      const existingRaw = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
      const wantedContent = QUICK_NOTE_MARKER.test(existingRaw)
        ? quickNoteRaw(note.id, note.body)
        : String(note.body);
      const currentContent = fs.existsSync(absolute)
          ? existingRaw
        : null;
      if (currentContent !== wantedContent) {
        writeAtomic(absolute, wantedContent);
      }
      const stat = fs.statSync(absolute);
      synced.push({
        ...note,
        filePath: toRelative(absolute),
        notebookId: "inbox",
        title: path.parse(absolute).name,
        updatedAt: stat.mtimeMs,
      });
    }

    return synced.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  if (initializeQuickNotes) ensureRoot();

  return {
    root,
    list() {
      ensureRoot();
      return readTree();
    },
    read(relativePath) {
      const target = resolveSafe(relativePath);
      if (!target.toLowerCase().endsWith(".md")) throw new Error("仅支持 Markdown 文件");
      const raw = fs.readFileSync(target, "utf8");
      return isQuickNote(target) ? parseQuickNote(raw).body : raw;
    },
    write(relativePath, content) {
      const target = resolveSafe(relativePath);
      if (!target.toLowerCase().endsWith(".md")) throw new Error("仅支持 Markdown 文件");
      if (isQuickNote(target)) {
        const existing = fs.existsSync(target)
          ? readQuickNote(target)
          : { id: quickNoteId(target) };
        const raw = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
        writeAtomic(target, QUICK_NOTE_MARKER.test(raw) ? quickNoteRaw(existing.id, content) : String(content));
      } else {
        writeAtomic(target, String(content));
      }
      return { path: toRelative(target), updatedAt: fs.statSync(target).mtimeMs };
    },
    createFile(parentRelative, name) {
      const target = uniquePath(parentRelative, name, "file");
      writeAtomic(target, `# ${path.parse(target).name}\n\n`);
      return toRelative(target);
    },
    createNote({ type, title } = {}) {
      const kind = notesHome.kind(type);
      getPkbPaths(root); // Refuse a corrupt manifest instead of silently changing routing.
      const pkb = createPkb(root);
      const initialized = pkb.status().initialized;
      const resolvedTitle = String(title || "").replace(/[\r\n\x00-\x1f]+/g, " ").trim().slice(0, 120) ||
        (type === "daily" ? notesHome.localDay() : `未命名${kind.label}`);
      if (initialized && type !== "blank") return pkb.createNote({ type, title: resolvedTitle });
      const parent = initialized ? "" : kind.folder;
      const folder = resolveSafe(parent);
      fs.mkdirSync(folder, { recursive: true });
      const target = uniquePath(parent, resolvedTitle, "file");
      fs.writeFileSync(target, notesHome.compose(type, resolvedTitle, crypto.randomUUID()), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return { path: toRelative(target) };
    },
    createFolder(parentRelative, name) {
      const target = uniquePath(parentRelative, name, "folder");
      fs.mkdirSync(target, { recursive: false });
      return toRelative(target);
    },
    rename(relativePath, newName) {
      const source = resolveSafe(relativePath);
      const type = fs.statSync(source).isDirectory() ? "folder" : "file";
      const target = uniquePath(toRelative(path.dirname(source)), newName, type);
      fs.renameSync(source, target);
      return toRelative(target);
    },
    remove(relativePath) {
      const target = resolveSafe(relativePath);
      if (target === path.resolve(root)) throw new Error("不能删除知识库根目录");
      fs.rmSync(target, { recursive: true, force: false });
      return true;
    },
    get quickNotesFolder() {
      return quickNotesFolder();
    },
    listQuickNotes,
    syncQuickNotes,
  };
}

module.exports = { createWorkspace, writeAtomic, noteMetadata };
