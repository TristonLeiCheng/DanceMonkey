const path = require("node:path");
const { BrowserWindow, clipboard, screen } = require("electron");
const { pathToFileURL } = require("node:url");
const {
  captureDisplayImage,
  cropImage,
  loadNativeImage,
  savePngAndClipboardFast,
  saveScreenshotAsNote,
  saveEditedPng,
  toFileUrl,
  watermarkMeta,
} = require("./screenshot");

function createScreenshotController({
  getNotesRoot,
  aiService,
  store,
  getOverlay,
  getWorkspaceWindow,
  openWorkspace,
  applyShell,
}) {
  let regionWindow = null;
  let choiceWindow = null;
  let editorWindow = null;
  let resultWindow = null;
  let currentImagePath = "";
  let pendingRegion = null;
  let lastCaptureMode = "quick";

  function uiUrl(fileName) {
    const filePath = path.join(__dirname, "ui", fileName);
    return pathToFileURL(filePath).href;
  }

  function localUiPrefs() {
    return {
      preload: path.join(__dirname, "ui-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 本地截图 UI 需要加载 file:// 图片预览，关闭同源限制
      webSecurity: false,
    };
  }

  function hideAppWindows() {
    const hidden = [];
    const overlay = getOverlay?.();
    const workspace = getWorkspaceWindow?.();
    for (const win of [overlay, workspace, resultWindow, choiceWindow, editorWindow]) {
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

  function destroyWin(win) {
    if (win && !win.isDestroyed()) {
      win.hide();
      win.destroy();
    }
  }

  function closeChoiceWindow() {
    destroyWin(choiceWindow);
    choiceWindow = null;
  }

  function closeEditorWindow() {
    destroyWin(editorWindow);
    editorWindow = null;
  }

  function closeResultWindow() {
    destroyWin(resultWindow);
    resultWindow = null;
  }

  function openChoiceWindow(imagePath, mode = "quick") {
    closeChoiceWindow();
    currentImagePath = imagePath;
    lastCaptureMode = mode;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = 420;
    const height = 280;
    choiceWindow = new BrowserWindow({
      width,
      height,
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
      frame: false,
      transparent: true,
      show: false,
      alwaysOnTop: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: false,
      webPreferences: localUiPrefs(),
    });
    choiceWindow.loadURL(uiUrl("screenshot-choice.html"));
    choiceWindow.once("ready-to-show", () => {
      if (!choiceWindow || choiceWindow.isDestroyed()) return;
      choiceWindow.show();
      choiceWindow.focus();
      choiceWindow.webContents.send("screenshot-choice:init", {
        imagePath,
        fileUrl: toFileUrl(imagePath),
        fileName: path.basename(imagePath),
        mode,
      });
    });
    choiceWindow.on("closed", () => {
      choiceWindow = null;
    });
  }

  function openEditorWindow(imagePath) {
    closeChoiceWindow();
    closeEditorWindow();
    currentImagePath = imagePath;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(1100, display.workArea.width - 24);
    const height = Math.min(780, display.workArea.height - 24);
    editorWindow = new BrowserWindow({
      width,
      height,
      minWidth: 720,
      minHeight: 520,
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
      frame: false,
      transparent: true,
      show: false,
      alwaysOnTop: true,
      resizable: true,
      webPreferences: localUiPrefs(),
    });
    editorWindow.loadURL(uiUrl("screenshot-editor.html"));
    editorWindow.once("ready-to-show", () => {
      if (!editorWindow || editorWindow.isDestroyed()) return;
      editorWindow.show();
      editorWindow.focus();
      editorWindow.webContents.send("screenshot-editor:init", {
        imagePath,
        fileUrl: toFileUrl(imagePath),
        fileName: path.basename(imagePath),
        watermark: watermarkMeta(),
      });
    });
    editorWindow.on("closed", () => {
      editorWindow = null;
    });
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
      webPreferences: localUiPrefs(),
    });
    resultWindow.loadURL(uiUrl("screenshot-result.html"));
    resultWindow.once("ready-to-show", () => {
      if (!resultWindow || resultWindow.isDestroyed()) return;
      resultWindow.show();
      resultWindow.focus();
      resultWindow.webContents.send("screenshot-result:init", {
        imagePath,
        fileUrl: toFileUrl(imagePath),
        fileName: path.basename(imagePath),
        autoAnalyze,
      });
    });
    resultWindow.on("closed", () => {
      resultWindow = null;
    });
  }

  async function captureQuick() {
    lastCaptureMode = "quick";
    const hidden = hideAppWindows();
    try {
      await delay(40);
      const { image } = await captureDisplayImage();
      const filePath = await savePngAndClipboardFast(image, getNotesRoot(), "DM");
      restoreWindows(hidden);
      openChoiceWindow(filePath, "quick");
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

    lastCaptureMode = "region";
    const hidden = hideAppWindows();
    try {
      await delay(40);
      const { image, display, scale } = await captureDisplayImage();
      // JPEG 预览比 PNG dataURL 小得多，显著加快框选窗打开
      const previewJpeg = image.toJPEG(72);
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
        webPreferences: localUiPrefs(),
      });
      regionWindow.setMenuBarVisibility(false);
      regionWindow.loadURL(uiUrl("region-capture.html"));
      regionWindow.once("ready-to-show", () => {
        if (!regionWindow || regionWindow.isDestroyed()) return;
        regionWindow.setBounds(display.bounds);
        regionWindow.show();
        regionWindow.focus();
        regionWindow.webContents.send("region:image", {
          jpeg: previewJpeg,
          mime: "image/jpeg",
        });
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

    destroyWin(win);

    if (!context) return;
    restoreWindows(context.hidden);

    if (action === "cancel" || !rect) return;

    try {
      const cropped = cropImage(context.image, rect, context.scale);
      const filePath = await savePngAndClipboardFast(cropped, getNotesRoot(), "DM_region");
      if (action === "ai") openResultWindow(filePath, { autoAnalyze: true });
      else if (action === "edit") openEditorWindow(filePath);
      else openChoiceWindow(filePath, "region");
    } catch (error) {
      console.error("region crop failed", error);
    }
  }

  async function handleChoice(action) {
    const imagePath = currentImagePath;
    closeChoiceWindow();
    if (action === "edit" && imagePath) {
      openEditorWindow(imagePath);
      return { success: true };
    }
    if (action === "continue") {
      if (lastCaptureMode === "region") return beginRegionCapture();
      return captureQuick();
    }
    return { success: true };
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

  async function saveEditorImage(payload = {}) {
    try {
      const filePath = saveEditedPng(payload.dataUrl, getNotesRoot(), "DM_edit");
      currentImagePath = filePath;
      return {
        success: true,
        imagePath: filePath,
        fileUrl: toFileUrl(filePath),
        fileName: path.basename(filePath),
      };
    } catch (error) {
      return { success: false, error: error?.message || "保存失败" };
    }
  }

  async function copyEditorImage(payload = {}) {
    try {
      const raw = String(payload.dataUrl || "");
      const base64 = raw.includes(",") ? raw.split(",")[1] : raw;
      const image = require("electron").nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
      if (image.isEmpty()) throw new Error("图片无效");
      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || "复制失败" };
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
      return String(marked.parse(String(markdown || ""), { async: false }));
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
    closeEditorWindow();
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

  function getWatermarkMeta() {
    return watermarkMeta();
  }

  return {
    captureQuick,
    beginRegionCapture,
    finishRegionCapture,
    handleChoice,
    openEditorWindow,
    copyCurrent,
    saveCurrentNote,
    saveEditorImage,
    copyEditorImage,
    analyzeCurrent,
    continueWithAnalysis,
    closeResultWindow,
    closeChoiceWindow,
    closeEditorWindow,
    getWatermarkMeta,
  };
}

module.exports = { createScreenshotController };
