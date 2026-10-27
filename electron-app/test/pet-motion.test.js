const test = require('node:test');
const assert = require('node:assert/strict');
const { createPetMotion, motionLayout, nearestArea } = require('../electron/pet-motion');
const area = { x: -1600, y: 25, width: 1600, height: 900 };
const create = patch => createPetMotion({ x: -800, y: 925, width: 96, height: 96, area, ...patch });
const advance = (m, seconds) => { for (let i = 0; i < seconds * 120; i++) m.step(1 / 120); };

test('held arrows move in DIP, simultaneous arrows cancel, release stops and edges bound the body', () => {
  const m = create(); m.input('ArrowLeft', true); advance(m, 1);
  assert.equal(m.body.x, -1040); assert.equal(m.action, 'left');
  m.input('ArrowRight', true); advance(m, 1); assert.equal(m.body.x, -1040);
  m.input('ArrowLeft', false); advance(m, 10); assert.equal(m.body.x, -48);
  m.input('ArrowRight', false); advance(m, 1); assert.equal(m.body.x, -48); assert.equal(m.action, 'idle');
  m.input('ArrowLeft', true); advance(m, 10); assert.equal(m.body.x, -1552);
  m.clear(); advance(m, 1); assert.equal(m.body.x, -1552);
});
test('jump rises and lands exactly, holding Space cannot auto-jump, airborne repeats are ignored', () => {
  const m = create(); m.input('Space', true); advance(m, .2);
  assert.ok(m.body.y < 925 - 50); assert.equal(m.body.grounded, false);
  m.input('Space', true); advance(m, 1);
  assert.equal(m.body.y, 925); assert.equal(m.body.vy, 0); assert.equal(m.action, 'idle');
  m.input('Space', true); advance(m, .2); assert.equal(m.body.y, 925);
  m.input('Space', false); m.input('Space', true); advance(m, .2); assert.ok(m.body.y < 925);
});
test('floating start falls, stalls are capped and a low ceiling stops upward velocity', () => {
  const m = create({ y: 300 }); advance(m, 2); assert.equal(m.body.y, 925);
  m.input('ArrowRight', true); const x = m.body.x; m.step(900); assert.ok(m.body.x - x <= 12.01);
  const tiny = create({ y: 180, area: { x: -1600, y: 25, width: 1600, height: 155 } });
  tiny.input('Space', true); advance(tiny, .2); assert.ok(tiny.body.y >= 121); assert.ok(tiny.body.vy >= 0);
});
test('native window stays inside work area while body reaches all four edges independently of padding', () => {
  for (const x of [-1552, -800, -48]) for (const y of [121, 500, 925]) {
    const m = create({ x, y }), l = motionLayout(m.body, area), b = l.bounds;
    assert.ok(b.x >= area.x && b.y >= area.y);
    assert.ok(b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);
    assert.equal(b.x + l.left + 48, x); assert.equal(b.y + l.top + 96, y);
  }
  assert.deepEqual(nearestArea({ x: -400, y: 400 }, [{ workArea: { ...area, x: 0 } }, { workArea: area }]), area);
});

const icon = (patch = {}) => ({ id: 'file', name: '计划.md', x: -830, y: 500, width: 60, height: 60, ...patch });
test('Space assists a jump onto a high nearby icon and held Space stays on its top', () => {
  const m = create({ x: -900 }); m.setPlatforms([icon()]);
  assert.deepEqual(m.interaction(), { kind: 'target', name: '计划.md' });
  m.input('Space', true); advance(m, .15);
  assert.equal(m.interaction().kind, 'jumping'); assert.equal(m.body.grounded, false);
  advance(m, 2); assert.equal(m.body.y, 500); assert.equal(m.body.supportId, 'file');
  assert.equal(m.body.x, -800); assert.equal(m.interaction().kind, 'standing');
  advance(m, 2); assert.equal(m.body.y, 500, 'held key does not repeat');
});
test('icon platforms are one-way: ascent passes through and descent lands on the top', () => {
  const m = create(); m.setPlatforms([icon({ y: 700 })]);
  m.input('Space', true); advance(m, .4);
  assert.ok(m.body.y < 700); assert.equal(m.body.grounded, false); assert.equal(m.body.supportId, null);
  advance(m, 1); assert.equal(m.body.y, 700); assert.equal(m.body.supportId, 'file');
});
test('walking off, moving a supported icon or removing it resumes gravity', () => {
  for (const action of ['walk', 'move', 'remove']) {
    const m = create(); m.setPlatforms([icon()]); m.input('Space', true); advance(m, 2); m.input('Space', false);
    assert.equal(m.body.supportId, 'file');
    if (action === 'walk') { m.input('ArrowLeft', true); advance(m, .4); }
    else { m.setPlatforms(action === 'move' ? [icon({ y: 400 })] : []); advance(m, .1); }
    assert.equal(m.body.grounded, false); assert.equal(m.body.supportId, null); assert.ok(m.body.y > 500);
    advance(m, 2); assert.equal(m.body.y, 925);
  }
});
test('manual air steering overrides assistance; invalid and ceiling-adjacent icons cannot support pets', () => {
  const m = create(); m.setPlatforms([icon(), icon({ id: 'bad', x: NaN }), icon({ id: 'ceiling', y: 100 })]);
  m.input('Space', true); m.input('ArrowLeft', true); advance(m, 2);
  assert.equal(m.body.supportId, null); assert.equal(m.body.y, 925);
  const ceiling = create(); ceiling.setPlatforms([icon({ y: 100 })]);
  assert.equal(ceiling.interaction(), null); ceiling.input('Space', true); advance(ceiling, 1);
  assert.equal(ceiling.body.y, 925);
});
test('nearby file name is available when the pet walks alongside an icon', () => {
  const m = create({ x: -800, y: 550 }); m.setPlatforms([icon({ x: -720 })]);
  assert.deepEqual(m.interaction(), { kind: 'nearby', name: '计划.md' });
});

test('pickup requires actual proximity, supports the icon underfoot, and never picks a remote jump target', () => {
  const m = create(); const p = Object.freeze(icon()); m.setPlatforms([p]);
  assert.equal(m.interaction().kind, 'target'); assert.equal(m.pickupCandidate(), null);
  m.input('Space', true); advance(m, 2);
  assert.equal(m.pickupCandidate(), p);
  m.setPlatforms([]); assert.equal(m.pickupCandidate(), null);
});
test('pickup viewport includes the icon below a platform without clipping body or leaving the work area', () => {
  const m = create({ y: 500 }); const p = icon(); const l = motionLayout(m.body, area, p);
  assert.ok(l.bounds.y+l.bounds.height >= p.y+p.height);
  assert.equal(l.bounds.y+l.top+m.body.height, m.body.y);
  assert.ok(l.bounds.y >= area.y && l.bounds.y+l.bounds.height <= area.y+area.height);
});
