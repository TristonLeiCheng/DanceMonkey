import { EditorState, Compartment, Prec, StateField } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, keymap, lineNumbers, highlightActiveLine, drawSelection, WidgetType } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree, ensureSyntaxTree, syntaxHighlighting, defaultHighlightStyle, codeFolding, foldService, foldEffect, unfoldAll } from '@codemirror/language';
import { defaultKeymap, undo, redo, isolateHistory, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

import { imageInsertion } from './note-image-import.mjs';
import { formatEdit } from './markdown-tools.mjs';

class BulletWidget extends WidgetType {
  toDOM() { const span = document.createElement('span'); span.className = 'md-bullet'; span.textContent = '•'; return span; }
}
class TaskWidget extends WidgetType {
  constructor(checked, from) { super(); this.checked = checked; this.from = from; }
  eq(other) { return other.checked === this.checked && other.from === this.from; }
  toDOM(view) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成'); input.className = 'md-task-checkbox';
    input.onmousedown = event => event.preventDefault();
    input.onchange = () => {
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? 'x' : ' ' } });
      view.focus();
    };
    return input;
  }
  ignoreEvent() { return true; }
}

// Block widgets commit edits back to Markdown; the source remains the document of record.
export function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
class MediaWidget extends WidgetType {
  constructor(kind, raw, from, resolveImage, block) { super(); Object.assign(this, { kind, raw, from, resolveImage, block }); }
  eq(other) { return this.kind === other.kind && this.raw === other.raw && this.from === other.from; }
  toDOM(view) {
    const box = document.createElement(this.block ? 'div' : 'span'); box.className = 'md-media'; box.contentEditable = 'false';
    const commit = text => view.dispatch({ changes: { from: this.from, to: this.from + this.raw.length, insert: text }, userEvent: 'input' });
    const button = (label, action) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = action; return b; };
    if (this.kind === 'Table') {
      const lines = this.raw.split('\n'), rows = [tableCells(lines[0]), ...lines.slice(2).map(tableCells)];
      const aligns = tableCells(lines[1]);
      const table = document.createElement('table');
      const write = () => commit([rows[0], aligns, ...rows.slice(1)].map(row => '| ' + row.map(v => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ') + ' |').join('\n'));
      rows.forEach((row, ri) => {
        const tr = table.insertRow();
        aligns.forEach((_, ci) => {
          const cell = document.createElement(ri === 0 ? 'th' : 'td');
          const input = document.createElement('input'); input.value = row[ci] || ''; input.setAttribute('aria-label', `第 ${ri + 1} 行第 ${ci + 1} 列`);
          input.oninput = () => { rows[ri][ci] = input.value; };
          // Commit on blur keeps IME and cursor stable while typing.
          input.onchange = write; cell.append(input); tr.append(cell);
        });
      });
      box.append(table, button('＋ 行', () => { rows.push(aligns.map(() => '')); write(); }), button('＋ 列', () => { aligns.push('---'); rows.forEach(r => r.push('')); write(); }));
    } else {
      const match = this.raw.match(/^!\[([^\]]*)\]\(<?([^>]*?)>?(?:\s+"([^"]*)")?\)$/);
      if (!match) { box.textContent = this.raw; return box; }
      const [, alt, src, title = ''] = match;
      const img = document.createElement('img'); img.alt = alt; img.title = title;
      const message = document.createElement('span'); message.className = 'md-media-status';
      img.onerror = () => { message.textContent = '图片无法读取，请检查路径'; };
      Promise.resolve().then(() => this.resolveImage(src)).then(url => { if (url) img.src = url; else message.textContent = '图片无法读取，请检查路径'; }).catch(() => { message.textContent = '图片无法读取，请检查路径'; });
      const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '编辑图片'; details.append(summary);
      const fields = [alt, src, title].map((value, i) => { const label = document.createElement('label'), input = document.createElement('input'); label.textContent = ['替代文字', '图片路径或网址', '标题'][i]; input.value = value; label.append(input); details.append(label); return input; });
      details.append(button('应用', () => {
        const [a, url, t] = fields.map(f => f.value.replace(/\r?\n/g, ' ').trim());
        if (!url || /[<>]/.test(url)) return;
        commit(`![${a.replace(/\]/g, '\\]')}](<${url}>${t ? ' "' + t.replace(/"/g, '&quot;') + '"' : ''})`);
      }));
      box.append(img, message, details);
    }
    box.append(button('编辑 Markdown 源码', () => { view.dom.dispatchEvent(new CustomEvent('md-source-request', { bubbles: true })); if (view.destroyed) return; view.dispatch({ selection: { anchor: this.from } }); view.focus(); }));
    return box;
  }
  ignoreEvent() { return true; }
}
function mediaField(resolveImage) {
  const build = state => {
    const ranges = [];
    const tree = ensureSyntaxTree(state, state.doc.length, 100) || syntaxTree(state);
    tree.iterate({ enter(node) {
      if (node.name !== 'Table' && node.name !== 'Image') return;
      const block = state.doc.lineAt(node.from).from === node.from && state.doc.lineAt(node.to).to === node.to;
      const raw = state.doc.sliceString(node.from, node.to);
      if (node.name === 'Image' && !/^!\[.*\]\(/.test(raw)) return;
      ranges.push(Decoration.replace({ block, widget: new MediaWidget(node.name, raw, node.from, resolveImage, block) }).range(node.from, node.to));
      return false;
    } });
    return Decoration.set(ranges, true);
  };
  return StateField.define({ create: build, update: (value, tr) => tr.docChanged ? build(tr.state) : value,
    provide: field => EditorView.decorations.from(field) });
}

// Presentation only: Markdown, clipboard and undo history retain every delimiter.
export function liveDecorations(view) {
  const ranges = [], hidden = [], seen = new Set(), visited = new Set();
  const { state } = view, tree = syntaxTree(state);
  const hide = (from, to) => {
    if (to > from && !state.doc.sliceString(from, to).includes('\n')) {
      const range = Decoration.replace({}).range(from, to);
      ranges.push(range); hidden.push(range);
    }
  };
  const mark = (from, to, className, attributes) => {
    if (to > from) ranges.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  for (const visible of view.visibleRanges) {
    for (let pos = state.doc.lineAt(visible.from).from; pos <= visible.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        let code = false;
        for (let node = tree.resolveInner(line.from, 1); node; node = node.parent) {
          if (['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(node.name)) code = true;
        }
        const heading = !code && line.text.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)/);
        if (heading) {
          ranges.push(Decoration.line({ class: `md-heading md-h${heading[1].length}` }).range(line.from));
          hide(line.from, line.from + heading[0].length);
        }
      }
      if (line.to === state.doc.length) break;
      pos = line.to + 1;
    }
    tree.iterate({ from: visible.from, to: visible.to, enter(node) {
      if (node.name === 'Table' || node.name === 'Image') return false;
      const name = node.name, id = `${name}:${node.from}:${node.to}`;
      if (visited.has(id)) return false;
      visited.add(id);
      const styles = { StrongEmphasis: 'md-strong', Emphasis: 'md-emphasis', Strikethrough: 'md-strike', InlineCode: 'md-inline-code' };
      if (styles[name]) mark(node.from, node.to, styles[name]);
      if (['EmphasisMark', 'StrikethroughMark'].includes(name) || name === 'CodeMark' && node.node.parent?.name === 'InlineCode') hide(node.from, node.to);
      if (name === 'QuoteMark') {
        const line = state.doc.lineAt(node.from);
        ranges.push(Decoration.line({ class: 'md-quote' }).range(line.from));
        hide(node.from, Math.min(line.to, node.to + (state.doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0)));
      }
      if (name === 'ListMark') {
        const marker = state.doc.sliceString(node.from, node.to);
        if (/^[-+*]$/.test(marker)) {
          const task = /^\s*\[[ xX]\]/.test(state.doc.sliceString(node.to, state.doc.lineAt(node.to).to));
          const range = Decoration.replace({ widget: task ? undefined : new BulletWidget() }).range(node.from, node.to);
          ranges.push(range); hidden.push(range);
        } else mark(node.from, node.to, 'md-list-marker');
      }
      if (name === 'TaskMarker') {
        const range = Decoration.replace({ widget: new TaskWidget(/x/i.test(state.doc.sliceString(node.from, node.to)), node.from) }).range(node.from, node.to);
        ranges.push(range); hidden.push(range);
      }
      if (name === 'CodeMark' && node.node.parent?.name === 'FencedCode') hide(node.from, node.to);
      if (name === 'Link') {
        const children = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) children.push(child);
        const delimiters = children.filter(child => child.name === 'LinkMark');
        if (delimiters.length >= 2) {
          hide(delimiters[0].from, delimiters[0].to);
          hide(delimiters[1].from, node.to);
          const address = children.find(child => child.name === 'URL');
          mark(delimiters[0].to, delimiters[1].from, 'md-link', { title: address ? state.doc.sliceString(address.from, address.to) : '' });
        }
      }
      if (name === 'FencedCode' || name === 'CodeBlock') {
        for (let pos = state.doc.lineAt(node.from).from; pos <= node.to;) {
          const line = state.doc.lineAt(pos);
          ranges.push(Decoration.line({ class: 'md-code-block' }).range(pos));
          if (line.to >= state.doc.length) break;
          pos = line.to + 1;
        }
      }
      if (name === 'HeaderMark' && node.node.parent?.name.startsWith('ATXHeading') && node.from > state.doc.lineAt(node.from).from + 3) hide(node.from, node.to);
    } });
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(hidden, true) };
}
const livePlugin = ViewPlugin.fromClass(class {
  constructor(view) { Object.assign(this, liveDecorations(view)); }
  update(update) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) Object.assign(this, liveDecorations(update.view));
  }
}, { decorations: plugin => plugin.decorations });

export function createMarkdownEditor(parent, { content, mode = 'live', onChange, onSave, resolveImage = src => /^https?:|^data:image\//i.test(src) ? src : '' }) {
  const presentation = new Compartment();
  let lineBreak = content.includes('\r\n') ? '\r\n' : '\n';
  const serialize = state => state.doc.toString().replace(/\n/g, lineBreak);
  const inCode = (state, pos) => {
    for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
      if (['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(node.name)) return true;
    }
    return false;
  };
  const frontmatter = text => text.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/)?.[0];
  const media = mediaField(resolveImage);
  const live = () => [media, livePlugin, EditorView.atomicRanges.of(view => view.plugin(livePlugin)?.atomic || Decoration.none),
    Prec.high(keymap.of([
      { key: 'Backspace', run(view) {
        const selection = view.state.selection.main;
        if (!selection.empty) return false;
        const line = view.state.doc.lineAt(selection.head), heading = line.text.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/);
        if (!heading || selection.head > line.from + heading[0].length || inCode(view.state, selection.head)) return false;
        view.dispatch({ changes: { from: line.from, to: line.from + heading[0].length }, selection: { anchor: line.from }, userEvent: 'delete.backward' });
        return true;
      } },
      { key: 'Enter', run(view) {
        const selection = view.state.selection.main, line = view.state.doc.lineAt(selection.head);
        if (!selection.empty || !/^ {0,3}#{1,6}[ \t]*$/.test(line.text) || inCode(view.state, selection.head)) return false;
        view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from }, userEvent: 'input' });
        return true;
      } },
    ])),
    EditorView.inputHandler.of((view, from, to, text) => {
      const line = view.state.doc.lineAt(from);
      // A typed '#' starts a heading immediately. Further '#' characters grow
      // the heading level while the inserted separator remains invisible.
      if (text !== '#' || from !== to || from !== line.to || view.composing) return false;
      if (inCode(view.state, from)) return false;
      if (!/^ {0,3}(?:#{1,5} )?$/.test(line.text)) return false;
      const start = line.text.endsWith(' ') && line.text.trim() ? from - 1 : from;
      view.dispatch({ changes: { from: start, to, insert: '# ' }, selection: { anchor: start + 2 }, userEvent: 'input.type' });
      return true;
    }),
  ];
  const source = () => [lineNumbers(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle)];
  const view = new EditorView({ parent, state: EditorState.create({ doc: content, extensions: [
    markdown({ base: markdownLanguage }), history(), drawSelection(), highlightSelectionMatches(),
    EditorView.lineWrapping, codeFolding(), foldService.of((state, from) => {
      const header = frontmatter(state.doc.toString());
      return from === 0 && header ? { from: 0, to: header.length } : null;
    }),
    keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown 文档编辑器', spellcheck: 'false' }),
    EditorView.updateListener.of(update => { if (update.docChanged) onChange(serialize(update.state)); }),
    presentation.of(mode === 'live' ? live() : source()),
  ] }) });
  function foldMetadata() {
    const header = frontmatter(view.state.doc.toString());
    if (header) view.dispatch({ effects: foldEffect.of({ from: 0, to: header.length }) });
  }
  if (mode === 'live') foldMetadata();
  return {
    view, text: () => { const active = document.activeElement; if (active?.tagName === 'INPUT' && active.closest('.md-media') && view.dom.contains(active)) active.blur(); return serialize(view.state); },
    insertImageMarkdown(markdown, selection) {
      const changes = imageInsertion(view.state.doc.toString(), markdown, selection);
      view.dispatch({ changes, selection: { anchor: changes.from + changes.insert.length }, userEvent: 'input', annotations: isolateHistory.of('full'), scrollIntoView: true });
      view.focus();
    },
    command(action, options) {
      if (action === 'undo' || action === 'redo') { (action === 'undo' ? undo : redo)(view); view.focus(); return; }
      const selection = view.state.selection.main;
      const change = formatEdit(view.state.doc.toString(), selection.from, selection.to, action, options);
      if (!change) return;
      view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert }, selection: { anchor: change.anchor, head: change.head }, userEvent: 'input', annotations: isolateHistory.of('full'), scrollIntoView: true });
      view.focus();
    },
    setMode(next) {
      view.dispatch({ effects: presentation.reconfigure(next === 'live' ? live() : source()) });
      if (next === 'live') foldMetadata(); else unfoldAll(view);
    },
    replace(text) {
      lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus: () => view.focus(), destroy: () => view.destroy(),
  };
}
