const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const QUICK_NOTES_FOLDER = "Journal/Stickies";
const QUICK_NOTE_MARKER = /^<!-- lumen-quick-note:([^\s>]+) -->\r?\n?/i;
const QUICK_NOTE_MARKERS = /^(?:<!-- lumen-quick-note:[^\s>]+ -->\r?\n?)+/i;

function createWorkspace(notesRootPath) {
  const root = path.resolve(notesRootPath);
  const quickNotesRoot = path.join(root, QUICK_NOTES_FOLDER);

  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(quickNotesRoot, { recursive: true });
  }

  function resolveSafe(relativePath = "") {
    const normalized = String(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
    const resolved = path.resolve(root, normalized);
    const rootResolved = path.resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error("非法路径");
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
      .filter((entry) => entry.isDirectory() || entry.name.toLowerCase().endsWith(".md"))
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
        };
      });
  }

  function isQuickNote(absolutePath) {
    const relative = path.relative(quickNotesRoot, absolutePath);
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
          const target = uniquePath(QUICK_NOTES_FOLDER, note.title || "未命名便签", "file");
          fs.renameSync(absolute, target);
          absolute = target;
        }
      } else {
        absolute = uniquePath(QUICK_NOTES_FOLDER, note.title || "未命名便签", "file");
      }

      const existingRaw = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
      const wantedContent = QUICK_NOTE_MARKER.test(existingRaw)
        ? quickNoteRaw(note.id, note.body)
        : String(note.body);
      const currentContent = fs.existsSync(absolute)
          ? existingRaw
        : null;
      if (currentContent !== wantedContent) {
        fs.writeFileSync(absolute, wantedContent, "utf8");
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

  ensureRoot();

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
        fs.writeFileSync(
          target,
          QUICK_NOTE_MARKER.test(raw) ? quickNoteRaw(existing.id, content) : String(content),
          "utf8",
        );
      } else {
        fs.writeFileSync(target, String(content), "utf8");
      }
      return { path: toRelative(target), updatedAt: fs.statSync(target).mtimeMs };
    },
    createFile(parentRelative, name) {
      const target = uniquePath(parentRelative, name, "file");
      fs.writeFileSync(target, `# ${path.parse(target).name}\n\n`, "utf8");
      return toRelative(target);
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
    quickNotesFolder: QUICK_NOTES_FOLDER,
    listQuickNotes,
    syncQuickNotes,
  };
}

module.exports = { createWorkspace };
