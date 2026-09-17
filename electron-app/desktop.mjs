import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = 5173;

// 记录上次是否被迫软件渲染，下次直接跳过注定失败的硬件渲染尝试。
// 标记写在本地临时目录，避免项目位于网络盘时被多台机器共用。
const renderFlagFile = path.join(os.tmpdir(), "lumen-software-render.flag");

// 网络盘上的子进程沙箱无法初始化，GPU 进程必定启动失败
function onNetworkDrive() {
  try {
    return /^\\\\/.test(fs.realpathSync.native(process.cwd()));
  } catch {
    return false;
  }
}

function portInUse() {
  return new Promise((resolve) => {
    const probe = net.connect({ host: "127.0.0.1", port: PORT });
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
}

function waitForServer(attempt = 0) {
  return portInUse().then((up) => {
    if (up) return true;
    if (attempt > 40) return false;
    return new Promise((r) => setTimeout(r, 100)).then(() => waitForServer(attempt + 1));
  });
}

const electronBinary = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

const reuse = await portInUse();
// 已有预览服务时直接复用，避免重复占用 5173
const server = reuse
  ? null
  : spawn(process.execPath, ["server.mjs"], { cwd: process.cwd(), stdio: "inherit" });

if (!(await waitForServer())) {
  console.error(`预览服务未能在 127.0.0.1:${PORT} 启动。`);
  server?.kill();
  process.exit(1);
}

let child = null;

// 透传附加参数，便于排查时挂上 --remote-debugging-port 等开关
const extraArgs = process.argv.slice(2);

function launch(softwareRender) {
  const args = softwareRender
    ? [".", "--lumen-software-render", ...extraArgs]
    : [".", ...extraArgs];
  const startedAt = Date.now();

  child = spawn(electronBinary, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code) => {
    // GPU 进程不可用时 Electron 会立刻致命退出，这里自动降级重试一次
    const crashedEarly = code !== 0 && Date.now() - startedAt < 20000;
    if (crashedEarly && !softwareRender) {
      console.warn("GPU 进程不可用，改用软件渲染重新启动。");
      try {
        fs.writeFileSync(renderFlagFile, "1");
      } catch {}
      launch(true);
      return;
    }
    server?.kill();
    process.exit(code ?? 0);
  });

  child.on("error", () => {
    server?.kill();
    console.error("未找到 Electron，请先运行 npm install。");
    process.exit(1);
  });
}

const forceSoftwareRender =
  process.env.LUMEN_SOFTWARE_RENDER === "1" ||
  onNetworkDrive() ||
  fs.existsSync(renderFlagFile);

if (forceSoftwareRender) {
  console.log("当前环境不支持 GPU 加速，使用软件渲染启动。");
}

launch(forceSoftwareRender);

function shutdown() {
  server?.kill();
  child?.kill();
  process.exit();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
