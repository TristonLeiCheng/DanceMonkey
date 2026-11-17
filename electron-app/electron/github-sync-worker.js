const { parentPort, workerData } = require('node:worker_threads');
const { createSyncRpc } = require('./sync-rpc');
const { createGitHubSync } = require('./github-sync');
let apply;
let service;
const handlers = {
  execute: ({ method, input }) => {
    if (!['status', 'configure', 'preview', 'inspectConflict', 'resolveConflicts', 'sync'].includes(method)) throw new Error('未知同步操作。');
    return service[method](input);
  },
  apply: () => {
    if (!apply) throw new Error('同步写入已失效。');
    const operation = apply;
    apply = null;
    return operation();
  },
};
const rpc = createSyncRpc(parentPort, handlers);
service = createGitHubSync({ ...workerData,
  getToken: () => rpc.call('token'),
  withLocalCommit: async operation => {
    apply = operation;
    try { return await rpc.call('commit'); } finally { apply = null; }
  },
  http: { request: async ({ url, method, headers, body }) => {
    const chunks = [];
    let size = 0;
    if (body) for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > 256 * 1024 * 1024) throw new Error('仓库单次传输超过 256 MiB。');
      chunks.push(chunk);
    }
    const response = await rpc.call('http', { url, method, headers, body: body ? chunks : undefined });
    return { ...response, body: (async function* () {
      try {
        while (true) {
          const chunk = await rpc.call('read', response.stream);
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally { await rpc.call('close', response.stream); }
    })() };
  } },
});
