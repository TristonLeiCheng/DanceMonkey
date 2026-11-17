const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createFolderSyncService } = require('./folder-sync');

function createBackgroundFolderSync(appDataPath) {
  const service = createFolderSyncService(appDataPath);
  function execute(method, profile, { signal, onProgress } = {}) {
    const cancelled = new SharedArrayBuffer(4);
    const flag = new Int32Array(cancelled);
    const abort = () => Atomics.store(flag, 0, 1);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'folder-sync-worker.js'), { workerData: { appDataPath, method, profile, cancelled } });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      worker.on('message', message => {
        if (message.progress) { onProgress?.(message.progress); return; }
        finish(message.error ? new Error(message.error) : null, message.result);
      });
      worker.on('error', error => finish(error));
      worker.on('exit', () => finish(new Error('后台文件夹同步已停止，请重试。')));
    });
  }
  return { ...service, preview: profile => execute('preview', profile), run: (profile, options) => execute('run', profile, options) };
}
module.exports = { createBackgroundFolderSync };
