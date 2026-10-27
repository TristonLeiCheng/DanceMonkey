const test = require('node:test');
const assert = require('node:assert/strict');
const { createPetRoaming, supportsRoaming } = require('../electron/pet-roaming');
const { motionLayout } = require('../electron/pet-motion');
function seeded() { let n = 731; return () => ((n = (n * 16807) % 2147483647) - 1) / 2147483646; }
test('insects explore both axes with distinct speeds, pauses and bounded native windows', () => {
  assert.equal(supportsRoaming('cockroach'), false);
  assert.equal(supportsRoaming('cat'), false);
  for (const animal of ['realistic-cockroach', 'realistic-mosquito']) {
    const area = { x: -1600, y: -200, width: 1200, height: 850 };
    const r = createPetRoaming({ animal, x: -1000, y: 250, size: 96, area, random: seeded() });
    const phases = new Set(), actions = new Set(), xs = [], ys = [], speeds = [];
    for (let i = 0; i < 6000; i++) {
      r.step(.032); const pose = r.snapshot(), b = r.body, layout = motionLayout(b, area);
      phases.add(pose.phase); actions.add(pose.action); xs.push(b.x); ys.push(b.y); speeds.push(Math.hypot(b.vx, b.vy));
      assert.ok(b.x - b.width / 2 >= area.x && b.x + b.width / 2 <= area.x + area.width);
      assert.ok(b.y - b.height >= area.y && b.y <= area.y + area.height);
      assert.ok(layout.bounds.x >= area.x && layout.bounds.y >= area.y);
      assert.ok(layout.bounds.x + layout.bounds.width <= area.x + area.width);
      assert.ok(layout.bounds.y + layout.bounds.height <= area.y + area.height);
      assert.ok(pose.frame >= 0 && pose.frame < 4 && Number.isFinite(pose.tilt));
    }
    assert.ok(Math.max(...xs) - Math.min(...xs) > 200);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 200);
    assert.ok(phases.has('rest') && phases.has('travel'));
    assert.ok(actions.has('left') && actions.has('right') && actions.has('working'));
    assert.ok(Math.max(...speeds) > (animal === 'realistic-mosquito' ? 150 : 60));
    if (animal === 'realistic-mosquito') assert.ok(phases.has('hover'));
  }
});
test('stall recovery and tiny displays never teleport or produce invalid coordinates', () => {
  for (const width of [80, 1400]) {
    const r = createPetRoaming({ animal: 'realistic-mosquito', x: 100, y: 200, size: 48,
      area: { x: 0, y: 0, width, height: 200 }, random: seeded() });
    for (let i = 0; i < 200; i++) r.step(.032);
    const before = { ...r.body }; r.step(10000);
    assert.ok(Math.hypot(r.body.x - before.x, r.body.y - before.y) < 15);
    const after = { ...r.body }; r.step(NaN); r.step(-5);
    assert.deepEqual(r.body, after);
  }
});
