const { parentPort, workerData } = require('node:worker_threads');
const { createFolderSyncService } = require('./folder-sync');
const service = createFolderSyncService(workerData.appDataPath);
const cancelled = new Int32Array(workerData.cancelled);
let lastProgress = 0;
(async () => {
  try {
    const result = workerData.method === 'preview' ? service.preview(workerData.profile) : await service.run(workerData.profile, {
      signal: { get aborted() { return Atomics.load(cancelled, 0) !== 0; } },
      onProgress: progress => {
        const now = Date.now();
        if (now - lastProgress < 100 && !progress.isCompleted && !progress.isCancelled) return;
        lastProgress = now;
        parentPort.postMessage({ progress });
      },
    });
    parentPort.postMessage({ result });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
})();
