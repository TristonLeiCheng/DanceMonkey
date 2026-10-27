// World coordinates are Electron DIP: x is the body centre, y is its feet.
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
function createPetMotion({ x, y, width, height, area }) {
  const floor = area.y + area.height;
  const body = { x: clamp(x, area.x + width / 2, area.x + area.width - width / 2),
    y: clamp(y, area.y + height, floor), width, height, vx: 0, vy: 0, facing: 'right', grounded: false };
  body.grounded = body.y >= floor;
  body.supportId = null;
  let platforms = [], jumpTargetId = null;
  const footRadius = Math.min(24, width * .3);
  const onTop = (p, x = body.x) => x + footRadius > p.x && x - footRadius < p.x + p.width;
  const eligible = p => p.y >= area.y + height + 4 && p.y < floor - 4;
  function jumpTarget() {
    return platforms.filter(p => eligible(p) && p.id !== body.supportId && p.y < body.y - 8
      && Math.abs(p.x + p.width / 2 - body.x) <= 120)
      .sort((a, b) => (body.y - a.y) - (body.y - b.y) || Math.abs(a.x + a.width / 2 - body.x) - Math.abs(b.x + b.width / 2 - body.x))[0] || null;
  }
  function setPlatforms(next) {
    platforms = (Array.isArray(next) ? next : []).filter(p => typeof p.id === 'string'
      && [p.x, p.y, p.width, p.height].every(Number.isFinite) && p.width > 0 && p.height > 0).slice(0, 500);
    if (jumpTargetId && !platforms.some(p => p.id === jumpTargetId)) jumpTargetId = null;
    if (body.supportId && !platforms.some(p => p.id === body.supportId && Math.abs(body.y - p.y) < 1 && onTop(p))) {
      body.supportId = null; body.grounded = false;
    }
  }
  const keys = new Set();
  function input(code, down) {
    if (!['ArrowLeft', 'ArrowRight', 'Space'].includes(code) || typeof down !== 'boolean') return;
    const first = !keys.has(code);
    if (down) keys.add(code); else keys.delete(code);
    if (code === 'Space' && down && first && body.grounded) {
      const target = jumpTarget();
      const rise = target ? body.y - target.y + Math.max(28, height * .3) : 0;
      body.vy = -Math.sqrt(Math.max(620 * 620, 2 * 1800 * rise));
      jumpTargetId = target?.id || null;
      body.supportId = null; body.grounded = false;
    }
  }
  function step(seconds) {
    // Bound elapsed time after sleep/stalls and substep to keep landing deterministic.
    let remaining = Math.min(.05, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
    const direction = Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'));
    body.vx = direction * 240;
    if (direction) jumpTargetId = null; // Manual steering always takes precedence.
    if (direction) body.facing = direction < 0 ? 'left' : 'right';
    while (remaining > 0) {
      const dt = Math.min(remaining, 1 / 120); remaining -= dt;
      const guided = jumpTargetId && platforms.find(p => p.id === jumpTargetId);
      if (guided && !body.grounded && !direction) body.vx = clamp((guided.x + guided.width / 2 - body.x) / dt, -240, 240);
      const previousY = body.y;
      body.x = clamp(body.x + body.vx * dt, area.x + width / 2, area.x + area.width - width / 2);
      if (body.grounded && body.supportId && !platforms.some(p => p.id === body.supportId && onTop(p))) {
        body.supportId = null; body.grounded = false;
      }
      if (!body.grounded) {
        body.vy += 1800 * dt; body.y += body.vy * dt;
        if (body.y < area.y + height) { body.y = area.y + height; body.vy = Math.max(0, body.vy); }
        const landing = body.vy >= 0 && platforms.filter(p => eligible(p) && onTop(p) && previousY <= p.y + .01 && body.y >= p.y)
          .sort((a, b) => a.y - b.y)[0];
        if (landing) {
          body.y = landing.y; body.vy = 0; body.grounded = true; body.supportId = landing.id; jumpTargetId = null;
        } else if (body.y >= floor) { body.y = floor; body.vy = 0; body.grounded = true; body.supportId = null; jumpTargetId = null; }
      }
    }
    return body;
  }
  function interaction() {
    const support = platforms.find(p => p.id === body.supportId);
    if (support) return { kind: 'standing', name: support.name };
    const flying = platforms.find(p => p.id === jumpTargetId);
    if (flying) return { kind: 'jumping', name: flying.name };
    const target = body.grounded && jumpTarget();
    if (target) return { kind: 'target', name: target.name };
    const near = platforms.map(p => ({ p, distance: Math.hypot(Math.max(p.x - body.x - width / 2, 0, body.x - width / 2 - p.x - p.width),
      Math.max(p.y - body.y, 0, body.y - height - p.y - p.height)) })).filter(v => v.distance < 48).sort((a, b) => a.distance - b.distance)[0];
    return near ? { kind: 'nearby', name: near.p.name } : null;
  }
  function pickupCandidate() {
    // A remote overhead jump target is not within reach. Standing on its top or
    // touching its side puts the actual icon close enough to pick up its image.
    return platforms.map(p => ({ p, distance: Math.hypot(Math.max(p.x - body.x - width / 2, 0, body.x - width / 2 - p.x - p.width),
      Math.max(p.y - body.y, 0, body.y - height - p.y - p.height)) }))
      .filter(v => v.distance <= 40).sort((a, b) => Number(b.p.id === body.supportId) - Number(a.p.id === body.supportId)
        || a.distance - b.distance || Math.abs(a.p.x + a.p.width / 2 - body.x) - Math.abs(b.p.x + b.p.width / 2 - body.x))[0]?.p || null;
  }
  return { body, area, input, step, setPlatforms, interaction, pickupCandidate, clear: () => { keys.clear(); body.vx = 0; },
    get action() { return !body.grounded ? 'jump' : body.vx ? body.facing : 'idle'; } };
}

function nearestArea(point, displays) {
  return displays.map(display => display.workArea).reduce((best, area) => {
    const distance = rect => Math.hypot(point.x - clamp(point.x, rect.x, rect.x + rect.width),
      point.y - clamp(point.y, rect.y, rect.y + rect.height));
    return !best || distance(area) < distance(best) ? area : best;
  }, null);
}

// Keep the small native window on screen, moving the sprite inside it at edges.
// This lets feet/body touch the boundary without treating bubble padding as solid.
function motionLayout(body, area, extra = null) {
  const width = Math.min(area.width, Math.max(240, Math.ceil(body.width + 24)));
  const height = Math.min(area.height, Math.ceil(body.height + 136));
  const x = Math.round(clamp(body.x - width / 2, area.x, area.x + area.width - width));
  const y = Math.round(clamp(body.y + 8 - height, area.y, area.y + area.height - height));
  let bounds = { x, y, width, height };
  if (extra) {
    const left = Math.max(area.x, Math.min(x, Math.floor(extra.x)));
    const top = Math.max(area.y, Math.min(y, Math.floor(extra.y)));
    const right = Math.min(area.x + area.width, Math.max(x + width, Math.ceil(extra.x + extra.width)));
    const bottom = Math.min(area.y + area.height, Math.max(y + height, Math.ceil(extra.y + extra.height)));
    bounds = { x: left, y: top, width: right - left, height: bottom - top };
  }
  return { bounds, left: body.x - body.width / 2 - bounds.x, top: body.y - body.height - bounds.y };
}
module.exports = { createPetMotion, motionLayout, nearestArea };
