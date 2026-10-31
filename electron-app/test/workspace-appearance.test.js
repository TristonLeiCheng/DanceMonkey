const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, create, defaults } = require('../src/workspace-appearance');

test('appearance restores legacy values, bounds numeric preferences and rejects injected colors', () => {
  assert.deepEqual(normalize(), defaults);
  assert.deepEqual(normalize({ theme: 'frost-green', effect: 'paper', opacity: '67', accent: '#AABBCC', fontSize: '18' }),
    { theme: 'frost-green', effect: 'paper', opacity: 67, accent: '#aabbcc', fontSize: 18 });
  assert.deepEqual(normalize({ theme: 'invalid', effect: 'invalid', opacity: 'bad', accent: 'red;display:none', fontSize: 900 }), { ...defaults, fontSize: 20 });
});

test('system appearance responds to OS changes while preserving the saved system preference', () => {
  const classes = new Set(['workspace-root', 'maximized']);
  classes.remove = key => classes.delete(key);
  classes.toggle = (key, enabled) => enabled ? classes.add(key) : classes.delete(key);
  const styles = new Map();
  const media = { matches: false, addEventListener: (event, listener) => { media.change = listener; } };
  const values = new Map([['lumen-workspace-theme', 'system'], ['lumen-workspace-effect', 'paper'], ['lumen-workspace-opacity', '67']]);
  const ui = create({ root: { classList: classes, style: { setProperty: (key, value) => styles.set(key, value) } }, storage: { getItem: key => values.get(key) ?? null }, media });
  assert.equal(classes.has('theme-light'), true);
  assert.equal(classes.has('light'), true);
  assert.equal(styles.get('--ws-opacity'), '0.67');
  media.matches = true; media.change();
  assert.equal(classes.has('theme-dark'), true);
  assert.equal(classes.has('theme-light'), false);
  assert.equal(classes.has('light'), false);
  assert.equal(classes.has('maximized'), true);
  assert.equal(ui.get().theme, 'system');
  assert.match(ui.render(), /data-appearance-theme="system" aria-pressed="true"/);
});
