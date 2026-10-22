const { createHash } = require("node:crypto");

const EMAIL_LIMITS = Object.freeze({ sources: 200, chars: 240000, sourceChars: 16000, exclusions: 1000 });
const digest = (text) => createHash("sha256").update(text).digest("hex");
function field(value, label, max, optional = false) {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}无效。`);
  return value.trim();
}
function emailAddress(value) {
  const email = field(value, "人物邮箱", 254).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email)) throw new Error("请输入有效的人物邮箱地址。");
  return email;
}
function dateValue(value, label = "邮件时间") {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error(`${label}无效。`);
  return new Date(value).toISOString();
}
function sinceDate(value) {
  if (value === null || value === "") return null;
  const date = dateValue(value, "开始日期");
  if (Date.parse(date) > Date.now()) throw new Error("开始日期不能晚于今天。");
  return date;
}
function normalizeEmailMetadata(input, text) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("邮件来源信息无效。");
  const webLink = field(input.webLink, "邮件链接", 2048, true);
  if (webLink) {
    const url = new URL(webLink);
    if (url.protocol !== "https:" || url.username || url.password || !["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(url.hostname)) throw new Error("邮件链接无效。");
  }
  return {
    accountId: field(input.accountId, "邮箱账户", 256),
    accountUsername: emailAddress(input.accountUsername),
    externalId: field(input.externalId, "邮件标识", 1024),
    internetMessageId: field(input.internetMessageId, "邮件 Message-ID", 1024, true),
    conversationId: field(input.conversationId, "邮件会话标识", 1024, true),
    from: emailAddress(input.from),
    sentAt: dateValue(input.sentAt), receivedAt: dateValue(input.receivedAt), webLink,
    contentHash: digest(text.replace(/\s+/g, " ").trim()),
  };
}
function emailKeys(email) {
  return ["id:" + email.externalId, ...(email.internetMessageId ? ["mid:" + email.internetMessageId] : []), "body:" + email.contentHash]
    .map((key) => digest(`${email.accountId}\n${email.from}\n${key}`));
}
function validOutlookBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (emailAddress(value.email) !== value.email || emailAddress(value.accountUsername) !== value.accountUsername) return false;
    field(value.accountId, "邮箱账户", 256); dateValue(value.lastImportedAt);
    if (value.since !== null) dateValue(value.since);
    if (!Array.isArray(value.excludedKeys) || value.excludedKeys.length > EMAIL_LIMITS.exclusions || !value.excludedKeys.every((key) => /^[a-f0-9]{64}$/.test(key))) return false;
    const stats = value.lastStats;
    if (!stats || typeof stats.hasMore !== "boolean") return false;
    return ["found", "added", "updated", "duplicates", "skipped", "capacitySkipped"].every((key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0 && stats[key] <= 100000);
  } catch { return false; }
}

module.exports = { EMAIL_LIMITS, emailAddress, sinceDate, normalizeEmailMetadata, emailKeys, validOutlookBinding };
