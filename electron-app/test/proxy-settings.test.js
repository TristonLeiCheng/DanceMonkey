const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { createAppSettings, pickSettings } = require("../electron/app-settings");
const { createLegacyConfig } = require("../electron/legacy-config");
const {
  createProxyEnforcement,
  createWindowsProxyBackend,
} = require("../electron/proxy-enforcement");
const snapshot = () =>
  Object.fromEntries(
    [
      "ProxyEnable",
      "ProxyServer",
      "ProxyOverride",
      "AutoConfigURL",
      "AutoDetect",
    ].map((key) => [
      key,
      {
        exists: key === "ProxyEnable",
        value: key === "ProxyEnable" ? 0 : null,
      },
    ]),
  );
const config = {
  proxyForceEnabled: true,
  proxyForceMode: "manual",
  proxyServer: "127.0.0.1",
  proxyPort: 7890,
  proxyRefreshMinutes: 3,
};
function setup(t, backend = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-proxy-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let system = snapshot(),
    count = 0;
  const timers = new Map();
  const defaults = {
    read: async () => structuredClone(system),
    apply: async (next) => {
      system = structuredClone(next);
      count++;
    },
    restore: async (before) => {
      system = structuredClone(before);
      return { restored: true };
    },
  };
  const options = {
    backupFile: path.join(root, "restore.json"),
    backend: { ...defaults, ...backend },
    timers: {
      setInterval: (fn) => {
        const id = { unref() {} };
        timers.set(id, fn);
        return id;
      },
      clearInterval: (id) => timers.delete(id),
    },
  };
  return {
    root,
    options,
    timers,
    get system() {
      return system;
    },
    get writes() {
      return count;
    },
    service: createProxyEnforcement(options),
  };
}
test("legacy aliases migrate before defaults; explicit false wins and unrelated pet data survives restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-config-proxy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "DanceMonkey");
  fs.mkdirSync(folder);
  const file = path.join(folder, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      ProxyForceEnabled: true,
      ProxyServer: "legacy.invalid",
      ProxyPort: 7890,
      PetAnimal: "fluffy-rabbit",
      PetModeEnabled: true,
      PetDisplaySize: 128,
      apiKey: "fixture-only",
      unknown: { keep: 1 },
    }),
  );
  const store = createLegacyConfig(root);
  let applied;
  const settings = createAppSettings(store, {
    proxyEnforcement: {
      startOrUpdate: async (s) => {
        applied = s.proxyForceEnabled;
      },
    },
  });
  assert.equal(settings.get().proxyForceEnabled, true);
  const saved = await settings.save({
    proxyForceEnabled: false,
    aiNetworkMode: "direct",
  });
  assert.equal(saved.proxyForceEnabled, false);
  assert.equal(applied, false);
  const raw = JSON.parse(fs.readFileSync(file));
  assert.equal(raw.ProxyForceEnabled, undefined);
  assert.equal(raw.proxyForceEnabled, false);
  assert.equal(raw.apiKey, "fixture-only");
  assert.deepEqual(raw.unknown, { keep: 1 });
  const next = createAppSettings(createLegacyConfig(root)).get();
  assert.equal(next.aiNetworkMode, "direct");
  assert.equal(next.petAnimal, "fluffy-rabbit");
  assert.equal(next.petDisplaySize, 128);
  assert.equal(next.petModeEnabled, true);
  assert.equal(
    pickSettings({ proxyForceEnabled: false, ProxyForceEnabled: true })
      .proxyForceEnabled,
    false,
  );
  assert.equal(
    pickSettings({ proxyForceEnabled: "false" }).proxyForceEnabled,
    false,
  );
});
test("disable restores the original system proxy, removes backup and preserves it across maintenance edits", async (t) => {
  const h = setup(t),
    before = h.system;
  await h.service.startOrUpdate(config);
  assert.equal(h.system.ProxyEnable.value, 1);
  assert.equal(h.timers.size, 1);
  await h.service.startOrUpdate({ ...config, proxyPort: 9000 });
  assert.equal(h.system.ProxyServer.value, "127.0.0.1:9000");
  await h.service.startOrUpdate({ ...config, proxyForceEnabled: false });
  assert.deepEqual(h.system, before);
  assert.equal(h.timers.size, 0);
  assert.equal(fs.existsSync(h.options.backupFile), false);
});
test("restart and exit restore owned settings; external modifications are not overwritten", async (t) => {
  let restores = 0;
  const h = setup(t, {
    restore: async () => {
      restores++;
      return { restored: false };
    },
  });
  await h.service.startOrUpdate(config);
  const next = createProxyEnforcement(h.options);
  const result = await next.startOrUpdate({ proxyForceEnabled: false });
  assert.equal(result.restored, false);
  assert.match(result.notice, /其他软件/);
  assert.ok(fs.existsSync(h.options.backupFile));
  await h.service.stop();
  assert.equal(restores, 2);
  assert.equal(h.timers.size, 0);
  const owned = setup(t);
  const before = owned.system;
  await owned.service.startOrUpdate(config);
  await createProxyEnforcement(owned.options).stop();
  assert.deepEqual(owned.system, before);
  await owned.service.stop();
});
test("rapid disable while applying leaves no proxy or timer behind", async (t) => {
  let release;
  const h = setup(t, {
    read: () =>
      new Promise((resolve) => {
        release = () => resolve(snapshot());
      }),
  });
  const first = h.service.startOrUpdate(config);
  await new Promise((resolve) => setImmediate(resolve));
  const disable = h.service.startOrUpdate({ proxyForceEnabled: false });
  release();
  await Promise.all([first, disable]);
  assert.equal(h.system.ProxyEnable.value, 0);
  assert.equal(h.timers.size, 0);
});
test("failed writes keep recoverable snapshots; missing legacy backup does not clear arbitrary proxies", async (t) => {
  const h = setup(t, {
    apply: async () => {
      throw Error("permissions");
    },
  });
  await assert.rejects(h.service.startOrUpdate(config), /恢复记录/);
  assert.ok(fs.existsSync(h.options.backupFile));
  await h.service.stop();
  assert.equal(fs.existsSync(h.options.backupFile), false);
  let touched = 0;
  const other = setup(t, {
    restore: async () => {
      touched++;
      return { restored: true };
    },
  });
  await other.service.startOrUpdate({ proxyForceEnabled: false });
  assert.equal(touched, 0);
});
test("Windows backend restores with a value comparison and quotes values as data", async () => {
  const scripts = [];
  const backend = createWindowsProxyBackend(async (script) => {
    scripts.push(script);
    return { restored: true };
  });
  const before = snapshot(),
    after = snapshot();
  after.ProxyServer = {
    exists: true,
    value: "example.invalid'; malicious-text",
  };
  await backend.restore(before, after);
  const script = scripts[0];
  assert.ok(script.includes("Same-Value $current.$name $applied.$name"));
  assert.ok(script.includes("if ($owned) { Write-Snapshot $before }"));
  assert.ok(!script.includes("malicious-text"));
});

test("manual proxy accepts pasted HTTP addresses and host:port; PAC ignores stale manual ports", () => {
  const { validateSettings } = require("../electron/app-settings");
  const pasted = validateSettings({
    ...config,
    proxyServer: "http://127.0.0.1:7891",
  });
  assert.equal(pasted.proxyServer, "127.0.0.1");
  assert.equal(pasted.proxyPort, 7891);
  const pair = validateSettings({ ...config, proxyServer: "[::1]:9000" });
  assert.equal(pair.proxyServer, "[::1]");
  assert.equal(pair.proxyPort, 9000);
  assert.equal(
    validateSettings({
      ...config,
      proxyForceMode: "pac",
      proxyPacUrl: "https://example.invalid/proxy.pac",
      proxyPort: -1,
    }).proxyForceMode,
    "pac",
  );
  assert.throws(
    () =>
      validateSettings({
        ...config,
        proxyServer: "http://user:pass@example.invalid:7890",
      }),
    /账号/,
  );
});

test("exit cancels a pending system operation before restoring its journal", async (t) => {
  let rejectApply,
    cancels = 0;
  const h = setup(t, {
    apply: () =>
      new Promise((resolve, reject) => {
        rejectApply = reject;
      }),
    cancel: () => {
      cancels++;
      rejectApply?.(new Error("cancelled"));
    },
  });
  const applying = h.service.startOrUpdate(config);
  const failed = assert.rejects(applying, /恢复记录/);
  await new Promise((resolve) => setImmediate(resolve));
  await h.service.stop();
  await failed;
  assert.equal(cancels, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(fs.existsSync(h.options.backupFile), false);
  assert.equal(h.system.ProxyEnable.value, 0);
});

test("Windows backend passes an abort signal to its active PowerShell operation", async () => {
  let signal;
  const backend = createWindowsProxyBackend(async (script, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      }),
    );
  });
  const pending = backend.read();
  const failed = assert.rejects(pending, /cancelled/);
  backend.cancel();
  await failed;
  assert.equal(signal.aborted, true);
});

test("invalid or credential-bearing PAC URLs are rejected before saving", () => {
  const { validateSettings } = require("../electron/app-settings");
  for (const proxyPacUrl of [
    "http://",
    "https://user:pass@example.invalid/proxy.pac",
    "file:///proxy.pac",
  ]) {
    assert.throws(
      () => validateSettings({ ...config, proxyForceMode: "pac", proxyPacUrl }),
      /PAC 地址/,
    );
  }
});
