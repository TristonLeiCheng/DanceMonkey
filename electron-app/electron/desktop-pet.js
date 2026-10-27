const path = require('node:path');
const { ANIMALS, SIZES, normalizeSettings, createMood, buildTaskReminder, clampBounds } = require('./pet-model');
const { supportsRoaming, createPetRoaming } = require('./pet-roaming');
const { createPetMotion, motionLayout, nearestArea } = require('./pet-motion');
const { getManifest } = require('../src/pet-atlas');
const { createPetCarry } = require('./pet-carry');
const { createPetReminderJourney } = require('./pet-reminder');

function createDesktopPet({ BrowserWindow, screen, Menu, powerSaveBlocker, configStore, getTasks,
  openWorkspace, captureQuick, captureRegion, requestQuit, onSettingsChanged = () => {},
  desktopIcons = null,
  onReminderAction = () => {}, onReminderFallback = () => {},
  now = Date.now, random = Math.random, timers = globalThis, onError = (error) => console.warn('desktop pet:', error.message) }) {
  let win = null, ticker = null, dragTimer = null, blocker = null, drag = null;
  let motion = null, motionTimer = null, motionTime = 0, layout = null, menuOpen = false;
  let scene = null;
  let roaming = null, roamingLayout = null, roamingTimer = null, roamingTime = 0, pointerOver = false;
  let rendererReady = false;
  let reminder = null, reminderTimer = null, reminderFrame = null, reminderSerial = 0, reducedMotion = false;
  const reminderQueue = [];
  const carry = createPetCarry({ now });
  let carryKeyHeld = false, carryNotice = '', carryNoticeUntil = 0;
  let settings = normalizeSettings(configStore.read());
  let mood = createMood({ now, random });
  let bubble = '', bubbleUntil = 0, animation = '', serial = 0, bubbleSection = 'tasks';
  let nextAuto = 0, nextDecay = 0, nextReminder = 0, lastTaskId = null, lastTap = 0;
  const alive = () => win && !win.isDestroyed();
  const state = () => ({ animal: settings.petAnimal, size: reminderFrame?.size || settings.petDisplaySize, mood: mood.mood,
    bubble: now() < bubbleUntil ? bubble : '', animation, serial,
    roaming: roaming && !motion && !reminder ? { ...roaming.snapshot(),
      paused: Boolean(drag || menuOpen || pointerOver || now() < bubbleUntil || reducedMotion),
      left: roamingLayout.left, top: roamingLayout.top } : null,
    reminder: reminder ? { ...reminder.item, token: reminder.token, test: reminder.options.test === true,
      error: reminder.error || '', ...reminderFrame } : null,
    control: motion ? { active: true, action: motion.action, facing: motion.body.facing,
      grounded: motion.body.grounded, left: layout.left, top: layout.top,
      iconInteraction: motion.interaction(), iconsStatus: scene?.status || 'unsupported', iconCount: scene?.count || 0,
      carry: carry.snapshot(), pickable: motion.pickupCandidate()?.name || null,
      carryNotice: now() < carryNoticeUntil ? carryNotice : '' } : { active: false } });
  const send = () => { if (alive()) win.webContents.send('pet:state', state()); };
  function stopRoaming() {
    if (roamingTimer !== null) timers.clearInterval(roamingTimer);
    roamingTimer = null; roaming = null; roamingLayout = null;
  }
  function origin() {
    if (roaming) return { x: roaming.body.x, y: roaming.body.y };
    const bounds = win.getBounds(), size = settings.petDisplaySize, atlas = getManifest(settings.petAnimal);
    return { x: bounds.x + (atlas ? bounds.width / 2 : bounds.width - 12 - size / 2), y: bounds.y + bounds.height - 8 };
  }
  function updateRoaming() {
    if (!alive() || !roaming) return;
    const time = now(), dt = (time - roamingTime) / 1000; roamingTime = time;
    if (motion || reminder || drag || menuOpen || pointerOver || reducedMotion || now() < bubbleUntil || win.isVisible?.() === false) return;
    roaming.step(dt);
    roamingLayout = motionLayout(roaming.body, roaming.area);
    const bounds = win.getBounds();
    if (Object.entries(roamingLayout.bounds).some(([key, value]) => bounds[key] !== value)) win.setBounds(roamingLayout.bounds, false);
    send();
  }
  function startRoaming() {
    if (!alive() || !rendererReady || !settings.petRoamingEnabled || !supportsRoaming(settings.petAnimal)
      || motion || reminder || drag || reducedMotion || win.isVisible?.() === false) return;
    if (!roaming) {
      const point = origin(), size = settings.petDisplaySize;
      roaming = createPetRoaming({ animal: settings.petAnimal, ...point, size, random,
        area: nearestArea({ x: point.x, y: point.y - size / 2 }, screen.getAllDisplays()) });
      roamingLayout = motionLayout(roaming.body, roaming.area);
    }
    if (roamingTimer === null) {
      roamingTime = now(); roamingTimer = timers.setInterval(updateRoaming, 32); roamingTimer.unref?.();
    }
    updateRoaming();
  }
  function restoreReminder() {
    if (reminderTimer !== null) timers.clearInterval(reminderTimer);
    reminderTimer = null;
    const home = reminder?.home;
    reminder = null; reminderFrame = null;
    if (alive() && home) {
      win.setBounds(clampBounds(home, screen.getAllDisplays()), false);
      win.setIgnoreMouseEvents(true, { forward: true });
      nextAuto = now() + 45000; lastTap = 0; serial++; send();
    }
  }
  function abortReminders(fallback = false) {
    const waiting = [...(reminder && !reminder.handled ? [reminder] : []), ...reminderQueue];
    reminderQueue.length = 0; restoreReminder();
    if (fallback) for (const entry of waiting) {
      try { onReminderFallback(entry.item, entry.options); } catch (error) { onError(error); }
    }
  }
  function updateReminder() {
    if (!alive() || !reminder) return;
    const previousFrame = reminderFrame;
    reminderFrame = reminder.journey.snapshot();
    if (reminderFrame.phase === 'finished') { restoreReminder(); advanceReminder(); return; }
    if (JSON.stringify(previousFrame) === JSON.stringify(reminderFrame)) return;
    const bounds = win.getBounds();
    if (Object.entries(reminderFrame.bounds).some(([key, value]) => bounds[key] !== value)) win.setBounds(reminderFrame.bounds, false);
    send();
  }
  function advanceReminder() {
    if (reminder || !alive() || !reminderQueue.length) return;
    const entry = reminderQueue.shift(), home = win.getBounds(), size = settings.petDisplaySize;
    const atlas = getManifest(settings.petAnimal);
    const start = origin();
    const area = nearestArea({ x: start.x, y: start.y - size / 2 }, screen.getAllDisplays());
    stopDrag(); bubble = ''; bubbleUntil = 0; animation = ''; serial++;
    reminder = { ...entry, home, journey: createPetReminderJourney({ origin: start, area, size,
      aspect: atlas ? atlas.cellWidth / atlas.cellHeight : 1, gait: atlas?.actions.right, now, reducedMotion }) };
    updateReminder();
    reminderTimer = timers.setInterval(updateReminder, 16); reminderTimer.unref?.();
  }
  function dismissReminder(id) {
    for (let i = reminderQueue.length - 1; i >= 0; i--) if (reminderQueue[i].item.id === id) reminderQueue.splice(i, 1);
    if (reminder?.item.id === id) { reminder.handled = true; reminder.journey.finish(); updateReminder(); }
  }
  function actReminder(input) {
    if (!reminder || reminder.handled || reminderFrame?.phase !== 'presenting'
      || input?.token !== reminder.token || !['done', 'snooze'].includes(input.action)) return false;
    try {
      if (!reminder.options.test) onReminderAction(reminder.item.id, input.action);
      reminder.handled = true; reminder.journey.finish(); updateReminder();
      return true;
    } catch (error) { reminder.error = error.message || '操作未能保存，请重试。'; send(); return false; }
  }
  function carryKey(down) {
    if (!down) { carryKeyHeld = false; return; }
    if (carryKeyHeld) return;
    carryKeyHeld = true;
    if (carry.snapshot()) { carry.putDown(motion.body); send(); return; }
    const icon = motion.pickupCandidate();
    if (!icon) {
      carryNotice = '先靠近图标，或跳到图标上，再按 E 抱起。'; carryNoticeUntil = now() + 2500; send(); return;
    }
    const token = carry.pickUp(icon), session = scene;
    carryNoticeUntil = 0; updateMotion();
    Promise.resolve().then(() => {
      if (!motion || scene !== session) return null;
      return desktopIcons?.getIcon?.(icon.id);
    }).then(image => {
      if (motion && scene === session && carry.setImage(token, image)) send();
    }).catch(() => {}); // The local generic icon remains visible if OS metadata fails.
  }
  function refreshIcons() {
    if (!scene || !motion || !desktopIcons || menuOpen) return;
    const session = scene;
    if (session.status === 'ready' && now() - session.updatedAt > 4000) {
      motion.setPlatforms([]); session.count = 0; session.status = 'loading';
    }
    if (session.busy || now() < session.next) return;
    session.busy = true; session.controller = new AbortController();
    const nativeId = Number(win.getMediaSourceId?.().split(':')[1]);
    Promise.resolve().then(() => {
      if (scene !== session || !motion || session.controller.signal.aborted) return null;
      return desktopIcons.read({ area: motion.area,
        excludeWindowId: Number.isFinite(nativeId) ? nativeId : null, signal: session.controller.signal });
    })
      .then(result => {
        if (scene !== session || !motion || !result) return;
        const icons = Array.isArray(result.icons) ? result.icons : [];
        motion.setPlatforms(icons); session.status = result.status; session.count = icons.length;
        session.updatedAt = now(); session.next = now() + 1500;
        if (result.status === 'unsupported') session.next = Infinity;
      }).catch(error => {
        if (scene !== session || !motion) return;
        motion.setPlatforms([]); session.count = 0;
        session.status = error.sceneStatus || 'unavailable';
        session.next = session.status === 'permission-required' ? Infinity : now() + 15000;
      }).finally(() => { if (scene === session) { session.busy = false; session.controller = null; send(); } });
  }
  function updateMotion() {
    if (!alive() || !motion) return;
    const time = now();
    if (!menuOpen) motion.step((time - motionTime) / 1000);
    motionTime = time;
    const held = carry.snapshot();
    const drop = held?.dropAnchor;
    const extra = held?.phase === 'picking-up' ? held.source : held?.phase === 'putting-down' && drop
      ? { x: drop.x - drop.width / 2, y: drop.y - drop.height, width: drop.width, height: drop.height } : null;
    layout = motionLayout(motion.body, motion.area, extra);
    const bounds = win.getBounds();
    if (Object.entries(layout.bounds).some(([key, value]) => bounds[key] !== value)) win.setBounds(layout.bounds, false);
    refreshIcons();
    send();
  }
  function stopControl(commit = true) {
    scene?.controller?.abort(); scene = null;
    carry.clear(); carryKeyHeld = false; carryNoticeUntil = 0; desktopIcons?.clear?.();
    if (motionTimer !== null) timers.clearInterval(motionTimer);
    motionTimer = null;
    if (!motion) return;
    const body = motion.body;
    motion = null; layout = null; serial++;
    if (!alive()) return;
    if (commit) {
      const width = Math.max(240, settings.petDisplaySize + 24), height = settings.petDisplaySize + 136;
      const atlas = getManifest(settings.petAnimal);
      const offset = atlas ? width / 2 : width - 12 - settings.petDisplaySize / 2;
      win.setBounds(clampBounds({ x: body.x - offset, y: body.y + 8 - height, width, height }, screen.getAllDisplays()), false);
      const { x, y } = win.getBounds();
      try { configStore.write({ petWindowX: x, petWindowY: y }); } catch (error) { onError(error); }
    }
    win.setIgnoreMouseEvents(true, { forward: true }); send();
  }
  function startControl() {
    if (!alive() || motion || reminder) return;
    stopDrag(true); lastTap = 0;
    const { x, y } = origin(), size = settings.petDisplaySize, atlas = getManifest(settings.petAnimal);
    stopRoaming();
    motion = createPetMotion({ x, y, width: size * (atlas ? atlas.cellWidth / atlas.cellHeight : 1), height: size,
      area: nearestArea({ x, y: y - size / 2 }, screen.getAllDisplays()) });
    scene = { status: desktopIcons ? 'loading' : 'unsupported', count: 0, busy: false, next: now(), updatedAt: now() };
    motionTime = now(); animation = ''; serial++;
    updateMotion();
    motionTimer = timers.setInterval(updateMotion, 16); motionTimer.unref?.();
    // Native menu completion focuses the window, never a global keyboard hook.
  }
  function speak(result, seconds = 4) {
    if (!result) return;
    bubbleSection = result.section || 'tasks';
    bubble = String(result.text || '').slice(0, 160); bubbleUntil = now() + seconds * 1000;
    animation = result.animation || ''; serial++; send();
  }
  function stopDrag(commit = false) {
    if (dragTimer !== null) timers.clearInterval(dragTimer);
    dragTimer = null;
    const moved = Boolean(drag?.moved);
    drag = null;
    if (moved && roaming && alive()) {
      const bounds = win.getBounds();
      roaming.body.x = bounds.x + roamingLayout.left + settings.petDisplaySize / 2;
      roaming.body.y = bounds.y + roamingLayout.top + settings.petDisplaySize;
      const point = origin(); stopRoaming();
      roaming = createPetRoaming({ animal: settings.petAnimal, ...point, size: settings.petDisplaySize, random,
        area: nearestArea(point, screen.getAllDisplays()) });
      roamingLayout = motionLayout(roaming.body, roaming.area); startRoaming();
    }
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
    stopRoaming(); rendererReady = false; pointerOver = false;
    abortReminders();
    stopControl(false); menuOpen = false;
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
    startRoaming();
    if (!alive() || drag || reminder) return;
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
    const roamingPoint = roaming ? origin() : null;
    stopControl(); stopRoaming(); pointerOver = false;
    const previous = settings;
    settings = normalizeSettings(config || configStore.read());
    if (previous.petAnimal !== settings.petAnimal) rendererReady = false;
    if (reminder && (!settings.petModeEnabled || previous.petAnimal !== settings.petAnimal || previous.petDisplaySize !== settings.petDisplaySize)) abortReminders(true);
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
      created.on('blur', () => { if (win === created && !menuOpen) stopControl(); });
      created.on('hide', () => { if (win === created) { stopControl(); abortReminders(true);
        if (roamingTimer !== null) timers.clearInterval(roamingTimer); roamingTimer = null; pointerOver = false; } });
      created.on('show', () => { if (win === created) startRoaming(); });
      created.webContents.on('render-process-gone', () => { rendererReady = false; stopRoaming(); stopControl(); abortReminders(true); });
      created.webContents.on('did-start-loading', () => { rendererReady = false; stopRoaming(); stopControl(); });
      created.once('ready-to-show', () => { if (win === created && !created.isDestroyed()) { send(); created.showInactive(); } });
      void created.loadFile(path.join(__dirname, '../pet.html'));
      ticker = timers.setInterval(tick, 1000); ticker.unref?.();
    }
    if (previous.todoReminderEnabled !== settings.todoReminderEnabled || previous.todoReminderMinutes !== settings.todoReminderMinutes) {
      nextReminder = now() + settings.todoReminderMinutes * 60000;
    }
    if (previous.petMoodDecayEnabled !== settings.petMoodDecayEnabled) mood.decay(settings.petMoodDecayEnabled);
    if (!reminder) {
      if (roamingPoint && previous.petAnimal === settings.petAnimal && previous.petDisplaySize === settings.petDisplaySize) {
        const width = Math.max(240, settings.petDisplaySize + 24), height = settings.petDisplaySize + 136;
        win.setBounds(clampBounds({ x: roamingPoint.x - width / 2, y: roamingPoint.y + 8 - height, width, height }, screen.getAllDisplays()), false);
      } else place();
    }
    updateBlocker(); startRoaming(); send();
  }
  function save(patch) {
    // Persist only the explicit change, never a runtime/default snapshot of all settings.
    try { const saved = configStore.write(patch); sync(saved); onSettingsChanged(normalizeSettings(saved)); }
    catch (error) { onError(error); }
  }
  function beginDrag() {
    if (!alive()) return;
    if (motion || reminder) return;
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
    if (reminder) return;
    stopDrag(true);
    const wasControlling = Boolean(motion);
    menuOpen = true; motion?.clear(); carryKeyHeld = false;
    const items = [
      { id: 'pet-control', label: motion ? '关闭交互模式' : '开启交互模式', type: 'checkbox', checked: Boolean(motion),
        click: () => motion ? stopControl() : startControl() },
      { label: '交互模式：← → 行走 · 空格跳跃 · E 抱起/放下 · Esc 退出', enabled: false },
      { type: 'separator' },
      { label: '显示主界面', click: () => openWorkspace('notes') },
      { type: 'separator' },
      { label: '宠物大小', submenu: SIZES.map((size) => ({ label: `${size} px`, type: 'radio', checked: size === settings.petDisplaySize, click: () => save({ petDisplaySize: size }) })) },
      ...(supportsRoaming(settings.petAnimal) ? [{ id: 'pet-roaming', label: '自由爬行 / 飞行', type: 'checkbox', checked: settings.petRoamingEnabled, click: item => save({ petRoamingEnabled: item.checked }) }] : []),
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
    ];
    const wrap = entries => entries.forEach(item => {
      if (item.submenu) wrap(item.submenu);
      if (item.click && item.id !== 'pet-control') {
        const click = item.click; item.click = (...args) => { stopControl(); click(...args); };
      }
    });
    wrap(items);
    Menu.buildFromTemplate(items).popup({ window: win, callback: () => {
      menuOpen = false;
      if (alive() && !drag) {
        win.setIgnoreMouseEvents(true, { forward: true });
        if (motion) {
          // Only the explicit enable action may take keyboard focus. Cancelling
          // an existing mode's menu into another app must not steal focus back.
          if (!wasControlling || win.isFocused()) { motionTime = now(); win.focus(); }
          else stopControl();
        }
      }
    } });
  }
  function registerIpc(ipcMain) {
    const own = (event) => alive() && event.sender === win.webContents;
    ipcMain.handle('pet:get', (event) => own(event) ? state() : null);
    ipcMain.handle('pet:reminder-act', (event, input) => own(event) ? actReminder(input) : false);
    ipcMain.on('pet:reduced-motion', (event, value) => { if (own(event)) { reducedMotion = value === true; startRoaming(); send(); } });
    ipcMain.on('pet:ready', event => { if (own(event)) { rendererReady = true; startRoaming(); } });
    ipcMain.on('pet:interactive', (event, value) => { if (own(event)) { const changed = pointerOver !== (value === true); pointerOver = value === true; if (!drag) win.setIgnoreMouseEvents(!value, { forward: true }); if (changed) send(); } });
    ipcMain.on('pet:press', (event) => { if (own(event)) beginDrag(); });
    ipcMain.on('pet:release', (event) => { if (own(event)) release(); });
    ipcMain.on('pet:cancel', (event) => { if (own(event)) stopDrag(true); });
    ipcMain.on('pet:menu', (event) => { if (own(event)) menu(); });
    ipcMain.on('pet:tasks', (event) => { if (own(event)) openWorkspace(now() < bubbleUntil ? bubbleSection : 'tasks'); });
    ipcMain.on('pet:key', (event, input) => {
      if (!own(event) || !motion || menuOpen || !win.isFocused() || !input || typeof input.down !== 'boolean') return;
      if (input.code === 'KeyE') { carryKey(input.down); return; }
      motion.input(input.code, input.down);
    });
    ipcMain.on('pet:control-exit', event => { if (own(event)) stopControl(); });
  }
  const onDisplay = () => { stopRoaming(); stopControl(); abortReminders(true); place(); startRoaming(); };
  screen.on('display-added', onDisplay); screen.on('display-removed', onDisplay); screen.on('display-metrics-changed', onDisplay);
  return { sync, registerIpc,
    notifyReminder(item, options = {}) {
      if (!settings.petModeEnabled || !alive() || motion || drag || menuOpen || win.isVisible?.() === false
        || !Object.hasOwn(ANIMALS, settings.petAnimal) || reminderQueue.length >= 100) return false;
      reminderQueue.push({ item: structuredClone(item), options: { ...options }, token: ++reminderSerial });
      advanceReminder();
      return true;
    },
    dismissReminder,
    toggle: () => save({ petModeEnabled: !settings.petModeEnabled }),
    get enabled() { return settings.petModeEnabled; },
    get window() { return alive() ? win : null; },
    dispose() {
      closeWindow();
      screen.removeListener('display-added', onDisplay); screen.removeListener('display-removed', onDisplay); screen.removeListener('display-metrics-changed', onDisplay);
    },
  };
}
module.exports = { createDesktopPet };
