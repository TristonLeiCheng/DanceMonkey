const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const INTERNET_SETTINGS = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function clampMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(60, Math.max(1, Math.round(n)));
}

function buildApplyScript(config) {
  const mode = String(config.proxyForceMode || "manual").trim().toLowerCase();
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `$path = '${INTERNET_SETTINGS}'`,
  ];

  if (mode === "pac") {
    const pac = String(config.proxyPacUrl || "").trim().replace(/'/g, "''");
    if (!/^https?:\/\//i.test(pac)) {
      throw new Error("PAC 地址无效，请填写 http/https 开头的完整地址。");
    }
    lines.push(
      `Set-ItemProperty -Path $path -Name ProxyEnable -Value 0 -Type DWord`,
      `Set-ItemProperty -Path $path -Name AutoDetect -Value 0 -Type DWord`,
      `Set-ItemProperty -Path $path -Name AutoConfigURL -Value '${pac}' -Type String`,
    );
  } else {
    const host = String(config.proxyServer || "").trim().replace(/'/g, "''");
    const port = Number(config.proxyPort);
    const bypass = String(config.proxyBypass || "").trim().replace(/'/g, "''");
    if (!host) throw new Error("手动代理地址不能为空。");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("手动代理端口必须在 1-65535 之间。");
    }
    lines.push(
      `Set-ItemProperty -Path $path -Name AutoConfigURL -Value '' -Type String`,
      `Set-ItemProperty -Path $path -Name AutoDetect -Value 0 -Type DWord`,
      `Set-ItemProperty -Path $path -Name ProxyEnable -Value 1 -Type DWord`,
      `Set-ItemProperty -Path $path -Name ProxyServer -Value '${host}:${port}' -Type String`,
      `Set-ItemProperty -Path $path -Name ProxyOverride -Value '${bypass}' -Type String`,
    );
  }

  lines.push(
    `$def = @'`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public static class WinINet {`,
    `  [DllImport("wininet.dll", SetLastError=true)]`,
    `  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);`,
    `}`,
    `'@`,
    `Add-Type -TypeDefinition $def -ErrorAction SilentlyContinue | Out-Null`,
    `[WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null`,
    `[WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null`,
    `Write-Output 'OK'`,
  );

  return lines.join("\r\n");
}

async function runPowerShell(script) {
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function createProxyEnforcement() {
  let timer = null;
  let active = null;

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function applyNow(config) {
    const script = buildApplyScript(config);
    const result = await runPowerShell(script);
    if (!/OK/.test(result.stdout)) {
      throw new Error(result.stderr || "写入系统代理失败");
    }
    return true;
  }

  async function startOrUpdate(config) {
    stop();
    active = { ...config };
    if (!config?.proxyForceEnabled) return { enabled: false };

    await applyNow(config);
    const minutes = clampMinutes(config.proxyRefreshMinutes);
    timer = setInterval(() => {
      if (!active?.proxyForceEnabled) return;
      void applyNow(active).catch((error) => {
        console.warn("proxy refresh failed", error?.message || error);
      });
    }, minutes * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
    return { enabled: true, minutes };
  }

  return { startOrUpdate, applyNow, stop };
}

module.exports = { createProxyEnforcement, clampMinutes };
