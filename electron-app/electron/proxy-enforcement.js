const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const { normalizeManualProxy } = require("./config-migration");
const KEYS = [
  "ProxyEnable",
  "ProxyServer",
  "ProxyOverride",
  "AutoConfigURL",
  "AutoDetect",
];
const clampMinutes = (value) =>
  Math.min(60, Math.max(1, Math.round(Number(value) || 3)));
const data = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (value) =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data(value)}')) | ConvertFrom-Json`;
const common = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$names = @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL','AutoDetect')
function Read-Snapshot {
  $item = Get-Item -Path $path
  $result = [ordered]@{}
  foreach ($name in $names) {
    $exists = $item.GetValueNames() -contains $name
    $value = $null
    $kind = $null
    if ($exists) { $value = $item.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind = $item.GetValueKind($name).ToString() }
    $result[$name] = @{ exists = $exists; value = $value; kind = $kind }
  }
  return $result
}
function Same-Value($a, $b) {
  return ($a.exists -eq $b.exists) -and ((-not $a.exists) -or ([string]$a.value -ceq [string]$b.value)) -and (($null -eq $a.kind) -or ($null -eq $b.kind) -or ($a.kind -eq $b.kind))
}
function Write-Snapshot($target) {
  foreach ($name in $names) {
    $entry = $target.$name
    if ($entry.exists) {
      $kind = $entry.kind
      if (-not $kind) { $kind = 'String'; if ($name -eq 'ProxyEnable' -or $name -eq 'AutoDetect') { $kind = 'DWord' } }
      Set-ItemProperty -Path $path -Name $name -Value $entry.value -Type $kind
    } elseif ($null -ne (Get-ItemProperty -Path $path).PSObject.Properties[$name]) {
      Remove-ItemProperty -Path $path -Name $name
    }
  }
  $def = @'
using System;
using System.Runtime.InteropServices;
public static class DMProxyNotify {
 [DllImport("wininet.dll", SetLastError=true)]
 public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length);
}
'@
  Add-Type -TypeDefinition $def -ErrorAction SilentlyContinue | Out-Null
  [DMProxyNotify]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null
  [DMProxyNotify]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null
}
`;
async function runPowerShell(script, { signal } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dm-proxy-"));
  const file = path.join(directory, "settings.ps1");
  try {
    fs.writeFileSync(file, "\ufeff" + script, { mode: 0o600 });
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        file,
      ],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024, signal },
    );
    return JSON.parse(String(stdout).trim());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function createWindowsProxyBackend(run = runPowerShell) {
  let pending = null;
  async function invoke(script) {
    const controller = new AbortController();
    pending = controller;
    try {
      return await run(script, { signal: controller.signal });
    } finally {
      if (pending === controller) pending = null;
    }
  }
  return {
    cancel: () => pending?.abort(),
    read: () =>
      invoke(common + "\nRead-Snapshot | ConvertTo-Json -Depth 6 -Compress"),
    apply: (target) =>
      invoke(
        common +
          `\n$target = ${decode(target)}\nWrite-Snapshot $target\n@{ applied = $true } | ConvertTo-Json -Compress`,
      ),
    restore: (before, applied) =>
      invoke(
        common +
          `
$before = ${decode(before)}
$applied = ${decode(applied)}
$current = Read-Snapshot
$owned = $true
foreach ($name in $names) {
 if (-not (Same-Value $current.$name $before.$name) -and -not (Same-Value $current.$name $applied.$name)) { $owned = $false }
}
if ($owned) { Write-Snapshot $before }
@{ restored = $owned } | ConvertTo-Json -Compress`,
      ),
  };
}
function desiredSnapshot(before, config) {
  const result = JSON.parse(JSON.stringify(before));
  const set = (key, value) =>
    (result[key] = {
      exists: true,
      value,
      kind: ["ProxyEnable", "AutoDetect"].includes(key) ? "DWord" : "String",
    });
  set("AutoDetect", 0);
  if (config.proxyForceMode === "pac") {
    const url = new URL(String(config.proxyPacUrl || "").trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("请填写有效的 HTTP/HTTPS PAC 地址。");
    set("ProxyEnable", 0);
    set("AutoConfigURL", url.href);
  } else {
    const parsed = normalizeManualProxy(config.proxyServer, config.proxyPort);
    const host = parsed.server,
      port = parsed.port;
    const normalized =
      host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    set("ProxyEnable", 1);
    set("ProxyServer", `${normalized}:${port}`);
    set("ProxyOverride", String(config.proxyBypass || "").trim());
    set("AutoConfigURL", "");
  }
  return result;
}
function validSnapshot(value) {
  return (
    value &&
    KEYS.every(
      (k) =>
        value[k] &&
        typeof value[k].exists === "boolean" &&
        (value[k].kind == null ||
          ["String", "ExpandString", "DWord", "QWord"].includes(
            value[k].kind,
          )) &&
        (!value[k].exists ||
          typeof value[k].value === "string" ||
          Number.isSafeInteger(value[k].value)),
    )
  );
}
function createProxyEnforcement({
  backend = createWindowsProxyBackend(),
  backupFile,
  timers = globalThis,
  onChanged = async () => {},
} = {}) {
  let timer = null,
    revision = 0,
    active = null,
    record = null,
    queue = Promise.resolve();
  const enqueue = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  function stopTimer() {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  }
  function load() {
    if (!backupFile) return record;
    try {
      const value = JSON.parse(fs.readFileSync(backupFile, "utf8"));
      if (
        value.format !== 1 ||
        !validSnapshot(value.before) ||
        !validSnapshot(value.applied)
      )
        throw Error("invalid");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw Error("代理恢复记录无法读取，请保留该记录并检查Windows代理设置。");
    }
  }
  function persist(value) {
    record = value;
    if (!backupFile) return;
    if (!value) {
      fs.rmSync(backupFile, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(backupFile), { recursive: true, mode: 0o700 });
    const temp = `${backupFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, backupFile);
  }
  async function notify() {
    try {
      await onChanged();
    } catch {
      console.warn(
        "系统代理已更新，但线路缓存刷新失败；请在网络设置中测试连接。",
      );
    }
  }
  async function restore() {
    const saved = load();
    if (!saved) return { enabled: false };
    let result;
    try {
      result = await backend.restore(saved.before, saved.applied);
    } catch {
      throw Error(
        "已停止自动维护，但未能恢复Windows系统代理。请打开系统代理设置检查；恢复记录已保留。",
      );
    }
    if (result.restored) persist(null);
    await notify();
    return {
      enabled: false,
      restored: result.restored,
      notice: result.restored
        ? "已停止自动维护，并恢复开启前的Windows代理。"
        : "已停止自动维护；系统代理已被其他软件修改，保留当前设置。",
    };
  }
  async function apply(config) {
    const existing = load(),
      current = await backend.read();
    if (!validSnapshot(current))
      throw Error(
        "Windows代理配置格式异常，未修改现有设置。请打开系统代理设置检查。",
      );
    const applied = desiredSnapshot(current, config);
    persist({ format: 1, before: existing?.before || current, applied });
    try {
      await backend.apply(applied);
      await notify();
    } catch {
      throw Error(
        "Windows系统代理未能完整应用，恢复记录已保留。请检查系统权限或打开Windows代理设置。",
      );
    }
  }
  function startOrUpdate(config) {
    const token = ++revision;
    stopTimer();
    active = { ...config };
    if (!config?.proxyForceEnabled) backend.cancel?.();
    return enqueue(async () => {
      if (token !== revision)
        return { enabled: Boolean(active?.proxyForceEnabled) };
      if (!config?.proxyForceEnabled) return restore();
      await apply(config);
      if (token === revision) {
        timer = timers.setInterval(
          () => {
            void enqueue(async () => {
              if (token === revision && active?.proxyForceEnabled)
                await apply(active);
            }).catch(() =>
              console.warn("Windows代理自动维护失败，请检查网络设置。"),
            );
          },
          clampMinutes(config.proxyRefreshMinutes) * 60000,
        );
        timer.unref?.();
      }
      return {
        enabled: token === revision,
        minutes: clampMinutes(config.proxyRefreshMinutes),
      };
    });
  }
  return {
    startOrUpdate,
    applyNow: (config) =>
      enqueue(async () => {
        if (!active?.proxyForceEnabled) throw Error("请先启用自动维护并保存。");
        await apply(config);
        return true;
      }),
    stop: () => {
      ++revision;
      active = null;
      stopTimer();
      backend.cancel?.();
      return enqueue(restore);
    },
  };
}
module.exports = {
  createProxyEnforcement,
  createWindowsProxyBackend,
  desiredSnapshot,
  clampMinutes,
};
