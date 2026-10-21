function createGitHubTransport(fetch) {
  return {
    async request({ url, method = "GET", headers = {}, body, signal }) {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.hostname !== "github.com" || target.username || target.password || target.port ||
          !/^\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(target.pathname)) {
        throw new Error("Git 同步仅允许访问 GitHub HTTPS 仓库。");
      }
      const timeout = AbortSignal.timeout(120000);
      async function* requestBody() {
        if (body instanceof Uint8Array) { yield body; return; }
        for await (const chunk of body) yield chunk;
      }
      try {
        const response = await fetch(url, {
          method,
          headers: { ...headers, "User-Agent": "DanceMonkey-Notes" },
          ...(body ? { body: requestBody(), duplex: "half" } : {}),
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error("仓库地址已重定向，请检查仓库名称后重新绑定。");
        }
        return {
          url: response.url || url,
          method,
          headers: Object.fromEntries(response.headers.entries()),
          statusCode: response.status,
          statusMessage: response.statusText,
          body: (async function* () {
            let bytes = 0;
            try {
              for await (const chunk of response.body || []) {
                bytes += chunk.byteLength;
                if (bytes > 256 * 1024 * 1024) throw new Error("transfer-limit");
                yield chunk;
              }
            } catch (error) {
              throw new Error(error.message === "transfer-limit"
                ? "仓库单次传输超过 256 MiB，请使用较小的专用笔记仓库。"
                : "GitHub 数据传输中断，请检查网络后重新预览。");
            }
          })(),
        };
      } catch (error) {
        if (error.message === "仓库地址已重定向，请检查仓库名称后重新绑定。") throw error;
        throw new Error("GitHub Git 网络请求失败，请检查网络、系统代理或稍后重试。");
      }
    },
  };
}

module.exports = { createGitHubTransport };
