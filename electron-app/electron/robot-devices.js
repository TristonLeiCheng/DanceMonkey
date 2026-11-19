const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const dns = require("node:dns").promises;
const net = require("node:net");
const os = require("node:os");
const run = promisify(execFile);
const clean = (v, n = 100) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, n) : "";
function mac(value) {
  if (typeof value !== "string") return "";
  const parts = value.toLowerCase().replaceAll("-", ":").split(":");
  return parts.length === 6 && parts.every(p => /^[0-9a-f]{1,2}$/.test(p)) ? parts.map(p => p.padStart(2, "0")).join(":") : "";
}
function parseNeighbors(raw) {
  const rows = [];
  for (const line of raw.split("\n")) {
    const ip = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
    const id = mac(line.match(/\b(?:[\da-f]{1,2}[:-]){5}[\da-f]{1,2}\b/i)?.[0]);
    if (net.isIPv4(ip || "") && id && id !== "ff:ff:ff:ff:ff:ff" && id !== "00:00:00:00:00:00") rows.push({ id, ip });
  }
  return rows;
}
function sameLan(ip) {
  if (!net.isIPv4(ip)) return false;
  const num = v => v.split(".").reduce((x, b) => (x << 8) | Number(b), 0);
  return Object.values(os.networkInterfaces()).flat().some(row => row.family === "IPv4" && !row.internal &&
    (num(row.address) & num(row.netmask)) === (num(ip) & num(row.netmask)));
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1200); })]); }
  catch { return null; } finally { clearTimeout(timer); }
}
async function discoverDevices(query = "", known = [], deps = {}) {
  const input = clean(query, 100).trim();
  const id = mac(input);
  if (input && !id && !/^xiaozhi-[a-z0-9-]{1,40}(?:\.local)?$/i.test(input)) throw Error("请输入设备 MAC 地址或 Xiaozhi-xxxx.local 名称。");
  const neighborRead = deps.neighbors || (async () => {
    const exe = process.platform === "win32" ? "arp.exe" : "/usr/sbin/arp";
    const { stdout } = await run(exe, process.platform === "win32" ? ["-a"] : ["-an"], { timeout: 3000, maxBuffer: 262144 });
    return stdout;
  });
  const allowed = deps.allowed || sameLan;
  const reverse = deps.reverse || (ip => dns.reverse(ip));
  const lookup = deps.lookup || (name => dns.lookup(name, { family: 4 }));
  let neighbors = [], warning = "";
  try { neighbors = parseNeighbors(await neighborRead()).filter(row => allowed(row.ip)).slice(0, 64); }
  catch { warning = "无法读取本机网络邻居；仍可按设备名查找。"; }
  const found = new Map();
  for (const row of neighbors) {
    const saved = known.find(item => item.id === row.id);
    if ((id && row.id === id) || (!input && saved)) found.set(row.id, { ...row, name: saved?.name || "小智候选设备", evidence: "网络邻居中的 MAC 匹配" });
  }
  const names = input ? [id ? "Xiaozhi-" + id.replaceAll(":", "").slice(-4) + ".local" :
    input.replace(/(?:\.local)?$/i, ".local")] :
    known.slice(0, 16).map(row => "Xiaozhi-" + row.id.replaceAll(":", "").slice(-4) + ".local");
  await Promise.all(names.map(async name => {
    const result = await bounded(lookup(name));
    if (!result || !allowed(result.address)) return;
    const neighbor = neighbors.find(row => row.ip === result.address);
    if (id && neighbor && neighbor.id !== id) return;
    const key = neighbor?.id || result.address;
    found.set(key, { id: neighbor?.id || "", ip: result.address, name, evidence: "设备名称解析成功，待小智接入确认" });
  }));
  if (!input) {
    // Bound concurrent reverse lookups; the standard firmware has no LAN scan API.
    for (let offset = 0; offset < Math.min(neighbors.length, 32); offset += 8) {
      await Promise.all(neighbors.slice(offset, offset + 8).map(async row => {
        const names = await bounded(reverse(row.ip));
        const name = names?.find(n => /^xiaozhi[-.]/i.test(n));
        if (name) found.set(row.id, { ...row, name: clean(name), evidence: "网络名称包含 Xiaozhi，待接入确认" });
      }));
    }
  }
  return { candidates: [...found.values()], warning, checked: neighbors.length };
}
function createDevices({ config, now = () => new Date().toISOString() }) {
  const live = new Map();
  const saved = config.read().robotDevices;
  const rows = new Map((Array.isArray(saved) ? saved : []).filter(r => r && mac(r.id)).slice(-32).map(r =>
    [mac(r.id), { id: mac(r.id), name: clean(r.name), ip: clean(r.ip), board: clean(r.board), version: clean(r.version), lastSeen: clean(r.lastSeen) }]));
  const persist = () => config.write({ robotDevices: [...rows.values()].slice(-32) });
  function observe(id, ip, info = {}) {
    id = mac(id);
    if (!id) return "";
    const previous = rows.get(id);
    const next = { ...previous, id, name: previous?.name || "小智 " + id.slice(-5).replace(":", "").toUpperCase(),
      ip: clean(ip), board: clean(info.board) || previous?.board || "", version: clean(info.version) || previous?.version || "", lastSeen: now() };
    rows.set(id, next);
    while (rows.size > 32) rows.delete(rows.keys().next().value);
    persist();
    return id;
  }
  return {
    observe,
    connect(id, ip, controls) {
      id = observe(id, ip);
      if (!id) return () => {};
      live.set(id, controls);
      return () => { if (live.get(id) === controls) live.delete(id); };
    },
    snapshot: () => [...rows.values()].map(row => ({ ...row, connected: live.has(row.id),
      tools: live.get(row.id)?.tools() || [] })),
    rename(id, name) {
      id = mac(id); name = clean(name, 40).trim();
      if (!rows.has(id) || !name) throw Error("请选择设备并填写名称。");
      rows.get(id).name = name; persist();
    },
    forget(id) {
      id = mac(id);
      if (live.has(id)) throw Error("请先断开设备再移除记录。");
      rows.delete(id); persist();
    },
    async control(id, action, value) {
      const device = live.get(mac(id));
      if (!device) throw Error("设备未连接，请先唤醒小智。");
      if (action === "disconnect") { device.disconnect(); return "已断开连接。"; }
      const names = { status: "self.get_device_status", volume: "self.audio_speaker.set_volume", brightness: "self.screen.set_brightness" };
      if (!names[action] || !device.tools().includes(names[action])) throw Error("此设备未报告支持该功能。");
      if (action !== "status" && (!Number.isInteger(value) || value < 0 || value > 100)) throw Error("请输入 0–100 的整数。");
      const result = await device.call(names[action], action === "status" ? {} : { [action === "volume" ? "volume" : "brightness"]: value });
      if (result?.isError) throw Error("小智没有完成操作，请重试。");
      return action === "status" ? (result?.content || []).filter(p => p.type === "text").map(p => clean(p.text, 2000)).join("\n") : "设备已确认设置。";
    },
  };
}
function createMcp(send, onInfo = () => {}, timeout = 5000) {
  const pending = new Map();
  let serial = 0, supported = [], closed = false;
  function request(method, params) {
    if (closed || pending.size >= 8) return Promise.reject(Error("设备连接不可用或正在处理其他操作。"));
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(Error("小智响应超时，请确认设备已唤醒。")); }, timeout);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }
  return {
    tools: () => [...supported],
    call: (name, args) => request("tools/call", { name, arguments: args }),
    receive(payload) {
      if (payload?.jsonrpc !== "2.0" || !Number.isInteger(payload.id)) return;
      const item = pending.get(payload.id);
      if (!item) return;
      pending.delete(payload.id); clearTimeout(item.timer);
      if (payload.error) item.reject(Error("小智拒绝了管理请求。")); else item.resolve(payload.result);
    },
    async start() {
      try {
        const result = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "DanceMonkey", version: "1" } });
        if (closed) return;
        onInfo({ board: clean(result?.serverInfo?.name), version: clean(result?.serverInfo?.version) });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        let cursor, names = [], seen = new Set();
        for (let i = 0; i < 8; i++) {
          const page = await request("tools/list", cursor ? { cursor } : {});
          if (!Array.isArray(page?.tools)) break;
          names.push(...page.tools.map(t => clean(t?.name)));
          cursor = page.nextCursor;
          if (!cursor || typeof cursor !== "string" || cursor.length > 500 || seen.has(cursor)) break;
          seen.add(cursor);
        }
        if (!closed) supported = names.filter(n => ["self.get_device_status", "self.audio_speaker.set_volume", "self.screen.set_brightness"].includes(n));
      } catch { /* Voice works independently when management is unsupported. */ }
    },
    close() {
      closed = true; supported = [];
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("小智已断开连接。")); }
      pending.clear();
    },
  };
}
module.exports = { mac, parseNeighbors, discoverDevices, createDevices, createMcp };
