const path = require('node:path');
const { SIZES, normalizeSettings, createMood, buildTaskReminder, clampBounds } = require('./pet-model');

function createDesktopPet({ BrowserWindow, screen, Menu, powerSaveBlocker, configStore, getTasks,
  openWorkspace, captureQuick, captureRegion, requestQuit, onSettingsChanged = () => {},
  now = Date.now, random = Math.random, timers = globalThis, onError = (error) => console.warn('desktop pet:', error.message) }) {
  let win = null, ticker = null, dragTimer = null, blocker = null, drag = null;
  let settings = normalizeSettings(configStore.read());
  let mood = createMood({ now, random });
  let bubble = '', bubbleUntil = 0, animation = '', serial = 0;
  let nextAuto = 0, nextDecay = 0, nextReminder = 0, lastTaskId = null, lastTap = 0;
  const alive = () => win && !win.isDestroyed();
  const state = () => ({ animal: settings.petAnimal, size: settings.petDisplaySize, mood: mood.mood,
    bubble: now() < bubbleUntil ? bubble : '', animation, serial });
  const send = () => { if (alive()) win.webContents.send('pet:state', state()); };
  function speak(result, seconds = 4) {
    if (!result) return;
    bubble = String(result.text || '').slice(0, 160); bubbleUntil = now() + seconds * 1000;
    animation = result.animation || ''; serial++; send();
  }
  function stopDrag(commit = false) {
    if (dragTimer !== null) timers.clearInterval(dragTimer);
    dragTimer = null;
    const moved = Boolean(drag?.moved);
    drag = null;
    if (commit && moved && alive()) {
      const { x, y } = win.getBounds();
      try { configStore.write({ petWindowX: x, petWindowY: y }); }
      catch (error) { onError(error); }
    }
    return moved;
  }
  function releaseBlocker() {
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    blocker = null;
  }
  function updateBlocker() {
    if (settings.petModeEnabled && settings.petPreventSleepEnabled) {
      if (blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    } else releaseBlocker();
  }
  function closeWindow() {
    stopDrag();
    if (ticker !== null) timers.clearInterval(ticker);
    ticker = null;
    const previous = win;
    win = null;
    if (previous && !previous.isDestroyed()) previous.destroy();
    releaseBlocker();
  }
  function place() {
    if (!alive()) return;
    const size = settings.petDisplaySize;
    // Bubble space stays above the sprite so showing a message never moves the pet.
    const width = Math.max(240, size + 24), height = size + 136;
    const config = configStore.read();
    const area = screen.getPrimaryDisplay().workArea;
    const coordinate = (value, fallback) => Number.isFinite(value) ? value : fallback;
    const bounds = win.getBounds();
    win.setBounds(clampBounds({ width, height,
      x: coordinate(config.petWindowX ?? config.floatingIconX, bounds.x ?? area.x + area.width - width - 24),
      y: coordinate(config.petWindowY ?? config.floatingIconY, bounds.y ?? area.y + area.height - height - 24),
    }, screen.getAllDisplays()), false);
  }
  function tick() {
    if (!alive() || drag) return;
    if (now() >= nextDecay) {
      mood.decay(settings.petMoodDecayEnabled); nextDecay = now() + 180000;
    }
    if (settings.todoReminderEnabled && now() >= nextReminder) {
      nextReminder = now() + settings.todoReminderMinutes * 60000;
      try {
        const tasks = getTasks();
        // A temporarily unavailable/switching vault must not become an all-done message.
        if (tasks) {
          const reminder = buildTaskReminder(tasks, lastTaskId, new Date(now()));
          if (reminder) { lastTaskId = reminder.id; mood.set('taskReminder', 8 * 60000); speak({ text: reminder.text, animation: 'shake' }, 7); }
          else { mood.set('encouraging', 3 * 60000); speak({ text: '任务都处理完啦，休息一下也可以。', animation: 'jump' }, 5); }
        }
      } catch { speak({ text: '任务列表暂时读不到，请打开待办查看。' }, 5); }
      // Keep automatic dialogue from replacing a task reminder in this tick.
      nextAuto = Math.max(nextAuto, now() + 15000);
    }
    if (now() >= nextAuto) {
      nextAuto = now() + (45 + Math.floor(random() * 75)) * 1000;
      speak(mood.auto());
    }
    if (bubble && now() >= bubbleUntil) { bubble = ''; animation = ''; serial++; }
    send();
  }
  function sync(config) {
    const previous = settings;
    settings = normalizeSettings(config || configStore.read());
    if (!settings.petModeEnabled) { closeWindow(); return; }
    if (!alive()) {
      mood = createMood({ now, random });
      bubble = ''; bubbleUntil = 0; lastTap = 0; lastTaskId = null;
      nextAuto = now() + 45000; nextDecay = now() + 180000;
      nextReminder = now() + settings.todoReminderMinutes * 60000;
      const area = screen.getPrimaryDisplay().workArea;
      win = new BrowserWindow({ x: area.x + area.width - 264, y: area.y + area.height - settings.petDisplaySize - 160,
        width: 240, height: settings.petDisplaySize + 136, frame: false, transparent: true,
        backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false,
        maximizable: false, minimizable: false, fullscreenable: false, hasShadow: false, show: false,
        webPreferences: { preload: path.join(__dirname, 'pet-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      const created = win;
      created.setAlwaysOnTop(true, 'floating');
      if (process.platform === 'darwin') created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      created.setIgnoreMouseEvents(true, { forward: true });
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      created.webContents.on('will-navigate', (event) => event.preventDefault());
      created.on('closed', () => { if (win === created) closeWindow(); });
      created.once('ready-to-show', () => { if (win === created && !created.isDestroyed()) { send(); created.showInactive(); } });
      void created.loadFile(path.join(__dirname, '../pet.html'));
      ticker = timers.setInterval(tick, 1000); ticker.unref?.();
    }
    if (previous.todoReminderEnabled !== settings.todoReminderEnabled || previous.todoReminderMinutes !== settings.todoReminderMinutes) {
      nextReminder = now() + settings.todoReminderMinutes * 60000;
    }
    if (previous.petMoodDecayEnabled !== settings.petMoodDecayEnabled) mood.decay(settings.petMoodDecayEnabled);
    place(); updateBlocker(); send();
  }
  function save(patch) {
    // Persist only the explicit change, never a runtime/default snapshot of all settings.
    try { const saved = configStore.write(patch); sync(saved); onSettingsChanged(normalizeSettings(saved)); }
    catch (error) { onError(error); }
  }
  function beginDrag() {
    if (!alive()) return;
    stopDrag();
    win.setIgnoreMouseEvents(false);
    drag = { point: screen.getCursorScreenPoint(), bounds: win.getBounds(), moved: false };
    dragTimer = timers.setInterval(updateDrag, 16);
    dragTimer.unref?.();
  }
  function updateDrag() {
    if (!alive() || !drag) return;
    const point = screen.getCursorScreenPoint();
    const dx = point.x - drag.point.x, dy = point.y - drag.point.y;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    if (drag.moved) win.setBounds(clampBounds({ ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy }, screen.getAllDisplays()), false);
  }
  function release() {
    const wasDragging = Boolean(drag);
    updateDrag();
    const moved = stopDrag(true);
    if (!wasDragging || moved || !alive()) return;
    if (lastTap && now() - lastTap < 400) { lastTap = 0; openWorkspace('notes'); return; }
    lastTap = now(); speak(mood.tap(settings.petAnimal), 2.5);
  }
  function menu() {
    if (!alive()) return;
    stopDrag(true);
    Menu.buildFromTemplate([
      { label: '显示主界面', click: () => openWorkspace('notes') },
      { type: 'separator' },
      { label: '宠物大小', submenu: SIZES.map((size) => ({ label: `${size} px`, type: 'radio', checked: size === settings.petDisplaySize, click: () => save({ petDisplaySize: size }) })) },
      { label: '防止电脑休眠', type: 'checkbox', checked: settings.petPreventSleepEnabled, click: (item) => save({ petPreventSleepEnabled: item.checked }) },
      { type: 'separator' },
      { label: 'AI 对话', click: () => openWorkspace('ai') },
      { label: '笔记', click: () => openWorkspace('notes') },
      { label: '待办与项目', click: () => openWorkspace('tasks') },
      { label: '全屏截图', click: captureQuick },
      { label: '框选截图', click: captureRegion },
      { label: '宠物设置', click: () => openWorkspace('settings') },
      { type: 'separator' },
      { label: '关闭桌面宠物', click: () => save({ petModeEnabled: false }) },
      { label: '退出软件', click: requestQuit },
    ]).popup({ window: win, callback: () => { if (alive() && !drag) win.setIgnoreMouseEvents(true, { forward: true }); } });
  }
  function registerIpc(ipcMain) {
    const own = (event) => alive() && event.sender === win.webContents;
    ipcMain.handle('pet:get', (event) => own(event) ? state() : null);
    ipcMain.on('pet:interactive', (event, value) => { if (own(event) && !drag) win.setIgnoreMouseEvents(!value, { forward: true }); });
    ipcMain.on('pet:press', (event) => { if (own(event)) beginDrag(); });
    ipcMain.on('pet:release', (event) => { if (own(event)) release(); });
    ipcMain.on('pet:cancel', (event) => { if (own(event)) stopDrag(true); });
    ipcMain.on('pet:menu', (event) => { if (own(event)) menu(); });
    ipcMain.on('pet:tasks', (event) => { if (own(event)) openWorkspace('tasks'); });
  }
  const onDisplay = () => place();
  screen.on('display-added', onDisplay); screen.on('display-removed', onDisplay); screen.on('display-metrics-changed', onDisplay);
  return { sync, registerIpc, toggle: () => save({ petModeEnabled: !settings.petModeEnabled }),
    get enabled() { return settings.petModeEnabled; },
    get window() { return alive() ? win : null; },
    dispose() {
      closeWindow();
      screen.removeListener('display-added', onDisplay); screen.removeListener('display-removed', onDisplay); screen.removeListener('display-metrics-changed', onDisplay);
    },
  };
}
module.exports = { createDesktopPet };
