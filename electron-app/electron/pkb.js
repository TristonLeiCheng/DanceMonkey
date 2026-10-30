"use strict";
/**
 * PKB (Personal Knowledge Base) v1 backend.
 *
 * Self-contained module: does NOT require workspace.js, to avoid a circular
 * dependency (workspace.js and screenshot.js call into this module to resolve
 * the quick-notes / screenshots / captures directories).
 *
 * Design notes:
 * - Initialization is explicit (preview() then initialize()), never implicit.
 * - initialize() only ever ADDS files/directories. It never overwrites an
 *   existing file and never moves/deletes any pre-existing user data.
 * - Once initialized, the chosen quick-notes/screenshots/captures locations
 *   are frozen into the manifest (_System/pkb.json) so that later heuristics
 *   (e.g. "does the legacy Stickies folder have notes") cannot silently shift
 *   behaviour after the fact.
 * - A missing manifest uses the legacy layout. Invalid manifests block
 *   routing rather than silently writing into a different directory.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MANIFEST_RELATIVE = "_System/pkb.json";
const SCHEMA_VERSION = 1;

const LEGACY_QUICK_NOTES = "Journal/Stickies";
const LEGACY_SCREENSHOTS = "Inbox/Screenshots";
const LEGACY_CAPTURES = "Inbox/Captures";

const NEW_QUICK_NOTES = "00_Inbox/quick-notes";
const NEW_CAPTURES = "00_Inbox/captures";

const NOTE_TYPES = ["note", "daily", "meeting", "person", "project"];

// Directories that, once a PKB manifest is active, must never be silently
// partially-synced: if any of them contain so much as one file, the sync
// agent must refuse the whole sync rather than excluding them quietly. They
// are only ever created empty by initialize().
const PROTECTED_DIRECTORIES = [
  "60_Health",
  "70_Finance",
  "80_Vault",
  "90_AI/92_Context",
  "90_AI/94_Datasets",
  "90_AI/95_Logs",
  "00_Inbox/ai-pending",
];

const SEARCH_RESULT_LIMIT = 100;
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB, avoid unbounded memory use
const SEARCH_SKIP_DIR_NAMES = new Set(["_system", "templates", "80_vault"]);

function toPosix(relativePath) {
  return String(relativePath).replaceAll("\\", "/");
}

function pkbYear() {
  return new Date().getFullYear();
}

/** Directories initialize() ensures exist (relative, posix-style). */
function pkbDirectories() {
  const year = pkbYear();
  return [
    "00_Inbox/quick-notes",
    "00_Inbox/downloads",
    "00_Inbox/ai-pending",
    "00_Inbox/attachments",
    "00_Inbox/captures",
    `01_Journal/daily/${year}`,
    "01_Journal/weekly",
    "01_Journal/monthly",
    "01_Journal/yearly",
    "10_Self/11_Profile",
    "10_Self/12_Goals",
    "10_Self/13_Skills",
    "10_Self/14_Learning",
    "10_Self/15_Reflection",
    "20_Work/21_Career",
    "20_Work/22_Tasks/active",
    `20_Work/22_Tasks/done/${year}`,
    "20_Work/23_Projects/company",
    "20_Work/23_Projects/personal",
    "20_Work/24_Meetings",
    "20_Work/25_Org",
    "20_Work/26_Network",
    "30_Knowledge/topics",
    "30_Knowledge/references",
    "30_Knowledge/notes",
    "40_Life/41_Home",
    "40_Life/42_Family",
    "40_Life/43_Travel",
    "40_Life/44_Vehicles",
    "40_Life/45_Purchases",
    "40_Life/46_Hobbies",
    "50_Social/people",
    "50_Social/groups",
    "50_Social/events",
    "60_Health/medical-records",
    "60_Health/metrics",
    "60_Health/fitness",
    "60_Health/nutrition",
    "60_Health/mental",
    "70_Finance/budget",
    "70_Finance/accounts",
    "70_Finance/investments",
    "70_Finance/insurance",
    `70_Finance/tax/${year}`,
    "70_Finance/assets-liabilities",
    "80_Vault/identity",
    "80_Vault/legal",
    "80_Vault/credentials",
    "90_AI/91_Outputs/summaries",
    "90_AI/91_Outputs/insights",
    "90_AI/91_Outputs/digests",
    "90_AI/92_Context",
    "90_AI/93_Prompts",
    "90_AI/94_Datasets",
    "90_AI/95_Logs",
    "99_Archive",
    "_System/templates",
  ];
}

function yamlString(value) {
  return JSON.stringify(String(value ?? "").replace(/[\r\n]+/g, " "));
}

function frontmatter({ id, type, title, created, sensitivity }) {
  return [
    "---",
    `id: ${yamlString(id)}`,
    `type: ${yamlString(type)}`,
    `title: ${yamlString(title)}`,
    `created: ${yamlString(created)}`,
    `sensitivity: ${yamlString(sensitivity)}`,
    "---",
    "",
  ].join("\n");
}

function templateBody(type, title) {
  switch (type) {
    case "daily":
      return `# ${title}\n\n## 日志\n\n## 待办\n\n## 复盘\n`;
    case "meeting":
      return `# ${title}\n\n## 参会人\n\n## 议程\n\n## 记录\n\n## 行动项\n`;
    case "person":
      return `# ${title}\n\n## 关系\n\n## 联系方式\n\n## 备注\n`;
    case "project":
      return `# ${title}\n\n## 目标\n\n## 状态\n\n## 任务\n\n## 备注\n`;
    default:
      return `# ${title}\n\n`;
  }
}

/** Fixed "stable id" templates shipped under _System/templates. These keep a
 * constant uuid across installs so repeated init() calls never rewrite them
 * (initialize only creates them if missing) and so tests can assert on
 * deterministic ids. */
const TEMPLATE_IDS = {
  note: "00000000-0000-4000-8000-000000000001",
  daily: "00000000-0000-4000-8000-000000000002",
  meeting: "00000000-0000-4000-8000-000000000003",
  person: "00000000-0000-4000-8000-000000000004",
  project: "00000000-0000-4000-8000-000000000005",
};

function templateFile(type) {
  return `_System/templates/${type}.md`;
}

function systemDocFiles() {
  const dirList = pkbDirectories()
    .filter((d) => !d.startsWith("_System"))
    .map((d) => `- ${d}`)
    .join("\n");

  const indexMd = `# PKB 索引\n\n个人知识库（PKB）v1 的顶层分类说明。\n\n## 目录\n\n${dirList}\n\n模板位于 _System/templates/，命名与存储约定见 conventions.md，frontmatter 字段定义见 schema.md，存储与安全策略见 storage-policy.md。\n`;

  const conventionsMd = `# 命名与存储约定\n\n- 笔记文件使用 Markdown（.md），文件名包含标题，自动去除非法字符。\n- 日期类文件夹（daily/weekly/monthly/yearly、tax/<年份>）按年份归档。\n- 20_Work/22_Tasks/backlog.md 是待办索引说明，不独立维护任务状态。任务/项目的结构化数据仍沿用旧有 JSON 文件路径（Journal/task-module.json、Journal/zentask-projects.json），不随 PKB 迁移。\n- 00_Inbox 是唯一的"未分类"落脚点：quick-notes（速记迁移/新建）、downloads（外部下载）、ai-pending（AI 已生成、等待人工审核，见 storage-policy.md 的同步限制）、attachments（附件）、captures（截图与截图说明）。\n`;

  const schemaMd = `# 笔记元数据规范\n\n每篇由 createNote 生成的笔记带有如下 YAML frontmatter：\n\n\`\`\`yaml\n---\nid: "<uuid>"\ntype: "note|daily|meeting|person|project"\ntitle: "<标题>"\ncreated: "<ISO 8601 时间>"\nsensitivity: "normal|sensitive"\n---\n\`\`\`\n\n说明：\n\n- \`created\` 只在创建时写入一次。\n- 本系统**不**自动维护 \`updated\` 字段：常规的笔记编辑（workspace write）不会重写 frontmatter，所以这里不生成 \`updated\`，避免给出"最近修改时间"的错误印象。如果你需要修改追踪，请自行在正文里记录，或接入版本控制。\n- 旧笔记不会被批量转换为这个 schema，PKB 不会重写既有文件的 frontmatter。\n- 本模块不包含通用 YAML 解析器：frontmatter 只在生成笔记时写出，读取/搜索按纯文本处理，不解析字段。\n`;

  const protectedList = PROTECTED_DIRECTORIES.map((d) => `- ${d}`).join("\n");
  const storagePolicyMd = `# 存储与安全策略\n\n## 没有加密\n\nPKB 初始化**不提供也不声称任何加密**。80_Vault 不是加密保险库，只是身份证件/合同/密钥等条目的**索引占位目录**。真正敏感的原件（身份证照片、密码、私钥、合同扫描件等）应保存在受控的外部保险库（系统级加密磁盘、密码管理器的附件存储等），不要把原件直接放进本笔记库同步的目录。\n\n## 同步保护目录\n\n一旦 _System/pkb.json 中的 manifest 处于启用状态，以下目录被视为"受保护目录"。initialize() 只会把它们创建为空目录；如果其中任意一个目录（递归）包含任意文件，负责云同步的模块必须**整体拒绝本次同步**，不能静默排除这些目录后继续同步其余内容，以防止误删除或误覆盖：\n\n${protectedList}\n\n## AI 与云同步\n\n00_Inbox/ai-pending 用于临时存放AI 已生成、等待人工审核的内容，同样属于受保护目录：只要其中有文件，整库同步即被拒绝。\n\nsensitivity 是描述字段，目前同步不会解析该字段。保护目录之外的隐私笔记仍可能上传，不要仅依靠标签。请使用独立加密存储，不要将文件改放到同一同步库的其他目录来绕过保护。GitHub 不同步 pkb.json，每台设备都需要显式初始化；删除标记会失去保护。既有远端历史、备份及其他同步工具不在本策略保护范围内。\n`;

  return [
    { path: "_System/index.md", content: indexMd },
    { path: "_System/conventions.md", content: conventionsMd },
    { path: "_System/schema.md", content: schemaMd },
    { path: "_System/storage-policy.md", content: storagePolicyMd },
  ];
}

function templateFiles() {
  return NOTE_TYPES.map((type) => ({
    path: templateFile(type),
    content:
      frontmatter({
        id: TEMPLATE_IDS[type],
        type,
        title: "{{title}}",
        created: "{{created}}",
        sensitivity: "normal",
      }) + templateBody(type, "{{title}}"),
  }));
}

function extraFiles() {
  return [
    { path: "20_Work/22_Tasks/backlog.md", content: "# 待办索引\n\n请在 Zen Task 模块管理任务状态。本文件不是实时任务列表，Markdown 勾选框不会自动与任务 JSON 同步。\n" },
    ...templateFiles(),
    ...systemDocFiles(),
  ];
}

// ---------------------------------------------------------------------------
// Path safety (self-contained; mirrors workspace.js's resolveSafe but kept
// independent on purpose).
// ---------------------------------------------------------------------------

function assertNoSymlinkInPath(root, resolved) {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("笔记库根目录不能是符号链接");
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`路径包含符号链接，已拒绝：${path.relative(root, current)}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return; // nothing exists yet below this point; nothing left to check
    }
  }
}

function resolveSafe(root, relativePath = "") {
  const normalized = toPosix(relativePath).replace(/^\/+/, "");
  const resolved = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("非法路径：越界访问笔记库之外的目录");
  }
  assertNoSymlinkInPath(rootResolved, resolved);
  return resolved;
}

function writeAtomicNew(target, content) {
  // Only ever creates a brand-new file; never overwrites. Caller is expected
  // to have already checked existence, but "wx" enforces it at the OS level
  // too (defense in depth).
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.pkb-write-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(temporary, target);
  } catch (error) {
    if (error.code === "EEXIST") {
      fs.unlinkSync(temporary);
      throw new Error(`文件已存在，不会覆盖：${path.basename(target)}`);
    }
    fs.unlinkSync(temporary);
    throw error;
  }
  fs.unlinkSync(temporary);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function readManifest(root) {
  const manifestPath = path.join(root, MANIFEST_RELATIVE);
  let raw;
  try {
    assertNoSymlinkInPath(root, manifestPath);
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (data.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof data.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id)) return null;
  if (typeof data.created !== "string" || !Number.isFinite(Date.parse(data.created))) return null;
  if (!data.paths || typeof data.paths !== "object") return null;
  const { quickNotes, screenshots, captures } = data.paths;
  if (typeof quickNotes !== "string" || typeof screenshots !== "string" || typeof captures !== "string") {
    return null;
  }
  for (const location of [quickNotes, screenshots, captures]) {
    if (!location || path.posix.isAbsolute(location) || path.win32.isAbsolute(location) ||
        location.includes("\\") || location.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*\x00-\x1f]/.test(segment))) return null;
    try { resolveSafe(root, location); } catch { return null; }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Public: getPkbPaths
// ---------------------------------------------------------------------------

/**
 * Resolves the quick-notes / screenshots / captures directories for a vault,
 * relative to `root`. If a valid PKB manifest is active, its frozen `paths`
 * are authoritative (never recomputed from heuristics). Otherwise falls back
 * to the pre-PKB legacy layout only when no manifest exists. Invalid manifests block routing.
 */
function getPkbPaths(root) {
  const manifest = readManifest(root);
  if (manifest) {
    return {
      quickNotes: manifest.paths.quickNotes,
      screenshots: manifest.paths.screenshots,
      captures: manifest.paths.captures,
    };
  }
  try {
    fs.lstatSync(path.join(root, MANIFEST_RELATIVE));
    throw new Error("PKB 配置无效或路径不安全，请修复 _System/pkb.json 后继续；不会切回旧路径写入。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    quickNotes: LEGACY_QUICK_NOTES,
    screenshots: LEGACY_SCREENSHOTS,
    captures: LEGACY_CAPTURES,
  };
}

function hasLegacyQuickNotes(root) {
  const dir = path.join(root, LEGACY_QUICK_NOTES);
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    if (!fs.statSync(dir).isDirectory()) return false;
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return true;
        if (!entry.isDirectory() || !['随手记', '会议要点', '临时想法'].includes(entry.name)) return false;
        return fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })
          .some(child => child.isFile() && child.name.toLowerCase().endsWith('.md'));
      });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Preflight: plan directories/files, detect conflicts, without writing
// ---------------------------------------------------------------------------

function planDirectories(root) {
  const toCreate = [];
  const warnings = [];
  for (const relative of pkbDirectories()) {
    let resolved;
    try {
      resolved = resolveSafe(root, relative);
    } catch (error) {
      warnings.push(`${relative}：${error.message}`);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(resolved);
    } catch (error) {
      if (error.code === "ENOENT") {
        toCreate.push(relative);
        continue;
      }
      warnings.push(`${relative}：${error.message}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      warnings.push(`${relative}：已存在符号链接，拒绝初始化`);
    } else if (!stat.isDirectory()) {
      warnings.push(`${relative}：已存在同名文件而非目录，拒绝初始化`);
    }
    // else: directory already exists, nothing to do, not a conflict.
  }
  return { toCreate, warnings };
}

function planFiles(root) {
  const toCreate = [];
  const warnings = [];
  for (const file of extraFiles()) {
    let resolved;
    try {
      resolved = resolveSafe(root, file.path);
    } catch (error) {
      warnings.push(`${file.path}：${error.message}`);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(resolved);
    } catch (error) {
      if (error.code === "ENOENT") {
        toCreate.push(file);
        continue;
      }
      warnings.push(`${file.path}：${error.message}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      warnings.push(`${file.path}：已存在符号链接，拒绝初始化`);
    } else if (stat.isDirectory()) {
      warnings.push(`${file.path}：已存在同名目录而非文件，拒绝初始化`);
    }
    // else: file already exists -> leave untouched, not recreated, not a conflict.
  }
  return { toCreate, warnings };
}

function planManifest(root) {
  const resolved = path.join(root, MANIFEST_RELATIVE);
  const existingValid = readManifest(root);
  if (existingValid) return { toCreate: false, warnings: [] };
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) return { toCreate: false, warnings: [`${MANIFEST_RELATIVE}：已存在符号链接，拒绝初始化`] };
    if (stat.isDirectory()) return { toCreate: false, warnings: [`${MANIFEST_RELATIVE}：已存在同名目录而非文件，拒绝初始化`] };
    // A file exists there but failed manifest validation (corrupt/foreign).
    return { toCreate: false, warnings: [`${MANIFEST_RELATIVE}：已存在但内容无效，未被识别为 PKB manifest（不会覆盖，请手动检查）`] };
  } catch (error) {
    if (error.code === "ENOENT") return { toCreate: true, warnings: [] };
    return { toCreate: false, warnings: [`${MANIFEST_RELATIVE}：${error.message}`] };
  }
}

// ---------------------------------------------------------------------------
// createPkb(root)
// ---------------------------------------------------------------------------

function createPkb(root) {
  const resolvedRoot = path.resolve(root);

  function status() {
    const manifest = readManifest(resolvedRoot);
    if (!manifest) {
      const manifestPath = path.join(resolvedRoot, MANIFEST_RELATIVE);
      const warnings = [];
      if (fs.existsSync(manifestPath)) {
        warnings.push("存在 _System/pkb.json，但内容无效或版本不兼容，已视为未初始化（fail closed）。");
      }
      return warnings.length ? { initialized: false, warnings } : { initialized: false };
    }
    return {
      initialized: true,
      schemaVersion: manifest.schemaVersion,
      id: manifest.id,
      created: manifest.created,
      paths: { ...manifest.paths },
    };
  }

  function preview() {
    if (!fs.existsSync(resolvedRoot) || !fs.lstatSync(resolvedRoot).isDirectory()) {
      throw new Error("请先打开一个存在的本地笔记库目录。");
    }
    const directories = planDirectories(resolvedRoot);
    const files = planFiles(resolvedRoot);
    const manifestPlan = planManifest(resolvedRoot);
    const warnings = [...directories.warnings, ...files.warnings, ...manifestPlan.warnings];
    if (readManifest(resolvedRoot)) warnings.push("PKB 已初始化，preview 仅显示尚未存在的部分。");
    const fileList = files.toCreate.map((f) => f.path);
    if (manifestPlan.toCreate) fileList.push(MANIFEST_RELATIVE);
    return {
      directories: directories.toCreate,
      files: fileList,
      warnings,
    };
  }

  function initialize() {
    fs.mkdirSync(resolvedRoot, { recursive: true });
    if (fs.lstatSync(resolvedRoot).isSymbolicLink()) throw new Error("笔记库根目录不能是符号链接");

    const existing = readManifest(resolvedRoot);

    const directories = planDirectories(resolvedRoot);
    const files = planFiles(resolvedRoot);
    const manifestPlan = planManifest(resolvedRoot);
    const blocking = [...directories.warnings, ...files.warnings, ...manifestPlan.warnings];
    if (blocking.length) {
      throw new Error(`PKB 初始化被拒绝（配置/路径检查未通过）：\n${blocking.join("\n")}`);
    }

    for (const relative of directories.toCreate) {
      fs.mkdirSync(resolveSafe(resolvedRoot, relative), { recursive: true });
    }
    for (const file of files.toCreate) {
      writeAtomicNew(resolveSafe(resolvedRoot, file.path), file.content);
    }

    if (existing) return status();
    const useLegacyQuickNotes = hasLegacyQuickNotes(resolvedRoot);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      id: crypto.randomUUID(),
      created: new Date().toISOString(),
      paths: {
        quickNotes: useLegacyQuickNotes ? LEGACY_QUICK_NOTES : NEW_QUICK_NOTES,
        screenshots: "00_Inbox/attachments",
        captures: NEW_CAPTURES,
      },
    };
    writeAtomicNew(resolveSafe(resolvedRoot, MANIFEST_RELATIVE), `${JSON.stringify(manifest, null, 2)}\n`);

    return status();
  }

  function defaultParentFor(type) {
    switch (type) {
      case "daily":
        return `01_Journal/daily/${pkbYear()}`;
      case "meeting":
        return "20_Work/24_Meetings";
      case "person":
        return "50_Social/people";
      case "project":
        return "20_Work/23_Projects/personal";
      default:
        return "30_Knowledge/notes";
    }
  }

  function safeFileBaseName(title) {
    let value = String(title || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
    value = value.replace(/^\.+/, "").replace(/[. ]+$/, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
    return value || "未命名笔记";
  }

  function createNote({ type, title, parent } = {}) {
    if (!NOTE_TYPES.includes(type)) {
      throw new Error(`不支持的笔记类型：${type}，可选：${NOTE_TYPES.join(", ")}`);
    }
    if (!readManifest(resolvedRoot)) throw new Error("请先初始化有效的 PKB 笔记库。");
    const resolvedTitle = String(title || "").replace(/[\r\n\x00-\x1f]+/g, " ").trim().slice(0, 120) || "未命名笔记";
    const parentRelative = parent != null ? String(parent) : defaultParentFor(type);
    const parentAbsolute = resolveSafe(resolvedRoot, parentRelative);
    fs.mkdirSync(parentAbsolute, { recursive: true });

    const baseName = safeFileBaseName(resolvedTitle);
    let candidate = path.join(parentAbsolute, `${baseName}.md`);
    let index = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(parentAbsolute, `${baseName} ${index}.md`);
      index += 1;
    }

    const createdAt = new Date().toISOString();
    const templatePath = resolveSafe(resolvedRoot, templateFile(type));
    let body = templateBody(type, resolvedTitle);
    if (fs.existsSync(templatePath)) {
      if (!fs.statSync(templatePath).isFile() || fs.statSync(templatePath).size > SEARCH_MAX_FILE_BYTES) throw new Error("模板文件过大或不是普通文件。");
      body = fs.readFileSync(templatePath, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
        .replaceAll("{{title}}", resolvedTitle).replaceAll("{{created}}", createdAt);
    }
    const content =
      frontmatter({
        id: crypto.randomUUID(),
        type,
        title: resolvedTitle,
        created: createdAt,
        sensitivity: type === "person" ? "sensitive" : "normal",
      }) + body;

    writeAtomicNew(candidate, content);
    return { path: path.relative(resolvedRoot, candidate).replaceAll("\\", "/") };
  }

  function extractTitle(content, fallback) {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : fallback;
  }

  function buildSnippet(content, query) {
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerContent.indexOf(lowerQuery);
    if (index === -1) return content.slice(0, 80).replace(/\s+/g, " ").trim();
    const start = Math.max(0, index - 40);
    const end = Math.min(content.length, index + lowerQuery.length + 40);
    return content.slice(start, end).replace(/\s+/g, " ").trim();
  }

  function search(query) {
    const q = String(query || "").trim();
    const results = [];
    if (!q) return results;
    let skipped = 0;

    function visit(directory) {
      if (results.length >= SEARCH_RESULT_LIMIT) return;
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= SEARCH_RESULT_LIMIT) return;
        if (entry.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        if (entry.name.startsWith(".")) {
          skipped += 1;
          continue;
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (SEARCH_SKIP_DIR_NAMES.has(entry.name.toLowerCase())) {
            skipped += 1;
            continue;
          }
          visit(absolute);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;

        let stat;
        try {
          stat = fs.statSync(absolute);
        } catch {
          skipped += 1;
          continue;
        }
        if (stat.size > SEARCH_MAX_FILE_BYTES) {
          skipped += 1;
          continue;
        }

        const relative = path.relative(resolvedRoot, absolute).replaceAll("\\", "/");
        const nameMatches = entry.name.toLowerCase().includes(q.toLowerCase());
        let content = "";
        try {
          content = fs.readFileSync(absolute, "utf8");
        } catch {
          skipped += 1;
          continue;
        }
        const contentMatches = content.toLowerCase().includes(q.toLowerCase());
        if (!nameMatches && !contentMatches) continue;

        const fallbackTitle = path.parse(entry.name).name;
        results.push({
          path: relative,
          title: extractTitle(content, fallbackTitle),
          snippet: contentMatches ? buildSnippet(content, q) : fallbackTitle,
        });
      }
    }

    visit(resolvedRoot);
    Object.defineProperty(results, "skipped", { value: skipped, enumerable: false });
    return results;
  }

  return { root: resolvedRoot, status, preview, initialize, createNote, search };
}

module.exports = {
  createPkb,
  getPkbPaths,
  PROTECTED_DIRECTORIES,
  NOTE_TYPES,
  MANIFEST_RELATIVE,
};
