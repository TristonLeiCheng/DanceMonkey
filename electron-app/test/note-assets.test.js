const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWorkspace } = require('../electron/workspace');
const { saveNoteImages } = require('../electron/note-assets');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dm-assets-'))); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'notes')); fs.writeFileSync(path.join(root,'notes','文档.md'),'# test');
  return createWorkspace(root);
}
test('imports bytes next to the document, returns relative Markdown, never overwrites same-name images', t => {
  const ws = fixture(t);
  const files = saveNoteImages(ws, 'notes/文档.md', [{name:'photo.png', bytes:png},{name:'photo.png',bytes:png}]);
  assert.notEqual(files[0].path, files[1].path);
  for(const file of files) { assert.match(file.markdown,/!\[photo\]\(<images\/photo-.*\.png>\)/); assert.deepEqual(fs.readFileSync(path.join(ws.root,'notes',file.path)),png); }
  assert.equal(ws.read('notes/文档.md'),'# test');
});
test('rejects malformed/oversize batches before saving, missing documents and symlink image directories', t => {
  const ws = fixture(t);
  assert.throws(()=>saveNoteImages(ws,'notes/文档.md',[{name:'ok.png',bytes:png},{name:'bad.png',bytes:Buffer.from('text')}]),/PNG/);
  assert.equal(fs.existsSync(path.join(ws.root,'notes/images')),false);
  assert.throws(()=>saveNoteImages(ws,'notes/文档.md',[{bytes:Buffer.alloc(21*1024*1024)}]),/20 MB/);
  assert.throws(()=>saveNoteImages(ws,'missing.md',[{bytes:png}]));
  fs.symlinkSync(os.tmpdir(),path.join(ws.root,'notes/images'));
  assert.throws(()=>saveNoteImages(ws,'notes/文档.md',[{bytes:png}]),/符号链接/);
});
