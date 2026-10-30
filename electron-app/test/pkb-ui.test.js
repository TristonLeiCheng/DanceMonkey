const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/workspace-app.js"), "utf8");
const functions = source.slice(source.indexOf("  async function openPkbSetup("), source.indexOf("  function openDialog("));
function harness(api) {
  const html = [];
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, { value: "", focus() {}, disabled: false });
    return elements.get(key);
  };
  const root = { insertAdjacentHTML: (_position, content) => html.push(content), querySelector: element };
  const errors = [];
  const context = vm.createContext({
    api: { pkb: api }, root, esc: (s) => String(s).replaceAll("<", "&lt;"), attr: String,
    saveActive: async () => {}, closeDialog() {}, closePalette() {},
    refreshTree: async () => {}, openFile: async () => {}, expandAncestors() {},
    alert: (error) => errors.push(error),
  });
  vm.runInContext(`let vaultRoot='/A', syncPaused=false, vaultSwitching=false, dialog=null, paletteOpen=false; ${functions}`, context);
  return { context, html, element, errors, run: (code) => vm.runInContext(code, context) };
}

test("Markdown preview separates metadata without interpreting it as HTML", () => {
  const fn = source.slice(source.indexOf("  function renderMarkdown("), source.indexOf("  function treeIcon("));
  const context = vm.createContext({
    window: { DMNoteDetails: { model: require('../src/note-details-model') }, marked: { parse: (value) => `<article>${value}</article>` }, DOMPurify: { sanitize: (value) => value } },
    esc: (value) => String(value).replaceAll("<", "&lt;"),
  });
  vm.runInContext(fn, context);
  const rendered = vm.runInContext(`renderMarkdown('---\\nid: "<script>"\\ntype: note\\n---\\n# Body')`, context);
  assert.match(rendered, /<details/);
  assert.match(rendered, /&lt;script>/);
  assert.match(rendered, /<article># Body<\/article>/);
  assert.doesNotMatch(rendered, /<article>.*id:/);
});

test("PKB preview does not initialize and escapes file names", async () => {
  let writes = 0;
  const h = harness({ preview: async () => ({ status: { initialized: false }, directories: ["<unsafe>"], files: [], warnings: [] }), initialize: async () => { writes++; return {}; } });
  await h.run("openPkbSetup()");
  assert.equal(writes, 0);
  assert.match(h.html[0], /&lt;unsafe>/);
  assert.match(h.html[0], /不是加密保险库/);
  await h.element('[data-pkb="initialize"]').onclick();
  assert.equal(writes, 1);
});

test("late PKB preview cannot open a dialog in another vault", async () => {
  let complete;
  const h = harness({ preview: () => new Promise((resolve) => { complete = resolve; }) });
  const opening = h.run("openPkbSetup()");
  await new Promise(setImmediate);
  h.run("vaultRoot='/B'");
  complete({ status: { initialized: false }, directories: [], files: [], warnings: [] });
  await opening;
  assert.equal(h.html.length, 0);
});

test("search ignores late results after switching vaults", async () => {
  let finish;
  const h = harness({ search: () => new Promise((resolve) => { finish = resolve; }) });
  const backdrop = h.element(".ws-palette-backdrop");
  backdrop.isConnected = true;
  backdrop.querySelector = h.element;
  h.run("openPkbSearch()");
  const input = h.element(".ws-palette-input");
  const list = h.element(".ws-palette-list");
  input.value = "needle";
  const searching = input.onkeydown({ key: "Enter" });
  await new Promise(setImmediate);
  h.run("vaultRoot='/B'");
  finish([{ path: "old.md", title: "Old vault", snippet: "needle" }]);
  await searching;
  assert.equal(list.innerHTML, undefined);
});

test("template creation keeps user input when saving the current document fails", async () => {
  let writes = 0;
  const h = harness({ preview: async () => ({ status: { initialized: true } }), createNote: async () => { writes++; } });
  await h.run("openPkbNote()");
  h.context.saveActive = async () => { throw new Error("disk full"); };
  h.element(".ws-dialog-input").value = "New note";
  h.element(".ws-pkb-type").value = "note";
  await h.element('[data-pkb="create"]').onclick();
  assert.equal(writes, 0);
  assert.equal(h.element(".ws-dialog-input").value, "New note");
  assert.equal(h.element('[data-pkb="create"]').disabled, false);
  assert.deepEqual(h.errors, ["disk full"]);
});
