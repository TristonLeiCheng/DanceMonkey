// Autonomous insects use desktop DIP, with the same centre/feet coordinates as
// keyboard motion. No desktop inspection, input synthesis or position writes.
const supportsRoaming = animal => ['realistic-cockroach', 'realistic-mosquito'].includes(animal);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
function createPetRoaming({ animal, x, y, size, area, random = Math.random }) {
  const flying = animal === 'realistic-mosquito';
  const body = { x, y, width: size, height: size, facing: 'right', vx: 0, vy: 0 };
  const limits = { left: area.x + size / 2 + 8, right: area.x + area.width - size / 2 - 8,
    top: area.y + size + 8, bottom: area.y + area.height - 8 };
  body.x = clamp(x, limits.left, limits.right); body.y = clamp(y, limits.top, limits.bottom);
  const between = (a, b) => a + random() * (b - a);
  let phase = 'rest', remaining = between(.6, 1.4), target = { x: body.x, y: body.y };
  let heading = 0, age = 0, cycle = 0, tilt = 0, speed = 0, restingAction = 'idle';
  function choose() {
    if (phase === 'travel') {
      phase = flying ? (random() < .18 ? 'rest' : 'hover') : 'rest';
      remaining = flying ? between(.6, 1.8) : between(.5, 2.2);
      restingAction = phase === 'hover' ? 'idle' : random() < .4 ? 'working' : 'waiting';
    } else {
      phase = 'travel'; remaining = flying ? between(1.2, 3.2) : between(.7, 2.1);
      const angle = between(-Math.PI, Math.PI), distance = between(flying ? 130 : 70, flying ? 420 : 220);
      target = { x: clamp(body.x + Math.cos(angle) * distance, limits.left, limits.right),
        y: clamp(body.y + Math.sin(angle) * distance, limits.top, limits.bottom) };
      heading = Math.atan2(target.y - body.y, target.x - body.x);
      speed = between(flying ? 115 : 45, flying ? 235 : 120) * Math.sqrt(size / 96);
    }
  }
  function step(seconds) {
    const dt = clamp(Number.isFinite(seconds) ? seconds : 0, 0, .05);
    if (!dt) return;
    age += dt; remaining -= dt;
    if (remaining <= 0) choose();
    let vx = 0, vy = 0;
    if (phase === 'travel') {
      const dx = target.x - body.x, dy = target.y - body.y;
      const desired = Math.atan2(dy, dx);
      const turn = Math.atan2(Math.sin(desired - heading), Math.cos(desired - heading));
      heading += clamp(turn, -dt * 3.5, dt * 3.5);
      // Short fast runs for the roach; curved, fluctuating flight for the mosquito.
      const bend = flying ? Math.sin(age * 7) * .28 + Math.sin(age * 2.3) * .18 : Math.sin(age * 11) * .035;
      const velocity = speed * (flying ? .8 + .2 * Math.sin(age * 5) : .85 + .15 * Math.sin(age * 14));
      vx = Math.cos(heading + bend) * velocity; vy = Math.sin(heading + bend) * velocity;
      if (Math.hypot(dx, dy) < 16) remaining = 0;
    } else if (phase === 'hover') {
      vx = Math.cos(age * 8) * 12; vy = Math.sin(age * 11) * 15;
    }
    const blend = 1 - Math.exp(-dt * (flying ? 9 : 18));
    body.vx += (vx - body.vx) * blend; body.vy += (vy - body.vy) * blend;
    const nx = body.x + body.vx * dt, ny = body.y + body.vy * dt;
    body.x = clamp(nx, limits.left, limits.right); body.y = clamp(ny, limits.top, limits.bottom);
    if (nx !== body.x || ny !== body.y) { remaining = 0; body.vx = body.vy = 0; }
    if (Math.abs(body.vx) > 6) body.facing = body.vx < 0 ? 'left' : 'right';
    const moving = Math.hypot(body.vx, body.vy);
    const angle = Math.atan2(body.vy, Math.max(12, Math.abs(body.vx))) * 180 / Math.PI * (body.facing === 'left' ? -1 : 1);
    const targetTilt = phase === 'travel' ? clamp(angle, flying ? -18 : -42, flying ? 18 : 42) : 0;
    tilt += (targetTilt - tilt) * (1 - Math.exp(-dt * 8));
    cycle += dt * (flying && phase !== 'rest' ? 22 : phase === 'travel' ? clamp(moving / (size * .075), 5, 16) : 4);
  }
  return { body, area, step,
    snapshot: () => ({ active: true, phase, facing: body.facing,
      action: phase === 'travel' ? body.facing : restingAction,
      tilt, frame: Math.floor(cycle) % 4 }) };
}
module.exports = { supportsRoaming, createPetRoaming };
