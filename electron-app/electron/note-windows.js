const fs = require('node:fs');
const { saveNoteImages } = require('./note-assets');
const path = require('node:path');
const { createWorkspace } = require('./workspace');
const { createZenTaskStore } = require('./zentask');

// Each document owns its workspace and disk snapshot. Switching the main vault
// must never redirect an already open document's reads or writes.
function createNoteWindows({ BrowserWindow, ipcMain, dialog, getWorkspace, rendererUrl, icon,
  assertWritable, isBusy, canClose, changed, trusted = () => true, timeoutMs = 15000 }) {
  const records = new Map();
  const windows = () => [...records.values()].map(record => record.win);
  function recordFor(event) {
    const record = [...records.values()].find(item => item.win.webContents === event.sender);
    if (!trusted(event) || !record || event.senderFrame !== event.sender.mainFrame) throw new Error('无效的文档窗口');
    return record;
  }
  function snapshot(record) {
    const content = record.workspace.read(record.path);
    record.disk = content;
    return { path: record.path, root: record.workspace.root, content, appearance: record.workspace.getAppearance(record.path) };
  }
  function open(workspace, relativePath) {
    if (isBusy()) throw new Error('正在同步或退出，请稍后打开笔记。');
    // Validate containment, extension, existence and symbolic links before opening.
    const content = workspace.read(relativePath);
    const absolute = fs.realpathSync(path.resolve(workspace.root, relativePath));
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    relativePath = path.relative(workspace.root, absolute).replaceAll('\\', '/');
    const existing = records.get(key);
    if (existing && !existing.win.isDestroyed()) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.show(); existing.win.focus();
      return { path: existing.path };
    }
    const win = new BrowserWindow({ width: 1080, height: 800, minWidth: 660, minHeight: 480,
      title: `${path.basename(relativePath)} — DM`, icon, show: false,
      backgroundColor: '#15161a',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: false } });
    const record = { win, workspace, path: relativePath, disk: content, closing: false, closeTimer: null, allowClose: false };
    records.set(key, record);
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => {
      if (canClose() || record.allowClose) return;
      event.preventDefault();
      if (isBusy() || record.closing) return;
      record.closing = true;
      record.closeTimer = setTimeout(() => {
        record.closing = false;
        dialog.showErrorBox('文档尚未关闭', '等待保存超时，请在文档窗口中保存后重试。');
      }, timeoutMs);
      win.webContents.send('note:close-request');
    });
    fs.watchFile(absolute, { persistent: false, interval: 1000 }, () => {
      try { if (workspace.read(relativePath) === record.disk) return; } catch {}
      if (!win.isDestroyed()) win.webContents.send('note:disk-changed');
    });
    win.on('closed', () => { fs.unwatchFile(absolute); clearTimeout(record.closeTimer); records.delete(key); });
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    void win.loadURL(rendererUrl('#document'));
    return { path: relativePath };
  }
  function openLocal(file) {
    const current = getWorkspace(), relative = path.relative(current.root, file);
    const contained = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    return open(contained ? current : createWorkspace(path.dirname(file), { initializeQuickNotes: false }), contained ? relative : path.basename(file));
  }
  ipcMain.handle('note:import-images', (event, images, notePath, expectedRoot, generation) => {
    assertWritable(generation);
    if (!trusted(event)) throw new Error('无效的图片导入请求');
    const record = [...records.values()].find(item => item.win.webContents === event.sender);
    const workspace = record?.workspace || getWorkspace();
    if (!record) {
      if (expectedRoot !== workspace.root) throw new Error('笔记库已变化，请重试。');
      assertAvailable(workspace.root, notePath);
    }
    return saveNoteImages(workspace, record?.path || notePath, images);
  });
  ipcMain.handle('note:image', (event, src, notePath, expectedRoot) => {
    if (!trusted(event) || typeof src !== 'string') throw new Error('无效的图片请求');
    if (/^https?:\/\//i.test(src)) return src;
    if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src) && src.length < 28000000) return src;
    const record = [...records.values()].find(item => item.win.webContents === event.sender);
    const workspace = record?.workspace || getWorkspace();
    if (!record && expectedRoot !== workspace.root) throw new Error('笔记库已变化');
    const doc = record?.path || notePath;
    workspace.read(doc);
    const base = fs.realpathSync(workspace.root);
    const image = fs.realpathSync(path.resolve(base, path.dirname(doc), decodeURIComponent(src)));
    if (!image.startsWith(base + path.sep)) throw new Error('图片不在笔记库内');
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
    const mime = types[path.extname(image).toLowerCase()];
    if (!mime || fs.statSync(image).size > 20 * 1024 * 1024) throw new Error('不支持的图片或超过 20 MB');
    return `data:${mime};base64,${fs.readFileSync(image).toString('base64')}`;
  });
  ipcMain.handle('note:focus-existing', (event, relativePath) => {
    if (!trusted(event)) throw new Error('无效请求');
    const target = path.resolve(getWorkspace().root, relativePath);
    const record = [...records.values()].find(item => path.resolve(item.workspace.root, item.path) === target);
    if (!record) return false;
    record.win.show(); record.win.focus(); return true;
  });
  function assertAvailable(root, relativePath) {
    const target = path.resolve(root, relativePath);
    if ([...records.values()].some(record => {
      const absolute = path.resolve(record.workspace.root, record.path);
      return absolute === target || absolute.startsWith(`${target}${path.sep}`);
    })) {
      throw new Error('该笔记正在独立窗口中编辑，请先关闭文档窗口后再重命名或删除。');
    }
  }
  ipcMain.handle('note:open', (event, relativePath, expectedRoot) => {
    if (!trusted(event)) throw new Error('无效的文档请求');
    const workspace = getWorkspace();
    if (expectedRoot && expectedRoot !== workspace.root) throw new Error('笔记库已变化，请重新打开笔记。');
    return open(workspace, relativePath);
  });
  ipcMain.handle('note:choose', async event => {
    if (!trusted(event)) throw new Error('无效的文档请求');
    if (isBusy()) throw new Error('正在同步或退出，请稍后再试。');
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '打开本机 Markdown 文件', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled) return;
    for (const file of result.filePaths) openLocal(file);
  });
  ipcMain.handle('note:read', event => snapshot(recordFor(event)));
  ipcMain.handle('note:inspect', (event, content) => {
    const record = recordFor(event);
    return record.workspace.inspect(record.path, content);
  });
  ipcMain.handle('note:open-linked', (event, relativePath) => open(recordFor(event).workspace, relativePath));
  ipcMain.handle('note:write', (event, content, generation) => {
    assertWritable(generation);
    const record = recordFor(event);
    if (typeof content !== 'string') throw new Error('无效的文档内容');
    // A missing, renamed or externally edited file must never be recreated or overwritten.
    let disk;
    try { disk = record.workspace.read(record.path); }
    catch { throw new Error('源文件已移动或删除。请另存为以保留当前编辑内容。'); }
    if (disk !== record.disk) throw new Error('文件已被其他程序修改。请重新读取磁盘版本，或将当前内容另存为。');
    record.workspace.write(record.path, content);
    record.disk = content;
    changed(record.workspace.root);
    return { saved: true };
  });
  ipcMain.handle('note:tasks-load', event => createZenTaskStore(recordFor(event).workspace.root).load());
  ipcMain.handle('note:tasks-add', (event, inputs, generation) => {
    assertWritable(generation);
    const record = recordFor(event);
    const result = createZenTaskStore(record.workspace.root).addTasksBatch(inputs.map(input => ({ ...input, sourceNotePath: record.path })));
    changed(record.workspace.root);
    return result;
  });
  ipcMain.handle('note:save-copy', async (event, content) => {
    const record = recordFor(event);
    if (typeof content !== 'string') throw new Error('无效的文档内容');
    const result = await dialog.showSaveDialog(record.win, { title: '另存一份 Markdown',
      defaultPath: path.join(record.workspace.root, record.path.replace(/\.md$/i, ' 副本.md')),
      filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled) return null;
    const target = result.filePath.toLowerCase().endsWith('.md') ? result.filePath : `${result.filePath}.md`;
    // Exclusive create also protects another open document and raced filesystem edits.
    fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
    return { path: target };
  });
  ipcMain.on('note:close-ready', (event, payload = {}) => {
    let record;
    try { record = recordFor(event); } catch { return; }
    if (!record.closing) return;
    clearTimeout(record.closeTimer);
    record.closing = false;
    if (payload.error) {
      dialog.showErrorBox('文档尚未关闭', '保存失败，编辑内容已保留在窗口中。请重试或另存为。');
    } else {
      record.allowClose = true;
      record.win.close();
    }
  });
  return { windows, assertAvailable, openLocal };
}
module.exports = { createNoteWindows };
