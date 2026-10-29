const test = require('node:test');
const assert = require('node:assert/strict');
let State, markdown, markdownLanguage, decorate;
async function setup() {
  ({ EditorState: State } = await import('@codemirror/state'));
  ({ markdown, markdownLanguage } = await import('@codemirror/lang-markdown'));
  ({ liveDecorations: decorate } = await import('../src/markdown-editor.mjs'));
}
test('live decorations hide valid syntax, preserve literal code and never change the underlying Markdown', async () => {
  await setup();
  const doc = '# Heading\n\n**bold** *italic* ~~strike~~ `code` [label](https://example.com)\n\n> quote\n\n- item\n- [ ] task\n\n```md\n# literal\n**literal**\n```\n\n\\# escaped\n#hashtag\n';
  const state = State.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const { decorations, atomic } = decorate({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
  const hidden = [], headings = [];
  atomic.between(0, state.doc.length, (from, to) => hidden.push(state.doc.sliceString(from, to)));
  decorations.between(0, state.doc.length, (from, to, value) => { if (value.spec.class?.includes('md-heading')) headings.push(from); });
  assert.deepEqual(headings, [0]);
  for (const marker of ['# ', '**', '*', '~~', '`', '[', '](https://example.com)', '> ', '-', '[ ]', '```']) assert.ok(hidden.includes(marker), marker);
  assert.equal(state.doc.toString(), doc);
  assert.ok(!hidden.some(text => text.includes('literal')));
});
test('headings support a lone hash, all six levels, and ignore seven hashes and escaped markers', async () => {
  await setup();
  const doc = '#\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven\n\\# Escape\n';
  const state = State.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const ranges = decorate({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
  const headings = [];
  ranges.decorations.between(0, state.doc.length, (from, to, value) => { if (value.spec.class?.includes('md-heading')) headings.push(value.spec.class); });
  assert.equal(headings.length, 6);
  assert.ok(headings[5].includes('md-h6'));
});
