const test = require('node:test');
const assert = require('node:assert/strict');
const { createPetReminderJourney } = require('../electron/pet-reminder');

for (const area of [{ x: 0, y: 25, width: 1440, height: 875 }, { x: -1600, y: -100, width: 1600, height: 1000 }]) {
  test(`pet walks to its display center, grows and returns without changing its home (${area.x})`, () => {
    let time = 1000;
    const origin = { x: area.x + 100, y: area.y + area.height - 10 };
    const journey = createPetReminderJourney({ origin, area, size: 68, now: () => time });
    const first = journey.snapshot();
    assert.equal(first.phase, 'walking'); assert.equal(first.size, 68);
    assert.equal(first.bounds.x + first.left + first.size / 2, origin.x);
    assert.equal(first.bounds.y + first.top + first.size, origin.y);
    time = 2000; const walking = journey.snapshot();
    assert.equal(walking.phase, 'walking'); assert.ok(walking.size > 68 && walking.size < 176);
    for (time = 1000; time <= 31000; time += 1000) {
      const p = journey.snapshot(), b = p.bounds;
      assert.ok(b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);
      assert.ok(p.left >= 0 && p.top >= 0 && p.top + p.size <= b.height);
    }
    const showing = journey.snapshot();
    assert.equal(showing.phase, 'presenting'); assert.equal(showing.showSign, true);
    assert.ok(showing.size > 68 * 2);
    assert.equal(showing.bounds.x + showing.left + showing.size / 2, area.x + area.width / 2);
    journey.finish(); assert.equal(journey.snapshot().phase, 'shrinking');
    time += 500; assert.equal(journey.snapshot().phase, 'returning');
    time += 30000; const home = journey.snapshot();
    assert.equal(home.phase, 'finished'); assert.equal(home.size, 68);
    assert.equal(home.bounds.x + home.left + home.size / 2, origin.x);
    assert.equal(home.bounds.y + home.top + home.size, origin.y);
  });
}
test('dismissal while walking returns from the current location and repeated finish does not restart it', () => {
  let time = 0;
  const journey = createPetReminderJourney({ origin: { x: 100, y: 700 }, area: { x: 0, y: 0, width: 1200, height: 800 }, size: 128, now: () => time });
  time = 200; const before = journey.snapshot(); journey.finish();
  assert.equal(journey.snapshot().left, before.left);
  time = 4000; journey.finish(); assert.equal(journey.snapshot().phase, 'finished');
});
test('reduced motion presents and returns immediately', () => {
  const journey = createPetReminderJourney({ origin: { x: 100, y: 700 }, area: { x: 0, y: 0, width: 1200, height: 800 }, size: 96, reducedMotion: true });
  assert.equal(journey.snapshot().phase, 'presenting'); journey.finish();
  assert.equal(journey.snapshot().phase, 'finished');
});

test('travel is paced by the walking cycle and grows continuously rather than racing ahead of the feet', () => {
  let time = 0;
  const options = { origin: { x: 100, y: 700 }, area: { x: 0, y: 0, width: 1600, height: 900 }, size: 96, now: () => time };
  const regular = createPetReminderJourney({ ...options, gait: { frames: 4, fps: 6 } });
  const slowCycle = createPetReminderJourney({ ...options, gait: { frames: 8, fps: 6 } });
  const center = frame => frame.bounds.x + frame.left + frame.size / 2;
  time = 250; const first = regular.snapshot();
  assert.ok(center(first) > 100 && center(first) < 140, 'a quarter-second advances a small step');
  time = 1000; const walking = regular.snapshot(), slower = slowCycle.snapshot();
  assert.equal(walking.phase, 'walking'); assert.ok(walking.size > first.size);
  assert.ok(center(walking) > center(slower), 'a slower gait cycle produces slower travel');
});
