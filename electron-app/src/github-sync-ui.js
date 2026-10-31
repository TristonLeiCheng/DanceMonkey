(() => {
  function create(api, { esc, attr, beforeRender, onChange }) {
    let state = { auth: {}, sync: {}, root: "" };
    let draft = {};
    let repositories = [];
    let repositoriesLoaded = false;
    let selectedRepo = "";
    let preview = null;
    let choices = new Map();
    let comparison = null;
    const strategyLabels = { local: "保留本地", remote: "采用远端", both: "两份都保留", combine: "拼接成一篇" };
    function setPreview(value) { preview = value; choices = new Map(); comparison = null; }
    let device = null;
    let busy = false;
    let quickBusy = false;
    let message = "";
    let error = "";
    let timer = null;
    let active = false;
    let epoch = 0;
    let advancedOpen = false;
    let setupRequired = false;
    let awaitingRepository = false;

    function capture() {
      const card = document.querySelector(".ws-github-sync");
      if (!card) return;
      for (const input of card.querySelectorAll("[data-github-field]")) draft[input.dataset.githubField] = input.value;
      const selection = card.querySelector("[data-github-repository]");
      if (selection) selectedRepo = selection.value;
      const advanced = card.querySelector("[data-github-advanced]");
      if (advanced) advancedOpen = advanced.open;
    }
    function update() {
      onChange?.();
      const card = document.querySelector(".ws-github-sync");
      if (!card) return;
      const scrollTop = card.querySelector(".github-preview")?.scrollTop || 0;
      card.outerHTML = render();
      const list = document.querySelector(".github-preview");
      if (list) list.scrollTop = scrollTop;
      const dialog = document.querySelector(".github-setup-dialog");
      if (dialog && !dialog.open) {
        dialog.showModal();
        dialog.addEventListener("cancel", () => { setupRequired = false; });
      }
    }
    async function load() {
      if (!api.githubSync) return;
      const result = await api.githubSync.status();
      if (!result.success) { error = result.error || "读取同步设置失败"; return; }
      if (state.root !== result.root) {
        setPreview(null);
        selectedRepo = "";
        draft = {};
        message = "";
        error = "";
        awaitingRepository = false;
      }
      if (state.auth?.login !== result.auth?.login || state.auth?.clientId !== result.auth?.clientId) {
        repositories = []; repositoriesLoaded = false; selectedRepo = "";
      }
      state = result;
      const binding = state.sync.binding || {};
      draft = { clientId: state.auth.clientId || "", appSlug: state.auth.appSlug || "",
        owner: binding.owner || "", repo: binding.repo || "", branch: binding.branch || "", ...draft };
      onChange?.();
    }
    async function loadRepositories() {
      if (!api.githubSync.repositories || !state.auth.connected) return;
      const result = await api.githubSync.repositories();
      if (!result.success) throw new Error(result.error || "加载笔记库失败");
      repositories = result.repositories || [];
      repositoriesLoaded = true;
      if (!repositories.some((repo) => repo.fullName === selectedRepo)) {
        selectedRepo = repositories.length === 1 ? repositories[0].fullName : "";
      }
    }
    function pause() {
      active = false;
      clearTimeout(timer);
      timer = null;
      epoch += 1;
      if (device) {
        device = null;
        void api.githubSync?.cancelAuth().catch(() => {});
      }
    }
    function schedule() {
      clearTimeout(timer);
      if (!active || !device) return;
      const currentEpoch = epoch;
      timer = setTimeout(async () => {
        if (!active || !device || currentEpoch !== epoch) return;
        capture();
        if (Date.now() >= device.expiresAt) { device = null; error = "验证码已过期，请重新连接。"; update(); return; }
        try {
          const result = await api.githubSync.pollAuth();
          if (currentEpoch !== epoch || !active) return;
          if (!result.success) throw new Error(result.error || "授权失败");
          if (result.status === "authorized" || (result.connected && !result.pending)) {
            device = null;
            await load();
            message = "连接成功！下一步创建笔记库，或选择已有笔记库。";
            try { await loadRepositories(); } catch (cause) { error = cause.message; }
          } else if (["expired", "denied", "cancelled", "error", "idle"].includes(result.status)) {
            device = null;
            error = "授权已取消、过期或被拒绝，请重新连接。";
          } else if (device) device.interval = Math.max(5, Number(result.interval) || device.interval);
        } catch (cause) { error = cause.message || "授权状态检查失败"; }
        update();
        schedule();
      }, Math.max(5, Number(device.interval) || 5) * 1000);
    }
    function renderList(title, rows) {
      return rows?.length ? `<details open><summary>${esc(title)} · ${rows.length}</summary><ul>${rows.map((row) => {
        const path = typeof row === "string" ? row : row.path;
        const label = path === "Journal/task-module.json" ? "任务数据 · " : path === "Journal/zentask-projects.json" ? "项目数据 · " : "";
        const deletion = typeof row === "string" ? "" : `（${row.side === "local" ? "本地删除" : "远端删除"}）`;
        return `<li>${esc(`${label}${path}${deletion}`)}</li>`;
      }).join("")}</ul></details>` : "";
    }
    function conflictDetail(file) {
      return preview?.conflictDetails?.find((item) => item.path === file) || { path: file, options: ["local", "remote"] };
    }
    function renderConflicts() {
      if (!preview?.conflicts?.length) return "";
      const remaining = preview.conflicts.filter((file) => !choices.has(file)).length;
      const disabled = busy ? "disabled" : "";
      const side = (title, item) => `<section><h5>${title}${item.deleted ? " · 已删除" : ` · ${item.bytes} 字节`}</h5>${item.deleted ? '<p>此版本中没有该文件。</p>' : item.text != null ? `<pre>${esc(item.text)}</pre>${item.truncated ? '<p>仅显示前 16 KB；处理时使用完整文件。</p>' : ""}` : /^data:image\/(png|jpeg|gif|webp);base64,/.test(item.image || "") ? `<img src="${attr(item.image)}" alt="${title}图片版本" />` : '<p>图片文件，可选择保留任一版本或两份都保留。</p>'}</section>`;
      return `<section class="github-conflicts" aria-label="解决同步冲突">
        <h4>选择冲突处理方式 · 还剩 ${remaining} / ${preview.conflicts.length} 项</h4>
        <p>选择不会立即修改文件。双方原始副本已自动备份，确认同步后才应用。</p>
        <div class="ws-settings-actions"><button type="button" data-module-action="github-conflicts-local" ${disabled}>全部保留本地</button><button type="button" data-module-action="github-conflicts-remote" ${disabled}>全部采用远端</button></div>
        ${preview.conflicts.map((file) => {
          const detail = conflictDetail(file), choice = choices.get(file);
          const label = file === "Journal/task-module.json" ? "任务数据 · " : file === "Journal/zentask-projects.json" ? "项目数据 · " : "";
          return `<article class="github-conflict"><h4 class="github-path">${esc(label + file)}</h4>
            <p>${detail.localDeleted ? "本地已删除，远端已修改。" : detail.remoteDeleted ? "远端已删除，本地已修改。" : "本地与远端都有不同内容。"}</p>
            <div class="ws-settings-actions" role="group" aria-label="${attr(file)} 的处理方式">${detail.options.map((strategy) => `<button type="button" data-module-action="github-conflict-${strategy}" data-id="${attr(file)}" aria-pressed="${choice === strategy}" ${disabled}>${strategy === "local" && detail.localDeleted ? "采用本地删除" : strategy === "remote" && detail.remoteDeleted ? "采用远端删除" : strategyLabels[strategy]}</button>`).join("")}</div>
            ${choice ? `<p class="github-choice">已选择：${esc(strategyLabels[choice])}${choice === "both" ? detail.localDeleted || detail.remoteDeleted ? "；保留仍存在的版本，撤销删除。" : "；本地保留原文件名，远端自动另存副本，两份都会同步。" : choice === "combine" ? "；本地全文在前，远端全文在后，可能包含重复内容，不会自动去重。" : (choice === "local" && detail.localDeleted) || (choice === "remote" && detail.remoteDeleted) ? "；同步后两端都会删除此文件。" : "；此版本将用于两端。"}</p>` : ""}
            ${detail.options.length === 2 ? '<p>任务/项目按整文件选择；有关联的数据建议选择同一端，不逐条自动合并。</p>' : ""}
            <div class="ws-settings-actions"><button type="button" data-module-action="github-compare" data-id="${attr(file)}" aria-expanded="${comparison?.path === file}" ${disabled}>${comparison?.path === file ? "收起内容对照" : "查看双方内容"}</button></div>
            ${comparison?.path === file ? `<div class="github-comparison">${side("本地", comparison.local)}${side("远端", comparison.remote)}</div>` : ""}
          </article>`;
        }).join("")}
        <div class="ws-settings-actions github-resolve-bar"><button class="module-primary" type="button" data-module-action="github-resolve" ${busy || remaining ? "disabled" : ""}>预览解决结果</button><span>${remaining ? `还有 ${remaining} 项待选择` : "已全部选择，下一步确认变更"}</span></div>
      </section>`;
    }
    function render() {
      active = true;
      if (!api.githubSync) return '<section class="ws-settings-card ws-github-sync"><h2>GitHub 笔记同步</h2><p class="ws-settings-desc">请使用 Electron 桌面版连接 GitHub；浏览器预览不读写真实笔记。</p></section>';
      const auth = state.auth || {}, sync = state.sync || {};
      const appConfigured = Boolean(auth.clientId && auth.appSlug);
      const disabled = busy ? "disabled" : "";
      const field = (key, label, placeholder = "") => `<label>${esc(label)}<input data-github-field="${key}" value="${attr(draft[key] || "")}" placeholder="${attr(placeholder)}" ${disabled} autocomplete="off" /></label>`;
      return `<section class="ws-settings-card ws-github-sync" aria-busy="${busy}">
        <h2>GitHub 笔记同步 <small>本地编辑 · 多设备共享</small></h2>
        <p class="ws-settings-desc">连接账号，选择一个私有笔记库，同步笔记、任务和项目。离线照常编辑，只有确认手动同步后才上传。</p>
        ${setupRequired ? `<dialog class="github-setup-dialog" aria-labelledby="github-setup-title"><h3 id="github-setup-title">尚未配置 GitHub 授权应用</h3><p>当前版本缺少 GitHub App 的 Client ID 或 App slug，因此还不能打开有效的授权页面。</p><p>需要开发者先在 GitHub 注册一次 App，启用 Device Flow 和 Contents 读写权限，再填写公开标识。配置后，普通用户只需点击网页授权。</p><p>这里不需要 GitHub 密码、Token 或 Client Secret。</p><div class="ws-settings-actions"><button type="button" data-module-action="github-setup-close">稍后配置</button><button class="module-primary" type="button" data-module-action="github-setup-configure">查看配置项</button></div></dialog>` : ""}
        <div class="github-steps">
          <section class="github-step ${auth.connected ? "is-complete" : ""}">
            <h3><span class="github-step-number">1</span> 连接 GitHub ${auth.connected ? '<small>已完成</small>' : ""}</h3>
            ${auth.connected ? `<p>已连接 <strong>${esc(auth.login || "GitHub 账号")}</strong></p><button type="button" data-module-action="github-disconnect" ${disabled}>断开连接</button>` : `
              <p class="ws-settings-desc">在浏览器完成 GitHub 授权，不需要在 DM 中输入密码或访问令牌。</p>
              <button class="module-primary" type="button" data-module-action="github-connect" ${busy || device ? "disabled" : ""}>${appConfigured ? "连接 GitHub · 网页授权" : "连接 GitHub · 需先配置"}</button>
              ${!appConfigured ? '<p class="ws-settings-desc">此开发版尚未配置发行方 GitHub App，开发者需在下方高级设置中完成一次配置。</p>' : ""}`}
            ${device ? `<div class="github-device"><span>在 GitHub 授权页粘贴验证码</span><strong>${esc(device.userCode)}</strong><div class="ws-settings-actions"><button type="button" data-module-action="github-copy-code" ${disabled}>复制验证码</button><button type="button" data-module-action="github-open-verification" ${disabled}>打开授权网页</button><button type="button" data-module-action="github-cancel">取消</button></div><p>完成授权后这里会自动更新。请勿向他人提供验证码。</p></div>` : ""}
          </section>
          <section class="github-step ${sync.binding ? "is-complete" : ""}">
            <h3><span class="github-step-number">2</span> 创建或选择笔记库 ${sync.binding ? '<small>已完成</small>' : ""}</h3>
            ${sync.binding ? `<p class="github-path"><strong>${esc(sync.binding.owner)}/${esc(sync.binding.repo)}</strong> · ${esc(sync.binding.branch)}</p><p class="ws-settings-desc">已绑定私有笔记库。另一台电脑连接 GitHub 后，选择相同仓库即可。</p>` : `
              <div class="ws-settings-actions"><button class="module-primary" type="button" data-module-action="github-create" ${busy || !auth.connected ? "disabled" : ""}>创建笔记库 · 打开 GitHub</button><button type="button" data-module-action="github-repositories" ${busy || !auth.connected ? "disabled" : ""}>${repositoriesLoaded ? "刷新笔记库列表" : "选择已有笔记库"}</button></div>
              <p class="ws-settings-desc">网页中填写仓库名称（如 my-notes），选择 <strong>Private</strong> 并确认创建。这里不会自动创建或上传文件。</p>
              <div class="github-repo-setup ${awaitingRepository ? "is-active" : ""}"><p>创建完成后，授权 DM 访问该仓库，再回来刷新列表。</p><div class="ws-settings-actions"><button type="button" data-module-action="github-install" ${busy || !auth.connected || !auth.appSlug ? "disabled" : ""}>授权笔记库 · 打开网页</button><button type="button" data-module-action="github-repositories" ${busy || !auth.connected ? "disabled" : ""}>已完成，刷新列表</button></div><p class="ws-settings-desc">授权页选择 Only select repositories，仅选中笔记仓库。</p></div>
              ${repositoriesLoaded ? repositories.length ? `<label>可用的私有笔记库<select data-github-repository ${disabled}><option value="">请选择笔记库</option>${repositories.map((repo) => `<option value="${attr(repo.fullName)}" ${selectedRepo === repo.fullName ? "selected" : ""}>${esc(repo.fullName)}</option>`).join("")}</select></label><button class="module-primary" type="button" data-module-action="github-use-repository" ${disabled}>确认选择并进入同步</button><p class="ws-settings-desc">选择列表中的仓库还未完成绑定。请点击上方「确认选择并进入同步」，之后第 3 步才可预览。此操作不会上传或下载笔记。</p>` : '<p class="ws-settings-desc">暂未找到已授权且有写权限的私有仓库。请先创建、授权，再刷新；不会列出公开或只读仓库。</p>' : ""}`}
          </section>
          <section class="github-step" data-github-sync-step>
            <h3><span class="github-step-number">3</span> 手动同步笔记、任务与项目</h3>
            <p class="ws-settings-desc" data-github-sync-hint>${!auth.connected ? "请先完成第 1 步：连接 GitHub。" : !sync.binding ? "尚未绑定笔记库：请回到第 2 步，点击「确认选择并进入同步」。" : !preview ? "笔记库已绑定。先点击「预览同步差异」，查看变更后才可确认同步。" : preview.conflicts?.length ? "在下方为冲突文件选择处理方式，再点击「预览解决结果」。" : "预览已就绪，可以确认手动同步。"}</p>
            <p class="ws-settings-desc">本地笔记库：<span class="github-path">${esc(state.root || "读取中…")}</span></p>
            <div class="ws-settings-actions"><button type="button" data-module-action="github-preview" ${busy || !auth.connected || !sync.binding ? "disabled" : ""}>预览同步差异</button><button class="module-primary" type="button" data-module-action="github-sync" ${busy || !auth.connected || !preview || preview.conflicts?.length ? "disabled" : ""}>确认并手动同步</button><button type="button" data-module-action="github-backup" ${disabled}>备份 / 冲突目录</button></div>
            <p class="ws-settings-desc">最近成功同步：${esc(sync.lastSync ? new Date(sync.lastSync).toLocaleString() : "尚无")}${sync.pending ? " · 检测到未完成同步，请重新预览以恢复" : ""}</p>
            ${preview ? `<div class="github-preview">${!preview.uploads?.length && !preview.downloads?.length && !preview.deletions?.length && !preview.conflicts?.length ? "本地与远端内容一致。" : ""}${renderList("上传", preview.uploads)}${renderList("下载", preview.downloads)}${renderList("删除", preview.deletions)}${renderConflicts()}${preview.resolutions?.length ? `<section><h4>冲突解决方案 · 尚未写入</h4><ul>${preview.resolutions.map((item) => `<li>${esc(item.path)}：${esc(strategyLabels[item.strategy])}${item.copyPath ? `；远端另存为 ${esc(item.copyPath)}` : ""}</li>`).join("")}</ul><p>确认上方变更后点击「确认并手动同步」。如需更改选择，点击「预览同步差异」重新选择。</p></section>` : ""}</div>` : ""}
          </section>
        </div>
        ${busy ? '<p role="status">正在处理，请稍候…</p>' : ""}
        ${error || sync.error ? `<div class="module-error" role="alert">${esc(error || sync.error)}</div>` : ""}
        ${message ? `<p class="ws-settings-ok" role="status">${esc(message)}</p>` : ""}
        <details data-github-advanced ${advancedOpen ? "open" : ""}><summary>高级设置 · 开发者配置与手动绑定</summary>
          <p class="ws-settings-desc">正式发行版由开发者预置 GitHub App，普通用户无需填写。开发版需启用 Device Flow、Contents 读写权限；以下是公开标识，不是密码或 Client Secret。</p>
          <div class="form-columns">${field("clientId", "Client ID", "Iv23…")}${field("appSlug", "App slug", "your-notes-app")}</div>
          <button type="button" data-module-action="github-configure" ${disabled}>保存 App 配置</button>
          <details><summary>手动指定仓库（可选）</summary><div class="form-columns">${field("owner", "仓库所有者", "owner")}${field("repo", "私有仓库名称", "notes")}${field("branch", "分支（留空使用默认分支）")}</div><button type="button" data-module-action="github-bind" ${busy || !auth.connected ? "disabled" : ""}>绑定当前笔记库</button></details>
          <button type="button" data-module-action="github-refresh" ${disabled}>刷新连接状态</button>
          <p class="ws-settings-desc">可在笔记页左侧切换本地笔记库；每个库单独绑定。不支持更换某个库已绑定的仓库或分支。</p>
        </details>
        <details><summary>同步范围与隐私说明</summary><p class="ws-settings-desc">同步 .md、.png、.jpg、.jpeg、.gif、.webp，以及任务数据 Journal/task-module.json 和项目数据 Journal/zentask-projects.json。每文件 ≤10 MiB，最多 5000 个文件 / 200 MiB。其他 JSON、应用设置、API Key 和隐藏目录不上传；符号链接会阻止同步。</p><p class="ws-settings-desc">任务和项目按整个数据文件判断冲突；两台设备同时修改同一数据文件时会停止同步、保留双方副本，不逐条自动合并。</p><p class="ws-settings-desc">私有仓库不是端到端加密；删除的内容仍可能留在 Git 历史中。请检查截图隐私。断开连接不删除任何笔记。</p></details>
      </section>`;
    }
    async function handleAction(action, id) {
      if (!action.startsWith("github-")) return false;
      if (!api.githubSync || (busy && action !== "github-cancel")) return true;
      capture();
      if (action.startsWith("github-conflict-") || action.startsWith("github-conflicts-")) {
        const strategy = action.split("-").at(-1);
        const files = action.startsWith("github-conflicts-") ? preview?.conflicts || [] : [id];
        for (const file of files) {
          if (preview?.conflicts?.includes(file) && conflictDetail(file).options.includes(strategy)) choices.set(file, strategy);
        }
        error = ""; message = ""; update();
        const buttons = document.querySelector(".ws-github-sync")?.querySelectorAll("[data-module-action]") || [];
        [...buttons].find((button) => button.dataset.moduleAction === action && button.dataset.id === id)?.focus();
        return true;
      }
      if (action === "github-setup-close" || action === "github-setup-configure") {
        document.querySelector(".github-setup-dialog")?.close();
        setupRequired = false;
        if (action === "github-setup-configure") advancedOpen = true;
        update();
        if (action === "github-setup-configure") {
          document.querySelector("[data-github-advanced]")?.scrollIntoView({ block: "center" });
          document.querySelector('[data-github-field="clientId"]')?.focus();
        }
        return true;
      }
      beforeRender?.();
      error = ""; message = ""; busy = true;
      update();
      try {
        let result;
        if (action === "github-configure") {
          epoch += 1; clearTimeout(timer); device = null; preview = null;
          result = await api.githubSync.configureAuth({ clientId: draft.clientId, appSlug: draft.appSlug });
        }
        if (action === "github-install") { result = await api.githubSync.openInstallation(); awaitingRepository = true; }
        if (action === "github-create") { result = await api.githubSync.openCreateRepository(); awaitingRepository = true; }
        if (action === "github-copy-code") result = await api.githubSync.copyCode();
        if (action === "github-open-verification") result = await api.githubSync.openVerification();
        if (action === "github-connect") {
          if (!state.auth.clientId || !state.auth.appSlug) {
            advancedOpen = true;
            setupRequired = true;
            throw new Error("此开发版尚未预置完整 GitHub App 配置，请先填写 Client ID 和 App slug。");
          }
          const attempt = ++epoch;
          preview = null;
          result = await api.githubSync.startAuth();
          if (result.success && attempt === epoch && active) { device = result; schedule(); }
          else if (result.success) { await api.githubSync.cancelAuth(); }
        }
        if (action === "github-cancel") { epoch += 1; clearTimeout(timer); device = null; result = await api.githubSync.cancelAuth(); }
        if (action === "github-disconnect") { epoch += 1; clearTimeout(timer); device = null; preview = null; result = await api.githubSync.disconnect(); repositories = []; repositoriesLoaded = false; selectedRepo = ""; }
        if (action === "github-bind") { preview = null; result = await api.githubSync.bind({ owner: draft.owner, repo: draft.repo, branch: draft.branch }); }
        if (action === "github-repositories") { await load(); await loadRepositories(); result = { success: true }; }
        if (action === "github-use-repository") {
          const repo = repositories.find((item) => item.fullName === selectedRepo);
          if (!repo) throw new Error("请先从列表选择一个私有笔记库。");
          preview = null;
          result = await api.githubSync.bind({ owner: repo.owner, repo: repo.repo });
        }
        if (action === "github-preview") { setPreview(null); result = await api.githubSync.preview(); if (result.success) setPreview(result); }
        if (action === "github-compare") {
          if (comparison?.path === id) { comparison = null; result = { success: true }; }
          else { result = await api.githubSync.inspectConflict({ previewId: preview?.id, path: id }); if (result.success) comparison = result; }
        }
        if (action === "github-resolve") {
          if (!preview?.conflicts?.length || preview.conflicts.some((file) => !choices.has(file))) throw new Error("请为每个冲突文件选择处理方式。");
          result = await api.githubSync.resolveConflicts({ previewId: preview.id,
            resolutions: preview.conflicts.map((file) => ({ path: file, strategy: choices.get(file) })) });
          if (result.success) setPreview(result);
        }
        if (action === "github-sync") { result = await api.githubSync.sync({ previewId: preview?.id }); if (!result.cancelled) preview = null; }
        if (action === "github-backup") result = await api.githubSync.openBackup();
        if (action === "github-refresh") { await load(); result = { success: true }; }
        if (!result?.success) throw new Error(result?.error || "操作失败");
        await load();
        if (action === "github-sync") message = result.cancelled ? "已取消，未执行同步。" : "手动同步完成。";
        else if (action === "github-resolve") message = "解决方案已就绪，尚未修改文件。确认变更后点击「确认并手动同步」。";
        else if (["github-bind", "github-use-repository"].includes(action)) message = "笔记库已就绪。请先预览差异，确认后再同步。";
        else if (action === "github-configure") message = "App 配置已保存，现在可以点击连接 GitHub。";
        else if (action === "github-disconnect") message = "本机凭据已移除，笔记仍保留。";
        else if (action === "github-create") message = "已打开 GitHub 创建页。选择 Private 并创建，然后点击「授权笔记库」。";
        else if (action === "github-install") message = "已打开仓库授权页。完成后点击「已完成，刷新列表」。";
        else if (action === "github-copy-code") message = "验证码已复制，请在 GitHub 授权页粘贴。";
      } catch (cause) { error = cause.message || "GitHub 操作失败"; }
      finally { busy = false; update(); }
      if (!error && state.sync.binding && ["github-bind", "github-use-repository"].includes(action)) {
        document.querySelector("[data-github-sync-step]")?.scrollIntoView({ block: "center" });
        document.querySelector('[data-module-action="github-preview"]')?.focus();
      }
      return true;
    }
    function renderQuickButton() {
      const running = busy || quickBusy || state.sync?.busy;
      const configured = Boolean(state.auth.connected && state.sync.binding);
      const label = running ? '正在同步笔记…' : error ? `笔记同步失败：${error}` : message || (configured ? '立即同步笔记' : '设置笔记同步');
      const recent = state.sync.lastSync ? ` · 最近同步 ${new Date(state.sync.lastSync).toLocaleString()}` : '';
      return `<button type="button" class="ws-header-icon ws-quick-sync ${running ? 'is-syncing' : ''} ${error ? 'has-error' : ''}" data-action="quick-note-sync" aria-label="${attr(label)}" title="${attr(label + recent)}" ${running ? 'disabled aria-busy="true"' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1"/></svg><span class="ws-sync-dot ${configured ? 'connected' : ''}" aria-hidden="true"></span></button>`;
    }
    async function quickSync() {
      if (quickBusy || busy) return { busy: true };
      quickBusy = true;
      capture(); beforeRender?.(); onChange?.();
      try {
        if (!api.githubSync) return { openSettings: true };
        error = ''; message = '';
        await load();
        if (error || !state.auth.connected || !state.sync.binding) return { openSettings: true };
        if (state.sync.busy) return { busy: true };
        await handleAction('github-preview');
        if (error || !preview || preview.conflicts?.length) return { openSettings: true };
        await handleAction('github-sync');
        return { openSettings: Boolean(error) };
      } catch (cause) { error = cause.message || '笔记同步失败，请重试。'; return { openSettings: true }; }
      finally { quickBusy = false; update(); }
    }
    return { load, render, handleAction, pause, capture, quickSync, renderQuickButton };
  }
  window.DMGitHubSyncUI = { create };
})();
