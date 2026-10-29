const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProxyTransport, bypassesProxy } = require('../electron/system-proxy');
const { normalizeApplicationProxy, networkRoute } = require('../electron/config-migration');
const { createAppSettings, validateSettings } = require('../electron/app-settings');
const { createLegacyConfig } = require('../electron/legacy-config');

const manual = (port, protocol = 'http', host = '127.0.0.1', bypass = '') => ({ mode: 'manual', manualProxyProtocol: protocol, manualProxyHost: host, manualProxyPort: port, manualProxyBypass: bypass });
async function listen(t, server, host = '127.0.0.1') {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  t.after(() => { for (const s of sockets) s.destroy(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function fixture(t) {
  const hits = [], tunnels = [];
  const target = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://localhost:${target.address().port}/final` }); res.end(); }
    else res.end('local-only');
  });
  const port = await listen(t, target);
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url);
    const destination = new URL(`http://${req.url}`);
    assert.equal(Number(destination.port), port);
    const upstream = net.connect({ host: '127.0.0.1', port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  return { port, proxy, hits, tunnels, proxyPort: await listen(t, proxy) };
}

test('manual IPv4 HTTP proxy makes a real CONNECT request; bypassed redirect re-evaluates the new host', async t => {
  const f = await fixture(t), transport = createProxyTransport({ getSession: () => { throw Error('must not consult PAC'); } });
  t.after(() => transport.close());
  assert.equal(await (await transport.fetch(`http://127.0.0.1:${f.port}/manual`, {}, manual(f.proxyPort))).text(), 'local-only');
  assert.equal(f.tunnels.length, 1);
  assert.equal(await (await transport.fetch(`http://127.0.0.1:${f.port}/redirect`, {}, manual(f.proxyPort, 'http', '127.0.0.1', '127.*'))).text(), 'local-only');
  assert.ok(f.tunnels.includes(`localhost:${f.port}`), 'redirect outside bypass still uses fixed proxy');
  assert.deepEqual(f.hits, ['/manual', '/redirect', '/final']);
});

test('manual proxy connection failure never sends directly or consults a company PAC', async t => {
  const f = await fixture(t), transport = createProxyTransport({ getSession: () => { throw Error('no resolver'); } });
  const closed = net.createServer(); const port = await listen(t, closed);
  await new Promise(resolve => closed.close(resolve));
  t.after(() => transport.close());
  await assert.rejects(transport.fetch(`http://127.0.0.1:${f.port}/must-not-arrive`, {}, manual(port)), /手动代理/);
  assert.equal(f.hits.length, 0);
});

test('HTTPS proxy preserves certificate verification and succeeds with an explicitly trusted test CA', async t => {
  const f = await fixture(t), ca = fs.readFileSync(path.join(__dirname, 'fixtures/proxy-tls/test-only-cert.pem'));
  const proxy = https.createServer({ cert: ca, key: fs.readFileSync(path.join(__dirname, 'fixtures/proxy-tls/test-only-key.pem')) });
  proxy.on('connect', (req, client) => {
    assert.equal(req.url, `127.0.0.1:${f.port}`);
    const upstream = net.connect({ host: '127.0.0.1', port: f.port }, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(client); client.pipe(upstream); });
    upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  const port = await listen(t, proxy), production = createProxyTransport(); t.after(() => production.close());
  await assert.rejects(production.fetch(`http://127.0.0.1:${f.port}`, {}, manual(port, 'https')), /网络连接失败/);
  assert.equal(f.hits.length, 0, 'untrusted proxy cannot deliver request');
  const { ProxyAgent } = require('undici');
  const trusted = createProxyTransport({ agentFactory: proxy => new ProxyAgent({ uri: proxy.url, proxyTls: { ca } }) }); t.after(() => trusted.close());
  assert.equal(await (await trusted.fetch(`http://127.0.0.1:${f.port}`, {}, manual(port, 'https'))).text(), 'local-only');
});

test('manual SOCKS5 proxy uses a real IPv6 proxy endpoint with a bounded connector', async t => {
  const f = await fixture(t), requests = [];
  const socks = net.createServer(socket => {
    let buffer = Buffer.alloc(0), stage = 0;
    const read = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]); stage = 1; socket.write(Buffer.from([5, 0]));
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        const atyp = buffer[3], size = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffer[4];
        if (buffer.length < 4 + size + 2) return;
        requests.push(buffer.readUInt16BE(4 + size)); assert.equal(requests.at(-1), f.port);
        const rest = buffer.subarray(6 + size); stage = 2; socket.removeListener('data', read);
        const upstream = net.connect({ host: '127.0.0.1', port: f.port }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
          if (rest.length) upstream.write(rest);
          upstream.pipe(socket); socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
      }
    };
    socket.on('data', read);
  });
  const proxyPort = await listen(t, socks, '::1');
  const transport = createProxyTransport(); t.after(() => transport.close());
  const response = await transport.fetch(`http://127.0.0.1:${f.port}/socks`, {}, manual(proxyPort, 'socks5', '::1'));
  assert.equal(await response.text(), 'local-only'); assert.deepEqual(requests, [f.port]);
});

test('company defaults follow PAC changes; explicit direct avoids the resolver', async () => {
  let raw = 'PROXY first.invalid:8080', config = { networkProxyMode: 'system' }, resolutions = 0;
  const modes = [];
  const transport = createProxyTransport({ getConfig: () => config, getSession: () => ({ resolveProxy: () => { resolutions++; return raw; } }),
    agentFactory: route => ({ ...route, close: () => {} }), fetch: async (_url, request) => { modes.push(request.dispatcher); return { ok: true }; } });
  await transport.fetch('https://target.invalid'); raw = 'PROXY second.invalid:8888'; await transport.fetch('https://target.invalid');
  config = { networkProxyMode: 'direct' }; await transport.fetch('https://target.invalid');
  assert.equal(resolutions, 2); assert.equal(modes[1].url, 'http://second.invalid:8888'); assert.equal(modes[2].kind, 'direct');
});

test('stalled PAC is bounded and cancellation sends no network request', async () => {
  let calls = 0;
  const transport = createProxyTransport({ resolverTimeoutMs: 20, getSession: () => ({ resolveProxy: () => new Promise(() => {}) }), fetch: () => { calls++; } });
  await assert.rejects(transport.fetch('https://target.invalid'), { code: 'DM_PROXY_RESOLVE' });
  const controller = new AbortController(), pending = transport.fetch('https://target.invalid', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 0);
});

test('fixed endpoint validation and host exclusions support IPv4, IPv6, CIDR and pasted URLs', () => {
  assert.deepEqual(normalizeApplicationProxy({ manualProxyHost: 'socks5://[::1]:1081' }), { manualProxyProtocol: 'socks5', manualProxyHost: '::1', manualProxyPort: 1081, manualProxyBypass: '' });
  assert.equal(normalizeApplicationProxy({ manualProxyHost: '192.168.1.10:7890' }).manualProxyPort, 7890);
  for (const host of ['http://user:secret@127.0.0.1:8080', 'http://127.0.0.1/path', '127.0.0.1;evil', 'file://127.0.0.1'])
    assert.throws(() => normalizeApplicationProxy({ manualProxyHost: host }));
  for (const port of [0, 65536, 12.5]) assert.throws(() => validateSettings({ aiNetworkMode: 'manual', manualProxyHost: '127.0.0.1', manualProxyPort: port }));
  assert.throws(() => validateSettings({ networkProxyMode: 'unknown' }));
  assert.throws(() => validateSettings({ aiNetworkMode: 'unknown' }));
  assert.throws(() => normalizeApplicationProxy({ manualProxyHost: '127.0.0.1', manualProxyBypass: '10.0.0.0/33' }));
  assert.equal(bypassesProxy('http://[::1]', '[::1]/128'), true);
  for (const [url, rules, expected] of [['http://10.2.3.4', '10.0.0.0/8', true], ['http://[::1]', '::1/128', true], ['https://sub.company.example', '*.company.example', true], ['https://company.example.evil', '*.company.example', false], ['http://printer', '<local>', true], ['http://127.0.0.1', '127.*', true]]) assert.equal(bypassesProxy(url, rules), expected);
});

test('all three network modes persist across restart without losing 3.12 pets, reminders or legacy aliases', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-network-config-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createLegacyConfig(root);
  store.write({ petAnimal: 'realistic-mosquito', petRoamingEnabled: true, petDisplaySize: 128, defaultReminderNotifyStyle: 1, defaultReminderPopupStyle: 3,
    apiKey: 'fixture-only', GlobalChatHotkey: 'Alt+Q', globalChatHotkey: 'Ctrl+Alt+N', ProxyForceEnabled: true, proxyForceEnabled: false });
  const settings = createAppSettings(store);
  for (const mode of ['manual', 'direct', 'system']) {
    await settings.save({ networkProxyMode: mode, aiNetworkMode: 'inherit', manualProxyHost: '[::1]:8080', manualProxyProtocol: 'http', manualProxyBypass: 'localhost;10.0.0.0/8' });
    const saved = createLegacyConfig(root).read(), picked = createAppSettings(createLegacyConfig(root)).get();
    assert.equal(networkRoute(saved, 'ai').mode, mode); assert.equal(picked.petAnimal, 'realistic-mosquito'); assert.equal(saved.defaultReminderNotifyStyle, 1);
    assert.equal(saved.defaultReminderPopupStyle, 3); assert.equal(saved.petRoamingEnabled, true); assert.equal(saved.petDisplaySize, 128);
    assert.equal(picked.globalChatHotkey, 'Ctrl+Alt+N'); assert.equal(picked.proxyForceEnabled, false); assert.equal(saved.apiKey, 'fixture-only');
    assert.equal('ProxyForceEnabled' in saved, false);
  }
  assert.equal(networkRoute({ networkProxyMode: 'manual', aiNetworkMode: 'direct' }, 'ai').mode, 'direct');
});
