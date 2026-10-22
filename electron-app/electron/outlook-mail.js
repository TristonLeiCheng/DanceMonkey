"use strict";

const { createHash } = require("node:crypto");
const { Parser } = require("htmlparser2");

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/me";
const MAX_MAIL_CHARS = 16000;
const MAX_RAW_CHARS = 512000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MESSAGE_FIELDS = "id,internetMessageId,conversationId,subject,sentDateTime,receivedDateTime,webLink,from,sender,isDraft,parentFolderId";
const DETAIL_FIELDS = `${MESSAGE_FIELDS},uniqueBody,body,internetMessageHeaders`;
const SKIP_REASONS = ["duplicate", "notAuthor", "draft", "excludedFolder", "automated", "empty", "tooLong", "unavailable"];
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "li", "ul", "ol", "table", "tr", "h1", "h2", "h3", "h4", "pre", "br", "hr"]);
const OMIT_TAGS = new Set(["script", "style", "head", "template", "noscript", "svg", "math", "iframe", "object", "blockquote"]);

function normalizeEmail(value) {
  if (typeof value !== "string") throw new Error("请输入有效的人物邮箱地址");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email)) {
    throw new Error("请输入有效的人物邮箱地址");
  }
  const [local, domain] = email.split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || domain.split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))) {
    throw new Error("请输入有效的人物邮箱地址");
  }
  return email;
}

function address(recipient) {
  try { return normalizeEmail(recipient?.emailAddress?.address); } catch { return ""; }
}

// This is an inert parser: it never creates a browser document, evaluates code,
// follows links, or downloads an image. Known reply containers are not evidence
// of the current author's writing, even when Graph returns them in uniqueBody.
function htmlText(html) {
  const pieces = [];
  const stack = [];
  let omitted = 0;
  let ended = false;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (!omitted && /^(?:x_)?(?:divrplyfwdmsg|replyforwardmsg)$/i.test(attrs.id || "")) ended = true;
      const markers = `${attrs.id || ""} ${attrs.class || ""}`;
      const ignore = OMIT_TAGS.has(name)
        || /(?:^|\s)(?:x_)?(?:gmail_quote|yahoo_quoted|protonmail_quote|gmail_signature|moz-signature|signature)(?:\s|$)/i.test(markers)
        || attrs.hidden !== undefined || attrs["aria-hidden"] === "true"
        || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || "");
      stack.push(ignore);
      if (ignore) omitted += 1;
      if (!omitted && !ended && BLOCK_TAGS.has(name)) pieces.push("\n");
    },
    ontext(value) { if (!omitted && !ended) pieces.push(value); },
    onclosetag(name) {
      if (!omitted && !ended && BLOCK_TAGS.has(name)) pieces.push("\n");
      if (!omitted && !ended && (name === "td" || name === "th")) pieces.push(" ");
      if (stack.pop()) omitted -= 1;
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
  return pieces.join("");
}

function isReplyHeader(lines, index) {
  const line = lines[index].trim();
  if (/^(?:-{2,}\s*(?:original message|forwarded message|原始邮件|原邮件|转发邮件)\s*-*|begin forwarded message\s*:|转发的邮件\s*[：:])/i.test(line)) return true;
  if (/^(?:在\s*)?.{1,300}(?:写道|寫道)[：:]\s*$/.test(line)) return true;
  if (/^On\s/i.test(line)) {
    for (let length = 1; length <= 4; length += 1) {
      if (/^On\s.{1,600}\bwrote:\s*$/i.test(lines.slice(index, index + length).join(" ").trim())) return true;
    }
  }
  if (/^(?:From|发件人|寄件者|寄件人)\s*[：:]/i.test(line)) {
    const following = lines.slice(index + 1, index + 8).filter((value) => /^(?:Sent|Date|To|Cc|Subject|发送时间|傳送時間|寄件日期|日期|收件人|收件者|抄送|主旨|主题)\s*[：:]/i.test(value.trim()));
    return following.length >= 2;
  }
  return false;
}

/** Return only plausible new author text; never use the truncated bodyPreview. */
function cleanMailBody(body) {
  if (!body || typeof body.content !== "string") return "";
  if (body.content.length > MAX_RAW_CHARS) throw Object.assign(new Error("邮件正文过长"), { code: "MAIL_TOO_LONG" });
  let text = body.contentType?.toLowerCase() === "html" ? htmlText(body.content) : body.content;
  text = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200c\u200d\ufeff]/g, "");
  const lines = text.split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (isReplyHeader(lines, index)) break;
    if (/^\s*>/.test(lines[index])) continue;
    if (/^--\s*$/.test(line) || /^(?:Sent from my\b|Sent from (?:Outlook|Mail)\b|Get Outlook for\b|发自我的|從我的|获取 Outlook|取得 Outlook)/i.test(line)) break;
    if (/^(?:(?:This (?:e-?mail|message)|The information contained).{0,100}(?:confidential|privileged)|本(?:邮件|電子郵件|电子邮件).{0,60}(?:保密|机密|機密)|免责声明[：:]?)/i.test(line)) break;
    if (/^_{5,}$/.test(line)) continue;
    kept.push(lines[index].replace(/[\t ]+/g, " ").trimEnd());
    // Keep a human sign-off as style evidence but not the contact card below it.
    if (/^(?:(?:best|kind|warm)\s+regards|regards|sincerely|此致|顺颂商祺)[,，!！.。]?$/i.test(line)) break;
  }
  return kept.join("\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function abortError(message = "邮件导入已取消") { return Object.assign(new Error(message), { name: "AbortError" }); }
function assertNotAborted(signal) { if (signal.aborted) throw signal.reason || abortError(); }
function cancellable(promise, signal) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    assertNotAborted(signal);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function graphURL(value, expectedPath) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Outlook 返回了无效的分页地址"); }
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash
    || !/^\/v1\.0\/me\/(?:messages(?:\/[^/]+)?|mailFolders\/[^/]+)$/.test(url.pathname)
    || (expectedPath && url.pathname !== expectedPath)) {
    throw new Error("Outlook 返回了不受信任的分页地址");
  }
  return url.toString();
}

function graphError(status, code) {
  let message = `Outlook 邮件读取失败（HTTP ${status}），请稍后重试`;
  if (status === 401) message = "Outlook 登录已过期，请重新连接账号";
  if (status === 403) message = "Outlook 无权读取邮件，请确认微软应用的 Mail.Read 委托权限及公司管理员授权";
  if (status === 429) message = "Outlook 请求过于频繁，请稍后再导入";
  return Object.assign(new Error(message), { status, code: typeof code === "string" ? code.slice(0, 100) : "GRAPH_ERROR" });
}

async function readJSON(response, signal) {
  const advertised = Number(response.headers?.get("content-length"));
  if (advertised > MAX_RESPONSE_BYTES) throw new Error("Outlook 返回的邮件数据过大，请缩小时间范围");
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let finished = false;
    try {
      while (true) {
        const item = await cancellable(reader.read(), signal);
        if (item.done) { finished = true; break; }
        size += item.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("Outlook 返回的邮件数据过大，请缩小时间范围");
        chunks.push(Buffer.from(item.value));
      }
      text = Buffer.concat(chunks).toString("utf8");
    } finally {
      if (!finished) reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    text = await cancellable(response.text(), signal);
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Outlook 返回的邮件数据过大，请缩小时间范围");
  }
  try { return JSON.parse(text); } catch { throw new Error("Outlook 返回的邮件数据格式无效，请稍后重试"); }
}

function isAutomated(message) {
  if (message["@odata.type"] && message["@odata.type"] !== "#microsoft.graph.message") return true;
  if (/^(?:automatic reply|auto(?:matic)?[- ]?response|auto[- ]?reply|out of office|自动(?:回复|答复)|自動(?:回覆|答覆)|(?:accepted|declined|tentative|已接受|已拒绝|暂定)[：:])/i.test(message.subject || "")) return true;
  const headers = Array.isArray(message.internetMessageHeaders) ? message.internetMessageHeaders : [];
  return headers.some(({ name, value } = {}) => {
    const key = typeof name === "string" ? name.toLowerCase() : "";
    if (typeof value !== "string") return false;
    return (key === "auto-submitted" && value.trim().toLowerCase() !== "no")
      || (key === "precedence" && /^(?:bulk|list|junk)$/i.test(value.trim())) || key === "list-id";
  });
}

function safeWebLink(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && ["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(url.hostname) ? url.toString() : "";
  } catch { return ""; }
}

function createOutlookMailClient({ fetch: fetchImpl = globalThis.fetch, requestTimeoutMs = 30000, overallTimeoutMs = 180000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Outlook 邮件请求服务不可用");

  async function search({ session, email, since, limit = 200, signal, onProgress } = {}) {
    const target = normalizeEmail(email);
    if (!session || typeof session.getAccessToken !== "function" || typeof session.assertCurrent !== "function" || !session.accountId) throw new Error("请先连接 Outlook 账号");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("每次最多检查 200 封邮件");
    if (since !== undefined && since !== null && (typeof since !== "string" || !since.trim())) throw new Error("邮件起始日期无效");
    const date = since === null ? new Date("1900-01-01T00:00:00Z") : since === undefined ? new Date(Date.now() - 365 * 86400000) : new Date(since);
    if (!Number.isFinite(date.getTime())) throw new Error("邮件起始日期无效");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(abortError());
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    const timeout = setTimeout(() => controller.abort(abortError("Outlook 导入超时，请缩小时间范围后重试")), overallTimeoutMs);
    const workSignal = controller.signal;
    const check = async () => { assertNotAborted(workSignal); await cancellable(session.assertCurrent(), workSignal); assertNotAborted(workSignal); };

    async function request(input) {
      const url = graphURL(input);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await check();
        const requestController = new AbortController();
        const cancelRequest = () => requestController.abort(workSignal.reason || abortError());
        workSignal.addEventListener("abort", cancelRequest, { once: true });
        const requestTimer = setTimeout(() => requestController.abort(abortError("Outlook 请求超时，请稍后重试")), requestTimeoutMs);
        let retryDelay;
        try {
          const accessToken = await cancellable(session.getAccessToken(), requestController.signal);
          await check();
          if (typeof accessToken !== "string" || !accessToken) throw new Error("Outlook 登录已过期，请重新连接账号");
          const response = await cancellable(Promise.resolve().then(() => fetchImpl(url, {
            method: "GET", redirect: "error", signal: requestController.signal,
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
          })).catch(() => { throw new Error("无法连接 Outlook，请检查网络或系统代理后重试"); }), requestController.signal);
          await check();
          if ([429, 503, 504].includes(response.status) && attempt < 2) {
            const retry = response.headers?.get("retry-after");
            const seconds = retry !== null && retry !== undefined && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : NaN;
            const absolute = retry ? Date.parse(retry) - Date.now() : NaN;
            retryDelay = Number.isFinite(seconds) ? seconds : Number.isFinite(absolute) ? Math.max(0, absolute) : 1000 * 2 ** attempt;
            response.body?.cancel().catch(() => {});
            // Do not retry earlier than Retry-After; long waits should be retried
            // by the user instead of pinning the import task indefinitely.
            if (retryDelay > 30000) throw graphError(response.status);
          } else {
            if (!response.ok) {
              response.body?.cancel().catch(() => {});
              throw graphError(response.status);
            }
            const data = await readJSON(response, requestController.signal);
            await check();
            return data;
          }
        } catch (error) {
          if (requestController.signal.aborted) throw requestController.signal.reason || abortError();
          if (error instanceof TypeError) throw new Error("无法连接 Outlook，请检查网络后重试");
          throw error;
        } finally {
          clearTimeout(requestTimer);
          workSignal.removeEventListener("abort", cancelRequest);
        }
        await pause(retryDelay, workSignal);
      }
    }

    const messages = [];
    const skipped = Object.fromEntries(SKIP_REASONS.map((key) => [key, 0]));
    let scanned = 0;
    const progress = () => onProgress?.({ phase: "search", scanned, imported: messages.length, skipped: Object.values(skipped).reduce((sum, count) => sum + count, 0), limit });
    try {
      await check();
      progress();
      const excludedFolders = new Set();
      // Fail closed if these cannot be resolved: /me/messages includes deleted
      // mail and archived subfolders of Deleted Items as well as the inbox.
      for (const name of ["deleteditems", "junkemail", "drafts", "outbox"]) {
        const folder = await request(`${GRAPH_ROOT}/mailFolders/${name}?$select=id`);
        if (typeof folder?.id !== "string" || !folder.id) throw new Error("无法确认 Outlook 邮件文件夹，请稍后重试");
        excludedFolders.add(folder.id);
      }
      const folderCache = new Map([...excludedFolders].map((id) => [id, true]));
      const rootFolder = await request(`${GRAPH_ROOT}/mailFolders/msgfolderroot?$select=id`);
      if (typeof rootFolder?.id !== "string" || !rootFolder.id) throw new Error("无法确认 Outlook 邮件文件夹，请稍后重试");
      // Stop at the well-known visible mail root instead of walking into the
      // Exchange store's internal root, which Graph may not expose.
      folderCache.set(rootFolder.id, false);
      async function excludedFolder(id, chain = new Set()) {
        if (folderCache.has(id)) return folderCache.get(id);
        if (!id || chain.has(id) || chain.size >= 30) throw new Error("Outlook 邮件文件夹层级无效");
        chain.add(id);
        const folder = await request(`${GRAPH_ROOT}/mailFolders/${encodeURIComponent(id)}?$select=id,parentFolderId`);
        if (folder?.id !== id || (folder.parentFolderId != null && typeof folder.parentFolderId !== "string")) throw new Error("Outlook 邮件文件夹数据无效");
        const excluded = folder.parentFolderId ? await excludedFolder(folder.parentFolderId, chain) : false;
        folderCache.set(id, excluded);
        return excluded;
      }
      const url = new URL(`${GRAPH_ROOT}/messages`);
      // Graph requires all orderby fields to precede other fields in filter.
      url.searchParams.set("$filter", `receivedDateTime ge ${date.toISOString()} and from/emailAddress/address eq '${target.replaceAll("'", "''")}'`);
      url.searchParams.set("$orderby", "receivedDateTime desc");
      url.searchParams.set("$select", MESSAGE_FIELDS);
      url.searchParams.set("$top", String(Math.min(50, limit)));
      const seenPages = new Set();
      const seenIds = new Set();
      const seenInternetIds = new Set();
      const seenContents = new Set();
      let next = url.toString();
      let hasMore = false;
      while (next && scanned < limit) {
        const pageURL = graphURL(next, "/v1.0/me/messages");
        if (seenPages.has(pageURL) || seenPages.size >= 40) throw new Error("Outlook 邮件分页重复，请稍后重试");
        seenPages.add(pageURL);
        const page = await request(pageURL);
        if (!Array.isArray(page?.value)) throw new Error("Outlook 邮件列表格式无效");
        const nextLink = page["@odata.nextLink"];
        if (nextLink !== undefined && typeof nextLink !== "string") throw new Error("Outlook 返回了无效的分页地址");
        next = nextLink ? graphURL(nextLink, "/v1.0/me/messages") : "";
        for (let index = 0; index < page.value.length; index += 1) {
          if (scanned >= limit) { hasMore = true; break; }
          await check();
          const item = page.value[index];
          scanned += 1;
          let reason = "";
          let detail;
          const id = typeof item?.id === "string" && item.id.length <= 1024 ? item.id : "";
          if (!id || !item.parentFolderId) reason = "unavailable";
          else if (seenIds.has(id)) reason = "duplicate";
          else if (address(item.from) !== target || address(item.sender) !== target) reason = "notAuthor";
          else if (item.isDraft) reason = "draft";
          else if (isAutomated(item)) reason = "automated";
          else if (await excludedFolder(item.parentFolderId)) reason = "excludedFolder";
          if (id) seenIds.add(id);
          if (!reason) {
            try { detail = await request(`${GRAPH_ROOT}/messages/${encodeURIComponent(id)}?$select=${DETAIL_FIELDS}`); }
            catch (error) { if (error.status === 404) reason = "unavailable"; else throw error; }
          }
          if (!reason) {
            // Recheck authoritative detail: a message can move or change between
            // the list and detail request; never trust the query alone.
            if (detail?.id !== id || !detail.parentFolderId) reason = "unavailable";
            else if (address(detail.from) !== target || address(detail.sender) !== target) reason = "notAuthor";
            else if (detail.isDraft) reason = "draft";
            else if (isAutomated(detail)) reason = "automated";
            else if (await excludedFolder(detail.parentFolderId)) reason = "excludedFolder";
          }
          if (!reason) {
            const internetMessageId = typeof detail.internetMessageId === "string" ? detail.internetMessageId : "";
            if (internetMessageId.length > 1024 || /[\x00-\x1f\x7f]/.test(internetMessageId) ||
                !Number.isFinite(Date.parse(detail.sentDateTime)) || !Number.isFinite(Date.parse(detail.receivedDateTime))) reason = "unavailable";
            // An explicitly empty uniqueBody is meaningful (only quoted text).
            // Fall back only when uniqueBody is unavailable, never to preview.
            const body = typeof detail.uniqueBody?.content === "string" ? detail.uniqueBody : detail.body;
            let text = "";
            try { text = cleanMailBody(body); } catch (error) { if (error.code === "MAIL_TOO_LONG") reason = "tooLong"; else throw error; }
            const contentHash = createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
            if (!reason && !text) reason = "empty";
            else if (!reason && text.length > MAX_MAIL_CHARS) reason = "tooLong";
            else if (!reason && ((internetMessageId && seenInternetIds.has(internetMessageId)) || seenContents.has(contentHash))) reason = "duplicate";
            if (!reason) {
              seenContents.add(contentHash);
              if (internetMessageId) seenInternetIds.add(internetMessageId);
              messages.push({
                externalId: id, internetMessageId,
                conversationId: typeof detail.conversationId === "string" ? detail.conversationId.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 1024) : "",
                subject: typeof detail.subject === "string" ? detail.subject.replace(/[\r\n\t\u0000-\u001f]/g, " ").slice(0, 200) : "无主题",
                sentAt: Number.isFinite(Date.parse(detail.sentDateTime)) ? new Date(detail.sentDateTime).toISOString() : "",
                receivedAt: Number.isFinite(Date.parse(detail.receivedDateTime)) ? new Date(detail.receivedDateTime).toISOString() : "",
                webLink: safeWebLink(detail.webLink), from: target, text, contentHash,
              });
            }
          }
          if (reason) skipped[reason] += 1;
          progress();
        }
        if (scanned >= limit && next) hasMore = true;
      }
      await check();
      return { messages, scanned, skipped, hasMore };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
  return { search };
}

module.exports = { createOutlookMailClient, normalizeEmail, cleanMailBody, MAX_MAIL_CHARS };
