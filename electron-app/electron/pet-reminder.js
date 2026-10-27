// A reminder moves the existing pet window without changing its saved position/size.
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
const mix = (a, b, progress) => a + (b - a) * progress;
const ease = progress => progress * progress * (3 - 2 * progress);
function createPetReminderJourney({ origin, area, size, aspect = 1, gait = { frames: 4, fps: 6 }, now = Date.now, reducedMotion = false }) {
  const started = now(), largeSize = Math.max(176, Math.min(240, size * 1.85, area.height * .36));
  const target = { x: area.x + area.width / 2, y: area.y + area.height / 2 + Math.min(150, area.height * .2) };
  // One gait cycle advances about 60% of a sprite cell. Growth increases stride
  // length while preserving the atlas cadence, instead of sliding at a fixed speed.
  const strideRate = gait.fps / gait.frames * .6;
  const distance = point => Math.hypot(point.x - origin.x, point.y - origin.y);
  const walkTime = Math.max(900, distance(target) / (strideRate * (size + largeSize) / 2) * 1000), shrinkTime = 420;
  let returning = null;
  function pose(time) {
    if (returning) {
      const elapsed = reducedMotion ? shrinkTime + returning.walkTime : Math.max(0, time - returning.started);
      if (elapsed < shrinkTime) return { ...returning.from, size: mix(returning.from.size, size, ease(elapsed / shrinkTime)), phase: 'shrinking', action: 'idle' };
      const p = Math.min(1, (elapsed - shrinkTime) / returning.walkTime);
      return { x: mix(returning.from.x, origin.x, p), y: mix(returning.from.y, origin.y, p), size,
        phase: p === 1 ? 'finished' : 'returning', action: origin.x < returning.from.x ? 'left' : 'right' };
    }
    const elapsed = reducedMotion ? walkTime : Math.max(0, time - started);
    if (elapsed < walkTime) {
      const p = elapsed / walkTime;
      // Integral of the changing stride length, normalized to the full journey.
      const travel = (size * p + (largeSize - size) * (p ** 3 - p ** 4 / 2)) / ((size + largeSize) / 2);
      return { x: mix(origin.x, target.x, travel), y: mix(origin.y, target.y, travel),
        size: mix(size, largeSize, ease(p)), phase: 'walking', action: target.x < origin.x ? 'left' : 'right' };
    }
    return { ...target, size: largeSize, phase: 'presenting', action: 'wave' };
  }
  function snapshot() {
    const current = pose(now());
    const width = Math.min(area.width, 432), height = Math.min(area.height, Math.ceil(current.size + 280));
    const bounds = { width, height,
      x: Math.round(clamp(current.x - width / 2, area.x, area.x + area.width - width)),
      y: Math.round(clamp(current.y + 24 - height, area.y, area.y + area.height - height)) };
    return { phase: current.phase, action: current.action, size: current.size,
      facing: current.action === 'left' ? 'left' : 'right', showSign: current.phase === 'presenting', bounds,
      left: current.x - current.size * aspect / 2 - bounds.x, top: current.y - current.size - bounds.y };
  }
  return { snapshot, finish() {
    if (returning) return;
    const from = pose(now());
    returning = { from, started: now(), walkTime: Math.max(900, distance(from) / (strideRate * size) * 1000) };
  } };
}
module.exports = { createPetReminderJourney };
