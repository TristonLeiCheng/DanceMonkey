const crypto = require("node:crypto");

function createGitHubCoordinator({ getParticipants, timeout = 15000 }) {
  let busy = false;
  let locked = false;
  let generation = 0;
  const waiting = new Map();

  function acknowledge(sender, payload = {}) {
    const pending = waiting.get(payload.id);
    if (!pending || !pending.senders.has(sender)) return;
    pending.senders.delete(sender);
    if (payload.error) pending.fail(new Error("笔记编辑器未能保存或刷新，请先完成或关闭任务/项目编辑后重试。"));
    else if (!pending.senders.size) pending.finish();
  }

  function request(participants, phase) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        waiting.delete(id);
      };
      const pending = {
        senders: new Set(participants),
        finish: () => { cleanup(); resolve(); },
        fail: (error) => { cleanup(); reject(error); },
      };
      const timer = setTimeout(() => pending.fail(new Error("等待笔记编辑器响应超时，未开始新的同步操作。")), timeout);
      waiting.set(id, pending);
      if (!participants.length) return pending.finish();
      for (const sender of participants) {
        if (sender.isDestroyed()) { pending.fail(new Error("笔记窗口已关闭，请重试。")); break; }
        sender.send("githubSync:editor", { id, phase, generation });
      }
    });
  }

  function assertWritable(expectedGeneration) {
    if (locked) throw new Error("正在同步笔记，请稍后再编辑。");
    if (expectedGeneration !== undefined && expectedGeneration !== generation) {
      throw new Error("笔记版本已更新，请重新打开笔记后再编辑。");
    }
  }

  async function run(operation) {
    if (busy) throw new Error("已有笔记同步操作正在进行。");
    busy = true;
    const participants = getParticipants();
    try {
      await request(participants, "prepare");
      if (participants.some((sender) => sender.isDestroyed())) throw new Error("笔记窗口已关闭，请重试。");
      locked = true;
      return await operation();
    } finally {
      locked = false;
      generation += 1;
      try {
        await request(participants.filter((sender) => !sender.isDestroyed()), "resume");
      } finally {
        busy = false;
      }
    }
  }

  return { run, acknowledge, assertWritable, get busy() { return busy; }, get generation() { return generation; } };
}

module.exports = { createGitHubCoordinator };
