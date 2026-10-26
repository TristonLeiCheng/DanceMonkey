// Explicit developer probe only. Never imported by the application.
// electron tools/macos-desktop-icons.cjs --output /tmp/dm-icons.json [--overlay]
const { app, BrowserWindow, screen } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-desktop-icons-'));
app.setPath('userData', path.join(root, 'user-data'));
const args = process.argv.slice(2);
const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : path.join(root, 'report.json');
const script = `
const finder = Application('Finder');
const desktop = finder.desktop;
function read(fn) { try { return fn(); } catch (e) { return null; } }
const options = read(() => desktop.window.iconViewOptions.properties());
const items = desktop.items();
JSON.stringify({ options, count: items.length, truncated: items.length > 500,
  icons: items.slice(0, 500).map((item, index) => ({ index,
    name: read(() => item.name()), url: read(() => item.url()),
    position: read(() => item.desktopPosition()), bounds: read(() => item.bounds()) })) });
`;
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const inside = (p, r) => p[0] >= r.x && p[0] <= r.x + r.width && p[1] >= r.y && p[1] <= r.y + r.height;
let windows = [];
async function run() {
  if (process.platform !== 'darwin') throw new Error('此原型仅支持 macOS。');
  const raw = await new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script],
    { timeout: 45000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Finder 查询失败或授权超时：${stderr.trim() || error.message}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    }));
  const displays = screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor }));
  const icons = raw.icons.map(icon => ({ ...icon, rawPosition: icon.position,
    position: Array.isArray(icon.position) ? icon.position : [icon.position?.x, icon.position?.y],
  })).map(icon => ({ ...icon,
    validPosition: point(icon.position),
    candidateDisplayId: point(icon.position) ? displays.find(d => inside(icon.position, d.bounds))?.id ?? null : null,
  }));
  const report = { capturedAt: new Date().toISOString(), platform: process.platform,
    coordinateStatus: 'unverified: Finder desktopPosition is shown as Electron screen DIP; compare markers with visible icons',
    note: 'Read-only snapshot. Stacks, hidden desktop items and automatic arrangement may report positions that are not currently visible. No file/icon is moved. Report contains file names and URLs; keep local.',
    displays, ...raw, icons,
    positioned: icons.filter(i => i.validPosition).length,
    onDisplay: icons.filter(i => i.candidateDisplayId !== null).length };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, count: raw.count, positioned: report.positioned, onDisplay: report.onDisplay, displays: displays.length }));
  if (!args.includes('--overlay')) { app.quit(); return; }
  // All marks are hypotheses, deliberately labelled. Pass through mouse input;
  // expire automatically, without making Finder frontmost or rearranging icons.
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  for (const display of displays) {
    const b = display.workArea;
    const marks = icons.filter(i => i.validPosition && inside(i.position, b)).map(i =>
      `<div class="mark" style="left:${i.position[0] - b.x}px;top:${i.position[1] - b.y}px"><span>${i.index}: ${escape(i.name)}</span></div>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      body{margin:0;background:transparent;font:12px sans-serif;overflow:hidden}.mark{position:absolute;width:12px;height:12px;border:2px solid #ff3b30;transform:translate(-50%,-50%)}
      .mark span{position:absolute;top:14px;left:0;white-space:nowrap;background:#ffffffe8;color:#b51b12;padding:2px 4px}aside{position:absolute;top:8px;left:8px;background:#222e;color:white;padding:10px;border-radius:8px}
      </style><aside>Finder 图标位置验证 · 红框为候选坐标 · 20 秒后关闭</aside>${marks}`;
    const file = path.join(root, `overlay-${display.id}.html`); fs.writeFileSync(file, html);
    const win = new BrowserWindow({ ...b, transparent: true, frame: false, show: false, alwaysOnTop: true,
      focusable: false, skipTaskbar: true, hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.setIgnoreMouseEvents(true); win.setAlwaysOnTop(true, 'floating');
    await win.loadFile(file); win.showInactive(); windows.push(win);
  }
  setTimeout(() => app.quit(), 20000);
}
app.whenReady().then(run).catch(error => { console.error(error.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
