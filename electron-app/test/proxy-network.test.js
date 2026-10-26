const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  createProxyTransport,
  parseProxyDirective,
} = require("../electron/system-proxy");
function harness(raw = "PROXY bad.invalid:8080; DIRECT", fetch) {
  const calls = [],
    routes = [];
  let resolutions = 0;
  const transport = createProxyTransport({
    getSession: () => ({
      resolveProxy: async () => {
        resolutions++;
        if (raw instanceof Error) throw raw;
        return raw;
      },
      forceReloadProxyConfig: async () => {},
    }),
    agentFactory: (p) => {
      routes.push(p);
      return { ...p, close: async () => {} };
    },
    fetch:
      fetch ||
      (async (_u, o) => {
        calls.push(o.dispatcher);
        if (o.dispatcher.kind !== "direct")
          throw Object.assign(Error("private credentials must not leak"), {
            cause: { code: "ECONNREFUSED" },
          });
        return { ok: true };
      }),
  });
  return {
    transport,
    calls,
    routes,
    get resolutions() {
      return resolutions;
    },
  };
}
test("direct mode bypasses resolver, inherited dispatchers and environment routing", async () => {
  const h = harness(Error("must not resolve"));
  await h.transport.fetch(
    "https://example.invalid",
    { dispatcher: { kind: "wrong" } },
    "direct",
  );
  assert.equal(h.resolutions, 0);
  assert.equal(h.calls[0].kind, "direct");
});
test("PAC connection failure honors the next route and explicit DIRECT, including IPv6", async () => {
  const h = harness("PROXY [::1]:8080; PROXY second.invalid:8000; DIRECT");
  await h.transport.fetch("https://example.invalid", {
    method: "POST",
    body: '{"test":true}',
  });
  assert.deepEqual(
    h.calls.map((v) => v.kind),
    ["http", "http", "direct"],
  );
  assert.equal(h.routes[0].url, "http://[::1]:8080");
  assert.equal(
    parseProxyDirective("SOCKS5 [::1]:1080").url,
    "socks5://[::1]:1080",
  );
});
test("proxy-only PAC never silently bypasses; errors redact credentials and paths", async () => {
  const h = harness(
    "PROXY http://user:secret@proxy.invalid:8080/private?token=hidden",
  );
  await assert.rejects(h.transport.fetch("https://example.invalid"), (e) => {
    assert.equal(e.code, "DM_NETWORK_CONNECTION");
    assert.doesNotMatch(e.message, /user|secret|token|private|hidden/);
    return true;
  });
  assert.equal(h.calls.length, 1);
});
test("system resolution failure never substitutes an environment proxy or direct route", async () => {
  const h = harness(Error("PAC failed"));
  await assert.rejects(h.transport.fetch("https://example.invalid"), {
    code: "DM_PROXY_RESOLVE",
  });
  assert.equal(h.calls.length, 0);
});
test("no retry for HTTP responses, TLS failures, partial writes or one-shot bodies", async () => {
  for (const code of ["EPIPE", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED"]) {
    let count = 0;
    const h = harness(undefined, async () => {
      count++;
      throw Object.assign(Error("sensitive"), { code });
    });
    await assert.rejects(
      h.transport.fetch("https://example.invalid", {
        method: "POST",
        body: "text",
      }),
    );
    assert.equal(count, 1);
  }
  const h = harness(undefined, async () => ({ status: 407 }));
  assert.equal(
    (await h.transport.fetch("https://example.invalid")).status,
    407,
  );
  assert.equal(h.routes.length, 1);
  let count = 0;
  const stream = harness(undefined, async () => {
    count++;
    throw Object.assign(Error("connect"), { code: "ECONNREFUSED" });
  });
  await assert.rejects(
    stream.transport.fetch("https://example.invalid", {
      body: (async function* () {
        yield "once";
      })(),
    }),
  );
  assert.equal(count, 1);
});
test("abort is preserved and refresh retires cached agents without aborting active work", async () => {
  const controller = new AbortController();
  const reason = Object.assign(Error("cancelled"), { name: "AbortError" });
  controller.abort(reason);
  const h = harness(undefined, async () => {
    throw reason;
  });
  await assert.rejects(
    h.transport.fetch("https://example.invalid", { signal: controller.signal }),
    (e) => e === reason,
  );
  assert.equal(h.routes.length, 0);
  const direct = harness("DIRECT");
  await direct.transport.fetch("https://example.invalid");
  await direct.transport.refresh();
  await direct.transport.fetch("https://example.invalid");
  assert.equal(direct.routes.length, 2);
});
test("real local HTTP request falls back from a dead proxy exactly once", async (t) => {
  const http = require("node:http"),
    net = require("node:net");
  let posts = 0;
  const server = http.createServer((req, res) => {
    posts++;
    req.resume();
    req.on("end", () => {
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const transport = createProxyTransport({
    getSession: () => ({
      resolveProxy: async () => `PROXY 127.0.0.1:${port}; DIRECT`,
    }),
  });
  const response = await transport.fetch(
    `http://127.0.0.1:${server.address().port}`,
    { method: "POST", body: "test" },
  );
  assert.equal(await response.text(), "ok");
  assert.equal(posts, 1);
  await transport.refresh();
  server.closeAllConnections();
});

test("cancelling during a stalled PAC resolution returns without sending a request", async () => {
  let fetches = 0;
  const transport = createProxyTransport({
    getSession: () => ({ resolveProxy: () => new Promise(() => {}) }),
    fetch: async () => {
      fetches++;
    },
  });
  const controller = new AbortController();
  const request = transport.fetch("https://example.invalid", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(request, (e) => e.name === "AbortError");
  assert.equal(fetches, 0);
});
