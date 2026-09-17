const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DETECT_TTL_MS = 5 * 60 * 1000;

function loadDefaultLinks() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "default-quick-links.json"), "utf8"),
    );
  } catch {
    return [];
  }
}

function isLikelyLocalPath(target) {
  const value = String(target || "");
  if (!value || /^https?:\/\//i.test(value)) return false;
  if (value.startsWith("\\\\")) return false;
  return /^[a-zA-Z]:\\/.test(value);
}

function pathExistsFast(target, category = "") {
  if (!target) return false;
  if (/^https?:\/\//i.test(target)) return true;
  // 离线映射盘 / UNC 的 existsSync 可能阻塞主进程数十秒
  if (category === "network" || String(target).startsWith("\\\\")) return true;
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

async function runPowerShell(script, timeout = 4000) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
  );
  return String(stdout || "").trim();
}

async function readOneDriveFromRegistry() {
  try {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$root='HKCU:\\Software\\Microsoft\\OneDrive\\Accounts'
if (-not (Test-Path $root)) { '[]'; exit 0 }
$items=@()
Get-ChildItem $root | ForEach-Object {
  $folder = (Get-ItemProperty $_.PSPath -Name UserFolder -ErrorAction SilentlyContinue).UserFolder
  $name = (Get-ItemProperty $_.PSPath -Name DisplayName -ErrorAction SilentlyContinue).DisplayName
  if ($folder) {
    $items += [pscustomobject]@{ folder=$folder; name=($(if($name){$name}else{$_.PSChildName})) }
  }
}
if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }
`;
    const out = await runPowerShell(script, 4000);
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function detectNetworkDrives() {
  try {
    // 只用 Get-PSDrive 的 DisplayRoot，避免对每个盘跑 Get-CimInstance（很慢且易卡）
    const script = `
$ErrorActionPreference='SilentlyContinue'
Get-PSDrive -PSProvider FileSystem |
  Where-Object { $_.DisplayRoot -like '\\\\*' } |
  ForEach-Object {
    [pscustomobject]@{
      root = $_.Root
      label = $(if ($_.Description) { $_.Description } else { '网络驱动器' })
    }
  } | ConvertTo-Json -Compress
`;
    const out = await runPowerShell(script, 4000);
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function createQuickAccessService(configStore, electronShell, knownPaths) {
  let cachedDetected = null;
  let cachedAt = 0;
  let detectPromise = null;

  function ensureDefaults() {
    const config = configStore.read();
    const links = Array.isArray(config.quickLinks) ? config.quickLinks : [];
    if (links.length > 0 || config.quickLinksSeeded) return;
    const defaults = loadDefaultLinks();
    if (!defaults.length) return;
    configStore.write({ quickLinks: defaults, quickLinksSeeded: true });
  }

  function buildFastDetected() {
    const candidates = [];
    const profile = os.homedir();
    const push = (name, target, category) => {
      if (target) candidates.push([name, target, category]);
    };

    push("桌面", knownPaths.desktop, "local");
    push("文档", knownPaths.documents, "local");
    push("下载", knownPaths.downloads, "local");
    push("OneDrive", process.env.OneDrive, "onedrive");
    push("OneDrive 企业版", process.env.OneDriveCommercial, "onedrive");

    for (const name of ["OneDrive", "OneDrive - Personal"]) {
      push(name, path.join(profile, name), "onedrive");
    }
    try {
      for (const dir of fs.readdirSync(profile, { withFileTypes: true })) {
        if (dir.isDirectory() && dir.name.startsWith("OneDrive - ")) {
          push(dir.name, path.join(profile, dir.name), "onedrive");
        }
      }
    } catch {}

    return finalizeDetected(candidates);
  }

  function finalizeDetected(candidates) {
    const seen = new Set();
    return candidates
      .filter(([, target, category]) => target && pathExistsFast(target, category))
      .filter(([, target]) => {
        let key;
        try {
          key = isLikelyLocalPath(target)
            ? path.resolve(target).toLowerCase()
            : String(target).toLowerCase();
        } catch {
          key = String(target).toLowerCase();
        }
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(([name, target, category], index) => ({
        id: `detected-${index}`,
        name,
        path: target,
        category,
        description: "",
        group: "",
        clickCount: 0,
        lastClicked: null,
        pinned: false,
        detected: true,
      }));
  }

  async function buildFullDetected() {
    const candidates = [];
    const profile = os.homedir();
    const push = (name, target, category) => {
      if (target) candidates.push([name, target, category]);
    };

    push("桌面", knownPaths.desktop, "local");
    push("文档", knownPaths.documents, "local");
    push("下载", knownPaths.downloads, "local");
    push("OneDrive", process.env.OneDrive, "onedrive");
    push("OneDrive 企业版", process.env.OneDriveCommercial, "onedrive");
    for (const name of ["OneDrive", "OneDrive - Personal"]) {
      push(name, path.join(profile, name), "onedrive");
    }
    try {
      for (const dir of fs.readdirSync(profile, { withFileTypes: true })) {
        if (dir.isDirectory() && dir.name.startsWith("OneDrive - ")) {
          push(dir.name, path.join(profile, dir.name), "onedrive");
        }
      }
    } catch {}

    const [registryItems, drives] = await Promise.all([
      readOneDriveFromRegistry(),
      detectNetworkDrives(),
    ]);
    for (const item of registryItems) {
      if (item?.folder) push(`OneDrive - ${item.name || "Business"}`, item.folder, "onedrive");
    }
    for (const drive of drives) {
      if (drive?.root) {
        const letter = String(drive.root).replace(/\\+$/, "");
        push(`${drive.label || "网络驱动器"} (${letter})`, drive.root, "network");
      }
    }
    return finalizeDetected(candidates);
  }

  function scheduleBackgroundDetect(force = false) {
    if (detectPromise) return detectPromise;
    if (!force && cachedDetected && Date.now() - cachedAt < DETECT_TTL_MS) {
      return Promise.resolve(cachedDetected);
    }
    detectPromise = buildFullDetected()
      .then((entries) => {
        cachedDetected = entries;
        cachedAt = Date.now();
        return entries;
      })
      .catch(() => cachedDetected || buildFastDetected())
      .finally(() => {
        detectPromise = null;
      });
    return detectPromise;
  }

  function detectedEntries() {
    if (cachedDetected) return cachedDetected;
    cachedDetected = buildFastDetected();
    cachedAt = Date.now();
    // 后台补全注册表 OneDrive / 网络盘，不阻塞本次 IPC
    void scheduleBackgroundDetect(true);
    return cachedDetected;
  }

  function customEntries() {
    ensureDefaults();
    const links = configStore.read().quickLinks || [];
    return links.map((item, index) => ({
      id: `custom-${index}`,
      name: item.name || "",
      path: item.path || "",
      category: item.category || "local",
      description: item.description || "",
      group: item.group || "",
      clickCount: Number(item.clickCount) || 0,
      lastClicked: item.lastClicked || null,
      pinned: Boolean(item.pinned),
      detected: false,
    }));
  }

  function list() {
    return [...detectedEntries(), ...customEntries()];
  }

  function parseIndex(id) {
    const match = /^custom-(\d+)$/.exec(String(id));
    if (!match) throw new Error("系统检测的快捷入口不能修改");
    return Number(match[1]);
  }

  function findEntry(id) {
    return list().find((item) => item.id === id);
  }

  function add(input) {
    const name = String(input.name || "").trim();
    const target = String(input.path || "").trim();
    if (!name || !target) throw new Error("名称和路径不能为空");
    const config = configStore.read();
    const links = Array.isArray(config.quickLinks) ? [...config.quickLinks] : [];
    links.push({
      name,
      path: target,
      category: input.category || "local",
      description: String(input.description || "").trim(),
      group: String(input.group || "").trim(),
      clickCount: 0,
      lastClicked: null,
      pinned: false,
    });
    configStore.write({ quickLinks: links, quickLinksSeeded: true });
    return list();
  }

  function update(id, input) {
    const index = parseIndex(id);
    const config = configStore.read();
    const links = [...(config.quickLinks || [])];
    if (!links[index]) throw new Error("快捷入口不存在");
    links[index] = {
      ...links[index],
      name: String(input.name || "").trim(),
      path: String(input.path || "").trim(),
      category: input.category || "local",
      description: String(input.description || "").trim(),
      group: String(input.group || "").trim(),
    };
    configStore.write({ quickLinks: links });
    return list();
  }

  function remove(id) {
    const index = parseIndex(id);
    const config = configStore.read();
    const links = [...(config.quickLinks || [])];
    links.splice(index, 1);
    configStore.write({ quickLinks: links });
    return list();
  }

  function togglePin(id) {
    const index = parseIndex(id);
    const config = configStore.read();
    const links = [...(config.quickLinks || [])];
    if (!links[index]) throw new Error("快捷入口不存在");
    links[index] = { ...links[index], pinned: !links[index].pinned };
    configStore.write({ quickLinks: links });
    return list();
  }

  async function open(id) {
    const entry = findEntry(id);
    if (!entry) throw new Error("快捷入口不存在");
    if (/^https?:\/\//i.test(entry.path)) await electronShell.openExternal(entry.path);
    else {
      const error = await electronShell.openPath(entry.path);
      if (error) throw new Error(error);
    }
    if (!entry.detected) {
      const index = parseIndex(id);
      const config = configStore.read();
      const links = [...(config.quickLinks || [])];
      links[index] = {
        ...links[index],
        clickCount: (Number(links[index].clickCount) || 0) + 1,
        lastClicked: new Date().toISOString(),
      };
      configStore.write({ quickLinks: links });
    }
    return list();
  }

  async function refresh() {
    cachedDetected = null;
    cachedAt = 0;
    cachedDetected = await scheduleBackgroundDetect(true);
    cachedAt = Date.now();
    return list();
  }

  // 启动后稍后后台探测，避免抢启动路径
  setTimeout(() => {
    void scheduleBackgroundDetect(true);
  }, 1500).unref?.();

  return { list, add, update, remove, togglePin, open, refresh };
}

module.exports = { createQuickAccessService };
