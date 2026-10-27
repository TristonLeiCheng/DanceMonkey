const PICKUP_MS = 440, DROP_MS = 360;
function createPetCarry({ now = Date.now } = {}) {
  let item = null, phase = '', started = 0, serial = 0;
  function snapshot() {
    if (!item) return null;
    const elapsed = Math.max(0, now() - started);
    if (phase === 'putting-down' && elapsed >= DROP_MS) { item = null; phase = ''; return null; }
    if (phase === 'picking-up' && elapsed >= PICKUP_MS) { phase = 'carrying'; started += PICKUP_MS; }
    return { ...item, phase, serial, progress: phase === 'carrying' ? 1
      : Math.min(1, Math.max(0, now() - started) / (phase === 'picking-up' ? PICKUP_MS : DROP_MS)) };
  }
  return {
    snapshot,
    pickUp(icon) {
      if (snapshot() || !icon) return null;
      item = { id: icon.id, name: icon.name, image: null,
        source: { x: icon.x, y: icon.y, width: icon.width, height: icon.height } };
      phase = 'picking-up'; started = now(); return ++serial;
    },
    putDown(body = null) {
      if (snapshot()?.phase !== 'carrying') return false;
      if (body) item.dropAnchor = { x: body.x, y: body.y, width: body.width, height: body.height, facing: body.facing };
      phase = 'putting-down'; started = now(); return true;
    },
    setImage(token, image) {
      if (!snapshot() || serial !== token || phase === 'putting-down') return false;
      if (typeof image !== 'string' || image.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) return false;
      item.image = image; return true;
    },
    clear() { serial++; item = null; phase = ''; },
  };
}
module.exports = { createPetCarry, PICKUP_MS, DROP_MS };
