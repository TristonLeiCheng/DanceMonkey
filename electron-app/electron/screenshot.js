const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Blob } = require("node:buffer");
const { pathToFileURL } = require("node:url");
const { clipboard, ClipboardItem, desktopCapturer, nativeImage, screen, systemPreferences } = require("electron");
const { getPkbPaths } = require("./pkb");

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function resolveScreenshotsDir(notesRoot) {
  // Resolved fresh on every call (never cached) so that initializing a PKB
  // manifest mid-session immediately redirects screenshots to the new
  // location, even if this notesRoot was captured in a closure earlier.
  const dir = path.join(notesRoot, getPkbPaths(notesRoot).screenshots);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveCapturesDir(notesRoot) {
  const dir = path.join(notesRoot, getPkbPaths(notesRoot).captures);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function toFileUrl(filePath) {
  return pathToFileURL(path.resolve(filePath)).href;
}

async function copyImageToClipboard(image, png = image.toPNG()) {
  // Electron 44 replaces writeImage with the asynchronous, MIME-based API.
  if (typeof ClipboardItem === "function" && typeof clipboard.write === "function") {
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) }),
    ]);
  } else if (typeof clipboard.writeImage === "function") {
    await clipboard.writeImage(image);
  } else {
    throw new Error("当前运行环境不支持复制图片。");
  }
}

async function savePngAndClipboard(image, notesRoot, prefix = "DM") {
  const dir = resolveScreenshotsDir(notesRoot);
  const filePath = path.join(dir, `${prefix}_${stamp()}.png`);
  const png = image.toPNG();
  await copyImageToClipboard(image, png);
  await fsp.writeFile(filePath, png);
  return filePath;
}

/** 剪贴板和磁盘写入均完成后才返回成功。保留原有调用入口。 */
async function savePngAndClipboardFast(image, notesRoot, prefix = "DM") {
  return savePngAndClipboard(image, notesRoot, prefix);
}

function displayUnderCursor() {
  const point = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point);
}

function screenPermission() {
  return process.platform === 'darwin' ? systemPreferences?.getMediaAccessStatus('screen') || 'unknown' : 'granted';
}
function permissionError() {
  const error = new Error('macOS 未允许 DM 录制屏幕。请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许 DanceMonkey，然后完全退出并重新打开应用。');
  error.code = 'SCREEN_PERMISSION'; return error;
}
async function captureSources(options) {
  if (['denied', 'restricted'].includes(screenPermission())) throw permissionError();
  let timer;
  try {
    return await Promise.race([
      desktopCapturer.getSources(options),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('获取屏幕画面超时。请检查屏幕录制权限，或重新启动应用后再试。')), 15000); timer.unref?.(); }),
    ]);
  } catch (error) {
    if (process.platform === 'darwin' && screenPermission() !== 'granted' && screenPermission() !== 'unknown') throw permissionError();
    throw error;
  } finally { clearTimeout(timer); }
}

async function captureDisplayImage(display = displayUnderCursor()) {
  const scale = display.scaleFactor || 1;
  const width = Math.max(1, Math.round(display.size.width * scale));
  const height = Math.max(1, Math.round(display.size.height * scale));
  const sources = await captureSources({
    types: ["screen"],
    thumbnailSize: { width, height },
  });
  if (!sources.length) throw new Error("无法获取屏幕画面。");

  const byId = sources.find((source) => String(source.display_id) === String(display.id));
  const bySize = sources.find((source) => {
    const size = source.thumbnail.getSize();
    return size.width === width && size.height === height;
  });
  const source = byId || bySize || sources[0];
  const image = source.thumbnail;
  if (!image || image.isEmpty()) throw new Error("截屏结果为空。");
  return { image, display, scale };
}

function cropImage(image, rect, scale = 1) {
  const bounds = {
    x: Math.max(0, Math.round(rect.x * scale)),
    y: Math.max(0, Math.round(rect.y * scale)),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
  const size = image.getSize();
  bounds.width = Math.min(bounds.width, size.width - bounds.x);
  bounds.height = Math.min(bounds.height, size.height - bounds.y);
  if (bounds.width <= 0 || bounds.height <= 0) throw new Error("截取区域无效。");
  return image.crop(bounds);
}

function saveScreenshotAsNote(pngSourcePath, notesRoot) {
  if (!fs.existsSync(pngSourcePath)) throw new Error("图片文件不存在。");
  const shotsDir = resolveScreenshotsDir(notesRoot);
  const capturesDir = resolveCapturesDir(notesRoot);

  const noteStamp = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tag = `${noteStamp.getFullYear()}${pad(noteStamp.getMonth() + 1)}${pad(noteStamp.getDate())}-${pad(noteStamp.getHours())}${pad(noteStamp.getMinutes())}${pad(noteStamp.getSeconds())}`;
  const imgName = `screenshot-${tag}.png`;
  const destImg = path.join(shotsDir, imgName);
  if (path.resolve(pngSourcePath) !== path.resolve(destImg)) {
    fs.copyFileSync(pngSourcePath, destImg);
  }

  const mdName = `capture-${tag}.md`;
  const mdPath = path.join(capturesDir, mdName);
  const relImg = path.relative(capturesDir, destImg).replaceAll("\\", "/");
  const title = `${noteStamp.getFullYear()}-${pad(noteStamp.getMonth() + 1)}-${pad(noteStamp.getDate())} ${pad(noteStamp.getHours())}:${pad(noteStamp.getMinutes())}`;
  fs.writeFileSync(mdPath, `# 截图 ${title}\n\n![截图](${relImg})\n`, "utf8");
  return {
    imagePath: destImg,
    notePath: mdPath,
    relativeNotePath: path.relative(notesRoot, mdPath).replaceAll("\\", "/"),
  };
}

function readImageAsDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function loadNativeImage(filePath) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error("无法读取截图。");
  return image;
}

function watermarkMeta() {
  let username = "";
  try {
    username = os.userInfo().username || "";
  } catch {
    username = process.env.USERNAME || process.env.USER || "";
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return {
    timestamp,
    hostname: os.hostname() || "",
    username,
    account: process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${username}`
      : username,
  };
}

async function saveEditedPng(base64OrDataUrl, notesRoot, prefix = "DM_edit") {
  const raw = String(base64OrDataUrl || "");
  const base64 = raw.includes(",") ? raw.split(",")[1] : raw;
  const buffer = Buffer.from(base64, "base64");
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error("编辑结果无效。");
  return savePngAndClipboard(image, notesRoot, prefix);
}

module.exports = {
  captureDisplayImage,
  screenPermission,
  copyImageToClipboard,
  cropImage,
  displayUnderCursor,
  loadNativeImage,
  readImageAsDataUrl,
  savePngAndClipboard,
  savePngAndClipboardFast,
  saveScreenshotAsNote,
  saveEditedPng,
  resolveScreenshotsDir,
  resolveCapturesDir,
  toFileUrl,
  watermarkMeta,
};
