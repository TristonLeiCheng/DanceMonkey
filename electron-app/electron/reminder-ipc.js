const fs = require('node:fs');
function registerReminderIpc({ ipcMain, service, popup, pet, dialog, BrowserWindow, trusted }) {
  const dismiss = id => { popup.dismiss(id); pet?.dismissReminder(id); };
  const handle = (name, fn) => ipcMain.handle(`reminders:${name}`, (event, ...args) => {
    if (!trusted(event)) throw new Error('无法从此窗口操作提醒。');
    return fn(event, ...args);
  });
  handle('list', () => service.list());
  handle('save', (_event, input) => { const result = service.save(input); if (input?.id) dismiss(input.id); return result; });
  handle('remove', (_event, id) => { const result = service.remove(id); dismiss(id); return result; });
  handle('reset', (_event, id) => { const result = service.reset(id); dismiss(id); return result; });
  handle('act', (_event, id, action) => { const result = service.act(id, action); dismiss(id); return result; });
  handle('test', (_event, input) => service.test(input));
  handle('settings', (_event, input) => service.saveSettings(input));
  handle('import', async (event, mode) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) || undefined, { title: '导入提醒', filters: [{ name: '提醒 JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('提醒文件不能超过 5 MB。');
    const ids = service.list().reminders.map(item => item.id);
    const imported = service.importData(JSON.parse(fs.readFileSync(file, 'utf8')), mode);
    for (const id of ids) dismiss(id);
    return imported;
  });
  handle('export', async event => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) || undefined, { title: '导出提醒', defaultPath: 'reminders.json', filters: [{ name: '提醒 JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, JSON.stringify(service.exportData(), null, 2), 'utf8');
    return true;
  });
}
module.exports = { registerReminderIpc };
