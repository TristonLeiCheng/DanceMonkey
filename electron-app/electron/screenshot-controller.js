const path = require("node:path");
const { BrowserWindow, clipboard, screen } = require("electron");
const {
  captureDisplayImage,
  cropImage,
  loadNativeImage,
  readImageAsDataUrl,
  savePngAndClipboard,
  saveScreenshotAsNote,
} = require("./screenshot");

function createScreenshotController({
  getNotesRoot,
  aiService,
  store,
  getOverlay,
  getWorkspaceWindow,
  openWorkspace,
  applyShell,
  isDev,
}) {
  let regionWindow = null;
  let resultWindow = null;
  let currentImagePath = "";
  let pendingRegion = null;

  function uiUrl(fileName) {
    const filePath = path.join(__dirname, "ui", fileName);
    return `file://${filePath.replaceAll("\\", "/")}`;
  }

  function hideAppWindows() {
    const hidden = [];
    const overlay = getOverlay?.();
    const workspace = getWorkspaceWindow?.();
    for (const win of [overlay, workspace, resultWindow]) {
      if (win && !win.isDestroyed() && win.isVisible()) {
        win.hide();
        hidden.push(win);
      }
    }
    return hidden;
  }

  function restoreWindows(hidden) {
    for (const win of hidden) {
      if (win && !win.isDestroyed()) win.show();
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function closeResultWindow() {
    if (resultWindow && !resultWindow.isDestroyed()) resultWindow.close();
    resultWindow = null;
  }

  function openResultWindow(imagePath, { autoAnalyze = false } = {}) {
    closeResultWindow();
    currentImagePath = imagePath;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(720, display.workArea.width - 40);
    const height = Math.min(640, display.workArea.height - 40);
    resultWindow = new BrowserWindow({
      width,
      height,
      minWidth: 420,
      minHeight: 360,
      frame: false,
      transparent: true,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      resizable: true,
      webPreferences: {
        preload: path.join(__dirname, "ui-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    resultWindow.loadURL(uiUrl("screenshot-result.html"));
    resultWindow.once("ready-to-show", () => {
      resultWindow.show();
      resultWindow.focus();
      resultWindow.webContents.send("screenshot-result:init", {
        imagePath,
        dataUrl: readImageAsDataUrl(imagePath),
        fileName: path.basename(imagePath),
        autoAnalyze,
      });
    });
    resultWindow.on("closed", () => {
      resultWindow = null;
      currentImagePath = "";
    });
  }

  async function captureQuick() {
    const hidden = hideAppWindows();
    try {
      await delay(120);
      const { image } = await captureDisplayImage();
      const filePath = savePngAndClipboard(image, getNotesRoot(), "DM");
      restoreWindows(hidden);
      openResultWindow(filePath);
      return { success: true, path: filePath };
    } catch (error) {
      restoreWindows(hidden);
      return { success: false, error: error?.message || "截屏失败" };
    }
  }

  async function beginRegionCapture() {
    if (regionWindow && !regionWindow.isDestroyed()) {
      regionWindow.focus();
      return { success: true };
    }

    const hidden = hideAppWindows();
    try {
      await delay(120);
      const { image, display, scale } = await captureDisplayImage();
      const dataUrl = image.toDataURL();
      pendingRegion = { image, display, scale, hidden };

      regionWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: false,
        resizable: false,
        movable: false,
        fullscreen: false,
        simpleFullscreen: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "ui-preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      regionWindow.setMenuBarVisibility(false);
      regionWindow.loadURL(uiUrl("region-capture.html"));
      regionWindow.once("ready-to-show", () => {
        regionWindow.setBounds(display.bounds);
        regionWindow.show();
        regionWindow.focus();
        regionWindow.webContents.send("region:image", dataUrl);
      });
      regionWindow.on("closed", () => {
        regionWindow = null;
        if (pendingRegion?.hidden) restoreWindows(pendingRegion.hidden);
        pendingRegion = null;
      });
      return { success: true };
    } catch (error) {
      restoreWindows(hidden);
      pendingRegion = null;
      return { success: false, error: error?.message || "框选截屏失败" };
    }
  }

  async function finishRegionCapture(payload = {}) {
    const action = payload.action || "cancel";
    const rect = payload.rect;
    const context = pendingRegion;
    const win = regionWindow;
    pendingRegion = null;
    regionWindow = null;

    if (win && !win.isDestroyed()) {
      win.hide();
      win.destroy();
    }

    if (!context) return;
    restoreWindows(context.hidden);

    if (action === "cancel" || !rect) return;

    try {
      const cropped = cropImage(context.image, rect, context.scale);
      const filePath = savePngAndClipboard(cropped, getNotesRoot(), "DM_region");
      openResultWindow(filePath, { autoAnalyze: action === "ai" });
    } catch (error) {
      console.error("region crop failed", error);
    }
  }

  async function copyCurrent() {
    try {
      const image = loadNativeImage(currentImagePath);
      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || "复制失败" };
    }
  }

  async function saveCurrentNote() {
    try {
      const result = saveScreenshotAsNote(currentImagePath, getNotesRoot());
      openWorkspace?.("notes");
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error?.message || "保存笔记失败" };
    }
  }

  async function analyzeCurrent() {
    try {
      const text = await aiService.analyzeImage({ imagePath: currentImagePath });
      return { success: true, text, html: markdownToSafeHtml(text) };
    } catch (error) {
      return { success: false, error: error?.message || "AI 分析失败" };
    }
  }

  function markdownToSafeHtml(markdown) {
    try {
      const { marked } = require("marked");
      const raw = marked.parse(String(markdown || ""), { async: false });
      // result window is trusted local UI; keep a minimal sanitizer
      return String(raw);
    } catch {
      const escaped = String(markdown || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escaped}</pre>`;
    }
  }

  function continueWithAnalysis(markdown) {
    const analysis = String(markdown || "").trim();
    if (!analysis) return;
    const current = store.get();
    const nextMessages = [
      ...(current.aiMessages || []),
      {
        role: "assistant",
        content: `【截图分析结果】\n\n${analysis}`,
      },
    ];
    const next = store.set({ aiMessages: nextMessages });
    closeResultWindow();
    applyShell?.("panel");
    const overlay = getOverlay?.();
    const workspace = getWorkspaceWindow?.();
    for (const win of [overlay, workspace]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send("store:updated", next);
      }
    }
    if (overlay && !overlay.isDestroyed()) {
      overlay.show();
      overlay.focus();
      overlay.webContents.send("screenshot:follow-up");
    }
  }

  return {
    captureQuick,
    beginRegionCapture,
    finishRegionCapture,
    copyCurrent,
    saveCurrentNote,
    analyzeCurrent,
    continueWithAnalysis,
    closeResultWindow,
  };
}

module.exports = { createScreenshotController };
