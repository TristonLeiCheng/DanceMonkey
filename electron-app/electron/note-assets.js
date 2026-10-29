const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(0,2).toString() === 'BM') return 'bmp';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg(?:\s|>)/i.test(bytes.subarray(0,4096).toString('utf8'))) return 'svg';
  throw new Error('请使用 PNG、JPEG、GIF、WebP、BMP 或 SVG 图片。');
}
function saveNoteImages(workspace, documentPath, images) {
  workspace.read(documentPath); // Validate the same document/path rules as editing.
  if (!Array.isArray(images) || !images.length || images.length > 20) throw new Error('每次可导入 1–20 张图片。');
  let total = 0;
  const items = images.map(item => {
    if (!item || !(item.bytes instanceof Uint8Array)) throw new Error('无效的图片内容。');
    const bytes = Buffer.from(item.bytes);
    total += bytes.length;
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > 50 * 1024 * 1024) throw new Error('单张图片不能超过 20 MB，一次导入不能超过 50 MB。');
    const ext = imageExtension(bytes);
    const name = path.basename(String(item.name || 'image'), path.extname(String(item.name || ''))).normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0,60) || 'image';
    return { bytes, name, ext };
  });
  const root = fs.realpathSync(workspace.root), doc = path.resolve(root, documentPath);
  if (!doc.startsWith(root + path.sep)) throw new Error('无效的文档位置。');
  const folder = path.join(path.dirname(doc), 'images');
  try { fs.mkdirSync(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fs.lstatSync(folder).isSymbolicLink() || !fs.statSync(folder).isDirectory() || fs.realpathSync(folder) !== folder) throw new Error('images 必须是文档旁的普通文件夹，不能是符号链接。');
  const created = [];
  try {
    return items.map(({ bytes, name, ext }) => {
      const file = `${name}-${randomUUID()}.${ext}`, target = path.join(folder, file);
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); created.push(target);
      return { path: `images/${file}`, markdown: `![${name}](<images/${file}>)` };
    });
  } catch (error) {
    for (const file of created) { try { fs.unlinkSync(file); } catch {} }
    throw error;
  }
}
module.exports = { saveNoteImages, imageExtension, MAX_IMAGE_BYTES };
