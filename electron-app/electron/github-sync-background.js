const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createSyncRpc } = require('./sync-rpc');

function createBackgroundGitHubSync({ root, directory, http, getToken, withLocalCommit }) {
  // Disk scans, hashing and Git pack work never run on Electron's UI/main thread.
  const worker = new Worker(path.join(__dirname, 'github-sync-worker.js'), { workerData: { root, directory } });
  const streams = new Map();
  let serial = 0;
  const closeStream = async id => {
    const stream = streams.get(id);
    streams.delete(id);
    await stream?.return?.();
  };
  const rpc = createSyncRpc(worker, {
    token: getToken,
    commit: () => withLocalCommit(() => rpc.call('apply')),
    http: async input => {
      const response = await http.request(input);
      const stream = ++serial;
      const iterable = response.body;
      streams.set(stream, iterable[Symbol.asyncIterator]?.() || iterable[Symbol.iterator]());
      const { body, ...metadata } = response;
      return { ...metadata, stream };
    },
    read: async id => {
      if (!streams.has(id)) throw new Error('同步传输已关闭。');
      return streams.get(id).next();
    },
    close: closeStream,
  });
  const fail = () => {
    rpc.close(new Error('后台同步意外停止，笔记和恢复记录已保留，请重试。'));
    for (const id of streams.keys()) void closeStream(id).catch(() => {});
  };
  worker.on('error', fail);
  worker.on('exit', fail);
  worker.unref();
  const service = {};
  let requests = 0;
  for (const method of ['status', 'configure', 'preview', 'inspectConflict', 'resolveConflicts', 'sync']) {
    service[method] = async input => {
      requests++; worker.ref();
      try { return await rpc.call('execute', { method, input }); }
      finally { if (--requests === 0) worker.unref(); }
    };
  }
  service.dispose = async () => { rpc.close(); await worker.terminate(); };
  return service;
}
module.exports = { createBackgroundGitHubSync };
