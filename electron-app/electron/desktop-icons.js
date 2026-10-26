const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');

// Read-only Apple events and Quartz window geometry. No System Events, file
// contents, screen capture, icon positioning or filesystem mutation commands.
const MAC_SCENE_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
// Treat the toll-free CFArray result as NSArray; recent JXA otherwise exposes
// an opaque Ref instead of an array. The short-lived process owns the result.
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['unsigned int', 'unsigned int']]);
const finder = Application('Finder');
const prefs = $.NSUserDefaults.alloc.initWithSuiteName('com.apple.finder');
const createDesktop = prefs.objectForKey('CreateDesktop');
const hidden = ObjC.unwrap(createDesktop) === false;
const desktop = finder.desktop;
const size = desktop.window.iconViewOptions.iconSize();
const arrangement = desktop.window.iconViewOptions.arrangement();
const items = hidden ? [] : desktop.items();
const icons = items.slice(0, 500).map(item => {
  try { return { name: item.name(), key: item.url(), position: item.desktopPosition() }; }
  catch (_) { return null; }
}).filter(Boolean);
const windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1 | 16, 0)).map(w => ({
  id: w.kCGWindowNumber, layer: w.kCGWindowLayer, alpha: w.kCGWindowAlpha,
  bounds: w.kCGWindowBounds
}));
JSON.stringify({ hidden: Boolean(hidden), arrangement, iconSize: size, icons, windows });
`;

// The current Electron/macOS combination crashes in app.getFileIcon's native
// worker for desktop folders. Isolate the read-only AppKit lookup in a short,
// cancellable process so metadata failures cannot terminate the application.
const MAC_ICON_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(args) {
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile($(args[0]));
  const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 64, 64, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSMakeRect(0, 0, 0, 0), $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}
`;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function normalizeDesktopScene(raw, { area, excludeWindowId } = {}) {
  if (!raw || !Array.isArray(raw.icons) || !Array.isArray(raw.windows) || !area) throw new Error('Invalid desktop scene');
  if (raw.hidden) return { status: 'desktop-hidden', icons: [] };
  // Finder can return stale per-file positions for collapsed Stacks. Begin with
  // manually arranged / grid-snapped desktops rather than inventing platforms.
  if (raw.arrangement && !['not arranged', 'snap to grid'].includes(raw.arrangement)) return { status: 'layout-unsupported', icons: [] };
  const size = finite(raw.iconSize) ? Math.max(16, Math.min(256, raw.iconSize)) : 64;
  // Dock/system overlays may report a full-screen rectangle despite transparent
  // contents. Use ordinary application windows (layer 0) as desktop occluders.
  const windows = raw.windows.filter(w => finite(w.id) && w.id !== excludeWindowId && w.layer === 0 && (w.alpha ?? 1) > .05)
    .map(w => ({ x: w.bounds?.X, y: w.bounds?.Y, width: w.bounds?.Width, height: w.bounds?.Height }))
    .filter(w => Object.values(w).every(finite) && w.width > 0 && w.height > 0);
  const seen = new Set(), icons = [];
  for (const icon of raw.icons.slice(0, 500)) {
    const [cx, cy] = Array.isArray(icon.position) ? icon.position : [icon.position?.x, icon.position?.y];
    if (!finite(cx) || !finite(cy) || typeof icon.name !== 'string') continue;
    // Finder desktopPosition and Quartz window bounds use macOS screen points,
    // matching Electron DIP. Never multiply by display.scaleFactor.
    const rect = { x: cx - size / 2, y: cy - size / 2, width: size, height: size };
    if (rect.x < area.x || rect.x + size > area.x + area.width || rect.y < area.y || rect.y + size > area.y + area.height) continue;
    if (windows.some(w => overlaps(rect, w))) continue;
    const id = createHash('sha256').update(String(icon.key || icon.name)).digest('hex').slice(0, 24);
    if (seen.has(id)) continue;
    seen.add(id);
    icons.push({ id, name: icon.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80), ...rect });
  }
  return { status: 'ready', icons };
}

function createDesktopIconReader({ platform = process.platform, run = execFile, loadIcon = null } = {}) {
  let paths = new Map(), generation = 0;
  const images = new Map(), iconRequests = new Set();
  const load = loadIcon || ((file, { signal }) => new Promise((resolve, reject) => {
    run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_ICON_SCRIPT, file],
      { timeout: 4500, maxBuffer: 500000, signal }, (error, stdout) => error ? reject(error) : resolve(`data:image/png;base64,${stdout.trim()}`));
  }));
  return {
    clear() { generation++; paths.clear(); images.clear(); for (const request of iconRequests) request.abort(); iconRequests.clear(); },
    async getIcon(id) {
      // Only IDs returned by the latest visible scene can request an OS icon.
      // File URLs stay in this main-process reader, never in the renderer API.
      const key = paths.get(id), epoch = generation;
      if (!key) return null;
      if (images.has(id)) return images.get(id);
      let file;
      try { const url = new URL(key); if (url.protocol !== 'file:') return null; file = fileURLToPath(url); }
      catch { return null; }
      const controller = new AbortController(); iconRequests.add(controller);
      try {
        const data = await load(file, { signal: controller.signal });
        if (epoch !== generation || paths.get(id) !== key || controller.signal.aborted) return null;
        if (typeof data !== 'string' || data.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)) return null;
        if (images.size >= 32) images.delete(images.keys().next().value);
        images.set(id, data); return data;
      } catch { return null; }
      finally { iconRequests.delete(controller); }
    },
    async read({ area, excludeWindowId, signal }) {
      if (platform !== 'darwin') return { status: 'unsupported', icons: [] };
      const epoch = generation;
      const raw = await new Promise((resolve, reject) => {
        run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCENE_SCRIPT],
          { timeout: 8000, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr = '') => {
            if (error) {
              error.sceneStatus = /-1743|not authorized|not permitted|不允许|未经授权/i.test(stderr) ? 'permission-required' : 'unavailable';
              reject(error); return;
            }
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
          });
      });
      if (signal?.aborted || epoch !== generation) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const result = normalizeDesktopScene(raw, { area, excludeWindowId });
      const visible = new Set(result.icons.map(icon => icon.id));
      paths = new Map(raw.icons.filter(icon => typeof icon.key === 'string').map(icon =>
        [createHash('sha256').update(icon.key || icon.name).digest('hex').slice(0, 24), icon.key]).filter(([id]) => visible.has(id)));
      return result;
    },
  };
}
module.exports = { createDesktopIconReader, normalizeDesktopScene, MAC_SCENE_SCRIPT, MAC_ICON_SCRIPT };
