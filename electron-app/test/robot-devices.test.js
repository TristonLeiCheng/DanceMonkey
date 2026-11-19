const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDevices, createMcp, discoverDevices, parseNeighbors } = require("../electron/robot-devices");

test("network search recognizes MAC and DHCP names without treating other LAN hosts as Xiaozhi", async () => {
  const raw = "? (192.168.4.2) at a:b:c:d:e:f on en0\n? (192.168.4.3) at 22:33:44:55:66:77 on en0\n? (10.1.0.2) at 11:22:33:44:55:66 on utun";
  const deps = { neighbors: async () => raw, allowed: ip => ip.startsWith("192.168.4."),
    reverse: async ip => [ip.endsWith(".2") ? "Xiaozhi-0E0F.company" : "printer.company"], lookup: async () => null };
  assert.equal(parseNeighbors(raw)[0].id, "0a:0b:0c:0d:0e:0f");
  const result = await discoverDevices("", [], deps);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].ip, "192.168.4.2");
  const exact = await discoverDevices("0a:0b:0c:0d:0e:0f", [], deps);
  assert.equal(exact.candidates.length, 1);
  await assert.rejects(discoverDevices("https://external.example/", [], deps), /请输入/);
  const mismatch = await discoverDevices("00:11:22:33:44:55", [], { ...deps, lookup: async () => ({ address: "192.168.4.2" }) });
  assert.equal(mismatch.candidates.length, 0);
});

test("device registry preserves aliases, validates controls, and distinguishes presence from an active connection", async () => {
  let stored = {};
  const config = { read: () => stored, write: patch => Object.assign(stored, patch) };
  const registry = createDevices({ config }), id = "00:11:22:33:44:55", calls = [];
  registry.observe(id, "192.168.1.2", { board: "board", version: "2.5.2", token: "secret" });
  assert.equal(registry.snapshot()[0].connected, false);
  registry.rename(id, "办公桌小智");
  const off = registry.connect(id, "192.168.1.3", {
    tools: () => ["self.audio_speaker.set_volume"], call: async (...args) => { calls.push(args); return { isError: false }; },
    disconnect() {},
  });
  assert.equal(registry.snapshot()[0].connected, true);
  assert.equal(registry.snapshot()[0].name, "办公桌小智");
  assert.throws(() => registry.forget(id), /断开/);
  await assert.rejects(registry.control(id, "brightness", 30), /未报告/);
  await assert.rejects(registry.control(id, "volume", -1), /整数/);
  await registry.control(id, "volume", 42);
  assert.deepEqual(calls, [["self.audio_speaker.set_volume", { volume: 42 }]]);
  off();
  assert.equal(registry.snapshot()[0].connected, false);
  await assert.rejects(registry.control(id, "volume", 30), /未连接/);
  assert.ok(!JSON.stringify(stored).includes("secret"));
  assert.equal(createDevices({ config }).snapshot()[0].connected, false);
  registry.forget(id); assert.deepEqual(registry.snapshot(), []);
});

test("MCP initialization follows paginated tool discovery and rejects late/error responses", async () => {
  const sent = [], metadata = [];
  const mcp = createMcp(msg => sent.push(msg), info => metadata.push(info), 100);
  const started = mcp.start();
  const reply = (id, result) => mcp.receive({ jsonrpc: "2.0", id, result });
  reply(sent[0].id, { serverInfo: { name: "board", version: "2.5.2" } });
  await new Promise(setImmediate);
  assert.equal(sent[1].method, "notifications/initialized");
  reply(sent[2].id, { tools: [{ name: "self.audio_speaker.set_volume" }], nextCursor: "next" });
  await new Promise(setImmediate);
  assert.equal(sent[3].params.cursor, "next");
  reply(sent[3].id, { tools: [{ name: "self.screen.set_brightness" }, { name: "self.upgrade_firmware" }] });
  await started;
  assert.deepEqual(mcp.tools(), ["self.audio_speaker.set_volume", "self.screen.set_brightness"]);
  const pending = mcp.call("self.audio_speaker.set_volume", { volume: 1 });
  const id = sent.at(-1).id;
  mcp.receive({ jsonrpc: "2.0", id, error: { message: "private body" } });
  await assert.rejects(pending, /拒绝/);
  const stale = mcp.call("self.audio_speaker.set_volume", { volume: 1 });
  mcp.close();
  await assert.rejects(stale, /断开/);
  assert.equal(metadata[0].version, "2.5.2");
});
