// Private, bidirectional RPC between the main process and a sync worker.
function createSyncRpc(port, handlers) {
  let serial = 0, closed = false;
  const pending = new Map();
  const receive = async (message) => {
    if (message.reply) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error)); else item.resolve(message.value);
      return;
    }
    try {
      if (!Object.hasOwn(handlers, message.method)) throw new Error('未知同步操作。');
      const value = await handlers[message.method](message.input);
      if (!closed) port.postMessage({ reply: true, id: message.id, value });
    } catch (error) {
      if (!closed) port.postMessage({ reply: true, id: message.id, error: error.message });
    }
  };
  port.on('message', receive);
  return {
    call(method, input) {
      if (closed) return Promise.reject(new Error('后台同步已停止，请重试。'));
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        try { port.postMessage({ id, method, input }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    close(error = new Error('后台同步已停止，请重试。')) {
      closed = true;
      port.off('message', receive);
      for (const item of pending.values()) item.reject(error);
      pending.clear();
    },
  };
}
module.exports = { createSyncRpc };
