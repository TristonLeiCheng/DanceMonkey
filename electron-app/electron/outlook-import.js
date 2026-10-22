const crypto = require("node:crypto");
const { emailAddress, sinceDate } = require("./persona-email");

function createOutlookImporter({ auth, mail, personas }) {
  const requests = new Map();
  const people = new Set();
  function cancel(requestId) {
    const request = requests.get(requestId);
    if (!request || request.controller.signal.aborted) return false;
    request.controller.abort();
    personas.cancel(request.generationId);
    return true;
  }
  function cancelAll() { for (const id of requests.keys()) cancel(id); }
  async function importAndGenerate(input, onProgress = () => {}) {
    if (!input || typeof input.id !== "string" || typeof input.requestId !== "string" || !/^[\w-]{1,120}$/.test(input.requestId)) throw new Error("邮件导入请求无效。");
    if (requests.has(input.requestId) || people.has(input.id)) throw new Error("此人物正在导入邮件，请等待完成。");
    if (requests.size >= 4) throw new Error("当前导入任务较多，请稍后重试。");
    const email = emailAddress(input.email);
    const since = sinceDate(input.since === undefined ? new Date(Date.now() - 365 * 86400000).toISOString() : input.since);
    const request = { controller: new AbortController(), generationId: "outlook-" + crypto.randomUUID() };
    requests.set(input.requestId, request); people.add(input.id);
    let imported = false;
    const check = () => { if (request.controller.signal.aborted) throw new Error("邮件导入已停止。"); };
    const progress = (message) => { check(); onProgress(message); };
    try {
      // Freeze the AI destination when the user clicks Import, before fetching mail.
      const client = personas.captureModel?.();
      const before = await personas.get(input.id); check();
      const session = await auth.session(); check(); session.assertCurrent();
      if (before.outlook && (before.outlook.accountId !== session.accountId || before.outlook.email !== email)) {
        throw new Error("此人物已关联其他邮箱或账户，请连接原账户；其他人物请新建分身。");
      }
      const assertCurrent = () => { check(); session.assertCurrent(); };
      progress("正在按人物邮箱搜索邮件…");
      const result = await mail.search({ session, email, since, limit: 200, signal: request.controller.signal,
        onProgress: (value) => progress(typeof value === "string" ? value : `正在检查邮件：已检查 ${value.scanned || 0} 封，可导入 ${value.imported || 0} 封，跳过 ${value.skipped || 0} 封…`) });
      assertCurrent();
      if (!result.messages.length && !before.outlook) {
        throw new Error(`本次检查 ${result.scanned || 0} 封邮件，没有找到可用于学习的正文。请检查人物邮箱、时间范围或邮件内容。`);
      }
      const reasons = result.skipped || {};
      const duplicates = typeof reasons === "object" ? (reasons.duplicate || 0) : 0;
      const skipped = typeof reasons === "number" ? reasons : Object.values(reasons).reduce((n, count) => n + count, 0) - duplicates;
      const saved = await personas.importEmails({ id: input.id, email, since,
        accountId: session.accountId, accountUsername: session.username, messages: result.messages,
        stats: { found: result.scanned || 0, duplicates, skipped, hasMore: result.hasMore, skipReasons: reasons } }, assertCurrent);
      imported = true;
      assertCurrent();
      const unchanged = !saved.stats.added && !saved.stats.updated;
      if (unchanged && saved.persona.card && saved.persona.cardSourceRevision === saved.persona.sourceRevision) {
        return { ...saved, preview: null, unchanged: true };
      }
      if (!saved.persona.sources.length) return { ...saved, preview: null, unchanged };
      progress("邮件已保存，正在生成人物卡预览…");
      const preview = await personas.generate({ id: input.id, requestId: request.generationId },
        (message) => { assertCurrent(); progress(message); }, { client });
      assertCurrent();
      return { persona: await personas.get(input.id), stats: saved.stats, preview, unchanged };
    } catch (error) {
      const message = request.controller.signal.aborted ? "已停止 Outlook 导入。" : (error?.message || "Outlook 导入失败。");
      throw new Error(imported ? `${message} 邮件资料已保存在本机，人物卡未覆盖；可重新生成人物卡预览。` : message);
    } finally {
      requests.delete(input.requestId); people.delete(input.id);
    }
  }
  return { importAndGenerate, cancel, cancelAll };
}

module.exports = { createOutlookImporter };
