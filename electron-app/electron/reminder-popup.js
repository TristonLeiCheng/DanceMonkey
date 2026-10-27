const path = require('node:path');
const { STYLES } = require('./reminders');

function popupBounds(style, area, { expanded = false, screenBounds = area } = {}) {
  if (style === 'DynamicIsland') {
    const inset = Math.max(0, area.y - screenBounds.y);
    const width = Math.min(expanded ? 420 : 300, screenBounds.width - 24);
    // A compact capsule is one centered row; the menu-bar inset must not become
    // a second empty row above it. Reserve that inset only for expanded content.
    return { width, height: Math.min(expanded ? inset + 200 : 44, screenBounds.height),
      x: Math.round(screenBounds.x + (screenBounds.width - width) / 2), y: screenBounds.y };
  }
  const sizes = { GlassCard: [440, 310], Circular: [350, 350], Toast: [390, 270], Banner: [640, 220], Compact: [420, 220] };
  const [w, h] = sizes[style] || sizes.GlassCard;
  const width = Math.min(w, area.width - 24), height = Math.min(h, area.height - 24);
  const right = ['Toast', 'Compact'].includes(style), top = style === 'Banner';
  return { width, height, x: Math.round(right ? area.x + area.width - width - 16 : area.x + (area.width - width) / 2), y: Math.round(top ? area.y + 16 : right ? area.y + area.height - height - 16 : area.y + (area.height - height) / 2) };
}
function createReminderPopup({ BrowserWindow, screen, ipcMain, onAction, onError = console.error }) {
  let win = null, current = null, disposing = false, acting = false;
  let display = null, expanded = false;
  const queue = [];
  const style = () => current?.reminder.popupStyleOverride || current?.options.defaultPopupStyle;
  const bounds = () => popupBounds(style(), display.workArea, { expanded, screenBounds: display.bounds });
  function resizeIsland() {
    if (!win || win.isDestroyed()) return false;
    const target = bounds();
    // The renderer morphs the silhouette in one stable surface. Resize the native
    // hit area only at the beginning of expansion and the end of collapse.
    win.setBounds(target);
    return target;
  }
  const layout = () => ({
    topInset: Math.max(0, display.workArea.y - display.bounds.y),
    islandBounds: {
      collapsed: popupBounds('DynamicIsland', display.workArea, { screenBounds: display.bounds }),
      expanded: popupBounds('DynamicIsland', display.workArea, { screenBounds: display.bounds, expanded: true }),
    },
  });
  function advance() {
    if (disposing || win || !queue.length) return;
    current = queue.shift(); expanded = false;
    display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const popup = new BrowserWindow({
      ...bounds(), frame: false, transparent: true, backgroundColor: '#00000000',
      show: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, roundedCorners: false, acceptFirstMouse: true,
      // Frameless macOS windows may cross the menu-bar work-area inset only with this option.
      ...(style() === 'DynamicIsland' ? { enableLargerThanScreen: true } : {}),
      // Native vibrancy/acrylic paints a rectangular backing outside our CSS silhouette.
      // Keep the whole native window transparent; the card owns its material and rounded edge.
      webPreferences: { preload: path.join(__dirname, 'reminder-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win = popup;
    popup.setAlwaysOnTop(true, style() === 'DynamicIsland' ? 'screen-saver' : 'floating');
    popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', event => event.preventDefault());
    popup.once('ready-to-show', () => {
      if (popup.isDestroyed()) return;
      if (current.options.test) popup.show();
      else popup.showInactive();
      if (style() === 'DynamicIsland') popup.setBounds(bounds());
    });
    popup.on('close', event => {
      if (!disposing && current && !current.options.test && !acting) {
        try { onAction(current.reminder.id, 'snooze'); } catch (error) { event.preventDefault(); onError(error); }
      }
    });
    popup.once('closed', () => { win = null; current = null; advance(); });
    void popup.loadFile(path.join(__dirname, 'ui/reminder.html')).catch(error => {
      onError(error);
      if (!popup.isDestroyed()) popup.close();
    });
  }
  const own = event => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('reminder-popup:get', event => own(event) ? { ...current, style: style(), ...layout() } : null);
  ipcMain.handle('reminder-popup:expand', (event, value = true) => {
    if (!own(event) || style() !== 'DynamicIsland') return false;
    expanded = value !== false;
    return resizeIsland();
  });
  ipcMain.handle('reminder-popup:act', (event, action) => {
    if (!own(event) || !['done', 'snooze'].includes(action)) return false;
    if (!current.options.test) onAction(current.reminder.id, action);
    acting = true;
    try { win.close(); } finally { acting = false; }
    return true;
  });
  const updateDisplay = () => {
    if (!win || win.isDestroyed() || style() !== 'DynamicIsland') return;
    display = screen.getAllDisplays().find(item => item.id === display.id) || screen.getPrimaryDisplay();
    resizeIsland();
    win.webContents.send('reminder-popup:inset', layout());
  };
  screen.on('display-metrics-changed', updateDisplay); screen.on('display-removed', updateDisplay);
  return {
    show(reminder, options) {
      if (!STYLES.includes(reminder.popupStyleOverride || options.defaultPopupStyle)) throw new Error('弹窗样式无效。');
      if (queue.length >= 100) throw new Error('待显示的提醒过多，请先处理现有提醒。');
      queue.push({ reminder, options }); advance();
    },
    dismiss(id) {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].reminder.id === id) queue.splice(i, 1);
      if (current?.reminder.id === id) { acting = true; try { win?.close(); } finally { acting = false; } }
    },
    dispose() {
      disposing = true; queue.length = 0; win?.destroy();
      screen.removeListener('display-metrics-changed', updateDisplay); screen.removeListener('display-removed', updateDisplay);
      for (const name of ['get', 'act', 'expand']) ipcMain.removeHandler(`reminder-popup:${name}`);
    },
  };
}
module.exports = { createReminderPopup, popupBounds };
