const supported = file => /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name);
export function attachImageImport(host, { getSelection, insert, importImages, canImport = () => true, onBusy, onError }) {
  let pending = Promise.resolve(), busy = false;
  const filesFrom = transfer => Array.from(transfer?.files || []).filter(supported);
  function receive(event) {
    const files = filesFrom(event.clipboardData || event.dataTransfer);
    if (!files.length || event.target.closest('input, .md-insert-dialog')) return;
    event.preventDefault(); event.stopPropagation();
    if (!canImport() || busy) return;
    const selection = getSelection(event);
    busy = true; onBusy?.(true);
    pending = (async () => {
      if (files.length > 20 || files.some(file => file.size > 20 * 1024 * 1024) || files.reduce((n,f) => n + f.size,0) > 50 * 1024 * 1024) throw new Error('单张图片不能超过 20 MB，一次最多 20 张、共 50 MB。');
      const images = await Promise.all(files.map(async file => ({ name: file.name || 'clipboard.png', bytes: new Uint8Array(await file.arrayBuffer()) })));
      const result = await importImages(images);
      insert(result.map(item => item.markdown).join('\n\n'), selection);
    })().catch(error => { onError?.(error.message || '图片导入失败'); }).finally(() => { busy = false; onBusy?.(false); });
  }
  function dragover(event) {
    if (Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file') && canImport()) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
  }
  host.addEventListener('paste', receive, true); host.addEventListener('drop', receive, true); host.addEventListener('dragover', dragover, true);
  return { get busy() { return busy; }, flush: () => pending,
    destroy() { host.removeEventListener('paste', receive, true); host.removeEventListener('drop', receive, true); host.removeEventListener('dragover', dragover, true); } };
}
export function hydrateImages(preview, resolveImage) {
  for (const image of preview.querySelectorAll('img')) {
    const src = image.getAttribute('src');
    if (!src || /^https?:|^data:/i.test(src)) continue;
    // Do not allow packaged file:// pages to resolve relative to app.asar.
    image.removeAttribute('src');
    Promise.resolve().then(() => resolveImage(src)).then(url => { if (image.isConnected && url) image.src = url; }).catch(() => { image.title = '无法读取图片：' + src; });
  }
}
export function imageInsertion(text, markdown, { from, to }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const before = from && text[from - 1] !== '\n' ? eol + eol : '';
  const after = to < text.length && text[to] !== '\n' ? eol + eol : eol;
  return { from, to, insert: before + markdown.replace(/\r?\n/g,eol) + after };
}
