const test = require('node:test');
const assert = require('node:assert/strict');
const { createPetCarry, PICKUP_MS, DROP_MS } = require('../electron/pet-carry');
const icon = Object.freeze({ id: 'file', name: '计划.md', x: -200, y: 500, width: 60, height: 60 });
const png = 'data:image/png;base64,aGVsbG8=';
test('pickup, carrying and putting down keep a single visual snapshot without changing source metadata', () => {
  let time = 1000; const c = createPetCarry({ now: () => time });
  assert.equal(c.snapshot(), null); const token = c.pickUp(icon);
  assert.equal(c.snapshot().phase, 'picking-up'); assert.equal(c.pickUp(icon), null);
  assert.equal(c.putDown(), false); assert.equal(c.setImage(token, png), true);
  time += PICKUP_MS; assert.equal(c.snapshot().phase, 'carrying'); assert.equal(c.snapshot().image, png);
  const body = { x: -700, y: 900, width: 96, height: 96, facing: 'left' };
  assert.equal(c.putDown(body), true); body.x = 0;
  assert.equal(c.snapshot().dropAnchor.x, -700, 'drop destination stays fixed as the pet walks away');
  time += DROP_MS; assert.equal(c.snapshot(), null);
  assert.deepEqual(icon, { id: 'file', name: '计划.md', x: -200, y: 500, width: 60, height: 60 });
});
test('clearing invalidates asynchronous images and never revives a previous item', () => {
  const c = createPetCarry({ now: () => 0 }); const first = c.pickUp(icon); c.clear();
  assert.equal(c.setImage(first, png), false); assert.equal(c.snapshot(), null);
  const second = c.pickUp({ ...icon, id: 'another' });
  assert.equal(c.setImage(first, png), false); assert.equal(c.snapshot().image, null);
  for (const bad of ['file:///private/file', 'https://example.com/icon.png', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,' + 'A'.repeat(350001)]) {
    assert.equal(c.setImage(second, bad), false);
  }
  assert.equal(c.setImage(second, png), true);
});
