(() => {
  const CARD_FIELDS = [["summary", "人物概览"], ["knowledge", "知识与经验"], ["thinking", "思考方式"], ["style", "表达风格"], ["boundaries", "回答边界"]];
  const KINDS = [["article", "文章"], ["note", "笔记"], ["chat", "聊天记录"]];
  const profileTools = window.DMPersonaProfile;

  function create(api, { esc, attr, rerender, openSettings }) {
    const service = api.personas;
    const outlookService = api.outlook;
    const drafts = new Map();
    let people = [], person = null, selectedId = "", loaded = false, loading = null;
    let busy = false, progress = "", error = "", activeRequest = null;
    let stream = "", pendingMessage = "", picker = null, deleting = false;
    let newPerson = { open: false, name: "", description: "" };
    let outlook = null, outlookError = "", outlookConfigOpen = null;
    const outlookConfig = { clientId: "", tenantId: "" };
    let scope = null;

    function draft(id = selectedId) {
      if (!drafts.has(id)) drafts.set(id, { tab: "sources", name: "", description: "", title: "", kind: "article", speaker: "", text: "", question: "", correction: "", preview: null, notice: "", profileOpen: false, outlookEmail: "", outlookRange: "year", outlookSince: "" });
      return drafts.get(id);
    }
    function accept(next, { profile = false, details = false } = {}) {
      if (!next?.id) throw new Error("人物数据不完整，请重试。");
      const previous = person;
      selectedId = next.id;
      person = next;
      const first = !drafts.has(next.id);
      const d = draft();
      if (first || profile) { d.name = next.name || ""; d.description = next.description || ""; }
      if (first || !d.profile || details) { d.profile = profileTools.normalize(next.profile); d.profileRevision = next.sourceRevision; }
      else if (previous?.id === next.id && d.profileRevision === previous.sourceRevision &&
        JSON.stringify(profileTools.normalize(previous.profile)) === JSON.stringify(profileTools.normalize(next.profile))) d.profileRevision = next.sourceRevision;
      if (next.outlook && (first || !d.outlookEmail)) {
        d.outlookEmail = next.outlook.email || "";
        d.outlookRange = next.outlook.since ? "saved" : "all";
        d.outlookSince = next.outlook.since || "";
      }
      const index = people.findIndex((item) => item.id === next.id);
      if (index < 0) people.push(next); else people[index] = next;
      deleting = false;
    }
    function requestId() { return `persona-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    function currentConversation() { return person?.conversations?.find((item) => item.id === person.activeConversationId); }
    function displayDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN"); }
    function markdown(value) {
      if (window.marked?.parse && window.DOMPurify?.sanitize) return window.DOMPurify.sanitize(window.marked.parse(String(value || "")));
      return `<div class="persona-plain">${esc(value || "")}</div>`;
    }
    function button(action, label, { id = "", primary = false, disabled = busy, danger = false } = {}) {
      return `<button type="button" data-persona-action="${action}" data-id="${attr(id)}" class="${primary ? "module-primary" : ""} ${danger ? "danger" : ""}" ${disabled ? "disabled" : ""}>${label}</button>`;
    }
    function input(key, label, value, { rows = 0, placeholder = "", disabled = busy, type = "text", readOnly = false } = {}) {
      const props = `data-persona-field="${key}" aria-label="${label}" ${disabled ? "disabled" : ""} ${readOnly ? "readonly" : ""} placeholder="${attr(placeholder)}"`;
      return `<label class="persona-field"><span>${label}</span>${rows ? `<textarea ${props} rows="${rows}">${esc(value || "")}</textarea>` : `<input type="${type}" ${props} value="${attr(value || "")}" />`}</label>`;
    }
    function updateLive() {
      const streamBox = scope?.querySelector("[data-persona-stream]");
      if (streamBox && activeRequest?.id === selectedId) streamBox.textContent = stream || "正在组织回答…";
      const status = scope?.querySelector("[data-persona-progress]");
      if (status) status.textContent = progress;
      const messages = scope?.querySelector(".persona-messages");
      if (messages && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 180) messages.scrollTop = messages.scrollHeight;
    }
    service?.onChunk?.((event) => {
      if (!activeRequest || activeRequest.kind !== "chat" || event.requestId !== activeRequest.requestId || activeRequest.id !== selectedId) return;
      stream += event.chunk || "";
      updateLive();
    });
    service?.onProgress?.((event) => {
      if (!activeRequest || event.requestId !== activeRequest.requestId || activeRequest.id !== selectedId) return;
      progress = event.message || "正在处理…";
      updateLive();
    });
    outlookService?.onProgress?.((event) => {
      if (!activeRequest || activeRequest.kind !== "outlook" || event.requestId !== activeRequest.requestId || activeRequest.id !== selectedId) return;
      progress = event.message || "正在处理 Outlook 邮件…";
      updateLive();
    });
    async function refreshOutlook({ syncConfig = false } = {}) {
      if (!outlookService) return;
      outlook = await outlookService.status();
      outlookError = "";
      if (syncConfig) { outlookConfig.clientId = outlook.clientId || ""; outlookConfig.tenantId = outlook.tenantId || ""; }
    }

    async function load() {
      if (!service || loaded) return;
      if (loading) return loading;
      loading = (async () => {
        try {
          people = await service.list();
          if (!Array.isArray(people)) throw new Error("无法读取人物列表。");
          if (!selectedId && people.length) accept(await service.get(people[0].id));
          try { await refreshOutlook({ syncConfig: true }); } catch (cause) { outlookError = cause?.message || "无法读取 Outlook 连接状态，请重试。"; }
          loaded = true;
        } catch (cause) { error = cause?.message || "读取人物失败"; }
        finally { loading = null; }
      })();
      return loading;
    }
    async function run(label, operation, kind = "") {
      if (busy || !service) return;
      busy = true; error = ""; progress = label;
      if (kind) activeRequest = { id: selectedId, requestId: requestId(), kind };
      rerender();
      try { await operation(activeRequest?.requestId); }
      catch (cause) { error = cause?.message || "操作失败，请重试。"; }
      finally { busy = false; activeRequest = null; progress = ""; stream = ""; pendingMessage = ""; rerender(); }
    }
    function flatten(nodes) {
      return (nodes || []).flatMap((node) => node.type === "file" ? [node] : flatten(node.children));
    }
    function sourceList() {
      const sources = person.sources || [];
      return `<div class="persona-source-list">${sources.length ? sources.map((item) => `<article class="persona-source"><div><strong>${esc(item.title || "未命名资料")}</strong><small>${esc(item.kind === "email" ? "Outlook 邮件" : KINDS.find(([key]) => key === item.kind)?.[1] || "资料")}${item.speaker ? ` · 目标说话人：${esc(item.speaker)}` : ""}${item.kind === "email" && item.email ? `${typeof item.email.from === "string" ? ` · ${esc(item.email.from)}` : ""}${item.email.sentAt ? ` · ${esc(displayDate(item.email.sentAt))}` : ""}` : ""}</small>${item.text ? `<details><summary>查看内容</summary><pre>${esc(item.text)}</pre></details>` : ""}</div>${button("remove-source", "移除", { id: item.id })}</article>`).join("") : '<div class="persona-empty">添加文章、笔记、聊天记录或邮件，建立这个人的知识与表达样本。</div>'}</div>`;
    }
    function outlookStats(stats) {
      if (!stats) return "";
      const count = (key) => Number.isFinite(stats[key]) ? stats[key] : 0;
      return `本次检查 ${count("found")} 封，新增 ${count("added")} 封，更新 ${count("updated")} 封，重复 ${count("duplicates")} 封，跳过 ${count("skipped")} 封。${count("capacitySkipped") ? `另有 ${count("capacitySkipped")} 封因资料容量限制未导入；请移除不需要的邮件资料后重试。` : ""}${stats.hasMore ? "本次最多检查最近 200 封，仍有更多邮件未检查。" : ""}`;
    }
    function renderOutlook() {
      if (!outlookService) return "";
      const d = draft();
      const link = person.outlook;
      const connected = Boolean(outlook?.connected);
      const mismatch = Boolean(connected && link?.accountId && link.accountId !== outlook.account?.id);
      const canConnect = outlook?.secureStorageAvailable !== false;
      const configOpen = outlookConfigOpen ?? !outlook?.configured;
      return `<section class="persona-outlook" aria-label="Outlook 邮件导入"><div class="persona-panel-heading"><h3>Outlook 邮件</h3>${button("outlook-config", configOpen ? "收起连接设置" : "连接设置")}</div>
        <p class="persona-hint">输入人物邮箱，自动从你登录的公司邮箱搜索此人发来的邮件，去重后生成人物卡预览。</p>
        ${outlookError ? `<p class="module-error" role="alert">${esc(outlookError)} ${button("outlook-refresh", "重试")}</p>` : ""}
        ${configOpen ? `<div class="persona-outlook-config"><details class="persona-outlook-guide" ${outlook?.configured ? "" : "open"}><summary>微软应用和权限怎么配置？</summary><ol><li>在 Microsoft Entra 管理中心注册应用，选择“仅此组织目录中的账户”。复制“应用程序（客户端）ID”和“目录（租户）ID”。</li><li>在“身份验证”中添加“移动和桌面应用程序”平台，重定向 URI 填写 <code>http://localhost</code>。</li><li>在“API 权限”中添加 Microsoft Graph 的委托权限 <code>Mail.Read</code>；公司要求时请 IT 管理员批准。无需创建客户端密码。</li></ol></details>
          ${input("outlook-config:tenantId", "目录（租户）ID", outlookConfig.tenantId, { placeholder: "粘贴公司租户 ID" })}${input("outlook-config:clientId", "应用程序（客户端）ID", outlookConfig.clientId, { placeholder: "粘贴注册应用的客户端 ID" })}
          ${button("outlook-configure", "保存配置并连接 Outlook", { primary: true, disabled: busy || !canConnect })}${connected ? '<p class="persona-hint">保存配置会退出当前 Outlook 账户，再打开微软登录页面。</p>' : ""}</div>` : ""}
        ${!canConnect ? `<p class="module-error" role="alert">本机安全存储不可用，暂时无法连接 Outlook。请启用系统钥匙串或凭据存储后重试。 ${button("outlook-refresh", "重试")}</p>` : ""}
        <div class="persona-outlook-account"><span>${connected ? `已连接：${esc(outlook.account?.username || outlook.account?.name || "Microsoft 365 账户")}` : "尚未连接 Outlook"}</span><div class="persona-actions">${connected ? button("outlook-disconnect", "退出账户") : outlook?.configured ? button("outlook-connect", "连接 Outlook", { primary: true, disabled: busy || !canConnect }) : ""}</div></div>
        <div class="persona-inline persona-outlook-fields">${input("outlookEmail", "人物邮箱", link?.email || d.outlookEmail, { placeholder: "例如：name@company.com", type: "email", readOnly: Boolean(link?.email) })}<label class="persona-field"><span>邮件时间范围</span><select data-persona-field="outlookRange" ${busy ? "disabled" : ""}>${[["year", "近一年"], ["quarter", "近三个月"], ["all", "全部时间"], ...(d.outlookSince ? [["saved", `自 ${d.outlookSince.slice(0, 10)} 起`]] : [])].map(([key, label]) => `<option value="${key}" ${d.outlookRange === key ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label></div>
        ${link ? `<p class="persona-hint">已关联 ${esc(link.email)}${link.lastImportedAt ? ` · 上次导入 ${esc(displayDate(link.lastImportedAt))}` : ""}。缩小时间范围不会删除已导入资料；创建其他人的分身请新建人物。</p>${link.lastStats ? `<p class="persona-hint">${esc(outlookStats(link.lastStats))}</p>` : ""}` : ""}
        ${mismatch ? `<p class="module-error" role="alert">此人物关联的邮箱账户是 ${esc(link.accountUsername || "原 Microsoft 365 账户")}，请退出并登录原账户后更新。</p>` : ""}
        ${d.preview ? '<p class="persona-hint">请先保存或放弃现有人物卡预览，再导入邮件。</p>' : ""}
        <div class="persona-actions">${button("outlook-import", link ? "更新邮件并生成" : "导入并生成人物卡", { primary: true, disabled: busy || !connected || mismatch || Boolean(d.preview) })}</div>
        <p class="persona-hint">仅导入邮件正文，自动清理引用、签名并保留来源。选中的正文会交给当前 AI 服务生成预览，请使用公司允许的 AI 服务。</p></section>`;
    }
    function renderSources() {
      const d = draft();
      return `${renderOutlook()}<section class="persona-panel"><h3>人物资料 <small>${person.sources?.length || 0} 份</small></h3>
        <div class="persona-inline">${input("title", "资料标题", d.title, { placeholder: "例如：关于产品设计的一篇文章" })}<label class="persona-field"><span>资料类型</span><select data-persona-field="kind" ${busy ? "disabled" : ""}>${KINDS.map(([key, title]) => `<option value="${key}" ${d.kind === key ? "selected" : ""}>${title}</option>`).join("")}</select></label></div>
        <div data-persona-speaker ${d.kind === "chat" ? "" : "hidden"}>${input("speaker", "目标说话人", d.speaker, { placeholder: "与聊天记录中的姓名或昵称完全一致" })}<p class="persona-hint">仅学习此人的发言。其他人的话保留为对话背景，请保留记录中的说话人标记。</p></div>
        ${input("text", "粘贴资料", d.text, { rows: 6, placeholder: "粘贴文章、笔记，或包含说话人标记的聊天记录…" })}
        <div class="persona-actions">${button("add-source", "加入资料", { primary: true })}${button("import-files", "导入文件")}${button("pick-notes", "从现有笔记选择")}</div>
        ${picker ? `<div class="persona-note-picker"><strong>选择当前笔记库中的 Markdown</strong>${picker.files.length ? picker.files.map((file) => `<label><input type="checkbox" data-persona-note="${attr(file.path)}" ${picker.selected.has(file.path) ? "checked" : ""} ${busy ? "disabled" : ""} />${esc(file.path)}</label>`).join("") : '<p>当前笔记库没有可导入的笔记。</p>'}<div class="persona-actions">${button("import-notes", "加入选中笔记", { primary: true, disabled: busy || !picker.files.length })}${button("close-picker", "取消")}</div></div>` : ""}
        <p class="persona-hint">支持 TXT、Markdown、JSON / JSONL 文件。JSON 聊天导出需包含说话人信息。</p>${sourceList()}<div class="persona-actions">${button("generate", person.card ? "用资料更新人物卡" : "生成人物卡预览", { primary: true, disabled: busy || !hasEvidence() })}</div></section>`;
    }
    function renderCard() {
      const d = draft();
      const card = d.preview?.card || person.card;
      return `<section class="persona-panel"><div class="persona-panel-heading"><h3>${d.preview ? "人物卡预览 · 尚未保存" : `人物卡${person.cardVersion ? ` · v${person.cardVersion}` : ""}`}</h3>${button("generate", "根据资料生成", { disabled: busy || !hasEvidence() })}</div>
        ${card ? CARD_FIELDS.map(([key, title]) => d.preview ? input(`card:${key}`, title, card[key], { rows: key === "summary" ? 3 : 4 }) : `<div class="persona-card-section"><h4>${title}</h4><div class="persona-plain">${esc(card[key] || "尚未记录")}</div></div>`).join("") : '<div class="persona-empty">先加入资料并生成人物卡。预览可以编辑，保存后用于对话。</div>'}
        <div class="persona-actions">${d.preview ? `${button("save-card", "保存此版本", { primary: true })}${button("discard-preview", "放弃预览")}` : person.card ? button("edit-card", "编辑人物卡") : ""}</div>
        ${person.card ? `<div class="persona-correction"><h3>纠正 / 更新</h3>${input("correction", "补充一句话", d.correction, { rows: 3, placeholder: "例如：他倾向于先举具体例子，再总结原则。" })}<p class="persona-hint">先生成可编辑预览，确认保存后才更新人物卡。</p>${button("correct", "生成更新预览", { primary: true, disabled: busy || Boolean(d.preview) })}</div>` : ""}</section>`;
    }
    function citations(items) {
      if (!Array.isArray(items) || !items.length) return "";
      return `<details class="persona-citations"><summary>参考资料 · ${items.length}</summary>${items.map((item) => `<div><strong>${typeof item === "object" && item.id ? `[${esc(item.id)}] ` : ""}${esc(typeof item === "string" ? item : item.title || item.sourceTitle || item.sourceId || "资料")}</strong>${typeof item === "object" && (item.excerpt || item.snippet) ? `<p>${esc(item.excerpt || item.snippet)}</p>` : ""}</div>`).join("")}</details>`;
    }
    function renderChat() {
      const d = draft();
      const conversation = currentConversation();
      const messages = conversation?.messages || [];
      return `<section class="persona-panel persona-chat"><div class="persona-panel-heading"><label class="persona-field"><span>对话历史</span><select data-persona-field="conversation" ${busy ? "disabled" : ""}><option value="" ${!conversation ? "selected" : ""}>选择对话</option>${(person.conversations || []).map((item) => `<option value="${attr(item.id)}" ${item.id === person.activeConversationId ? "selected" : ""}>${esc(item.title || "新对话")}</option>`).join("")}</select></label><div class="persona-actions">${button("new-conversation", "新会话")}${conversation ? button("delete-conversation", d.deletingConversation ? "确认删除当前会话" : "删除当前会话", { danger: true }) : ""}${d.deletingConversation ? button("keep-conversation", "取消") : ""}</div></div>
        ${!person.card ? '<p class="persona-hint">先保存人物卡，即可开始和分身对话。</p>' : ""}<div class="persona-messages" aria-label="人物分身对话">${messages.length ? messages.map((message) => `<article class="persona-message ${message.role === "user" ? "user" : "assistant"}"><strong>${message.role === "user" ? "你" : esc(person.name)}</strong><div>${markdown(message.content)}</div>${citations(message.citations)}</article>`).join("") : '<div class="persona-empty">从一个具体问题开始。回答会参考此人物的资料与已保存的人物卡。</div>'}${pendingMessage ? `<article class="persona-message user"><strong>你</strong><div class="persona-plain">${esc(pendingMessage)}</div></article><article class="persona-message assistant"><strong>${esc(person.name)}</strong><div class="persona-plain" data-persona-stream aria-live="polite">${esc(stream || "正在组织回答…")}</div></article>` : ""}</div>
        ${input("question", "发送消息", d.question, { rows: 3, placeholder: "输入问题，Ctrl / ⌘ + Enter 发送", disabled: busy || !person.card })}<div class="persona-actions">${activeRequest?.kind === "chat" ? button("cancel", "停止回答", { disabled: false }) : button("send", "发送", { primary: true, disabled: busy || !person.card })}</div></section>`;
    }
    function renderVersions() {
      return `<section class="persona-panel"><h3>人物卡版本</h3><p class="persona-hint">恢复会将选中的内容保存为新版本，保留现有历史。</p>${(person.versions || []).length ? [...person.versions].reverse().map((version) => `<article class="persona-source"><div><strong>v${esc(version.version ?? version.cardVersion ?? "")}</strong><small>${esc(displayDate(version.createdAt))}</small><p>${esc(version.card?.summary || version.summary || "人物卡版本")}</p></div>${button("restore", "恢复此版本", { id: String(version.version ?? version.cardVersion ?? ""), disabled: busy || Boolean(draft().preview) })}</article>`).join("") : '<div class="persona-empty">保存第一张人物卡后会记录版本。</div>'}</section>`;
    }
    function hasEvidence() { return Boolean(person.sources?.length || profileTools.evidence(person.profile)); }
    function renderProfile() {
      const p = draft().profile;
      const select = (key, label, choices, current) => `<label class="persona-field"><span>${label}</span><select data-persona-field="profile:${key}" ${busy ? "disabled" : ""}>${choices.map(([value, title]) => `<option value="${attr(value)}" ${value === current ? "selected" : ""}>${esc(title)}</option>`).join("")}</select></label>`;
      let result = "";
      if (p.answers.every(a => a !== null)) {
        const score = profileTools.assess(p.answers);
        result = `<p class="persona-notice">观察结果：${esc(score.type)} · ${score.dimensions.map(d => `${esc(d.pair)}：${esc(d.letter)}（${d.observed}/3 题有观察）`).join("；")}。X 表示持平或信息不足。</p>`;
      }
      return `<section class="persona-panel"><h3>人物档案</h3><p class="persona-hint">手动填写你了解的信息，保存后可用于生成人物卡。事件按行记录日期、经过和你的观察，可随时编辑或删除对应行。</p>
        <div class="persona-inline">${input("profile:birthDate", "出生年月 / 日期（可选）", p.birthDate, { placeholder: "1990-05 或 1990-05-21" })}${select("zodiac", "星座（可选）", [["", "未填写"], ...profileTools.zodiac.map(s => [s, s])], p.zodiac)}</div>
        <p class="persona-hint">仅知道出生月份无法确定星座，请根据已知信息选择。</p>
        ${input("profile:resume", "简历 / 经历", p.resume, { rows: 6, placeholder: "教育背景、工作经历、项目与技能…" })}
        ${input("profile:events", "人物事件", p.events, { rows: 6, placeholder: "2024-06：负责新项目，先做小规模验证，再决定投入。\n2025-03：……" })}
        <h3>MBTI 观察测算</h3><p class="persona-hint">由你根据实际观察代填的简易倾向问卷，非官方 MBTI 测评或本人自评。每题可选“不了解”，不强行归类；星座和类型不会被当作确定人格的依据。</p>
        ${select("mbtiMode", "MBTI 记录方式", [["manual", "手动填写类型"], ["assessment", "使用下方问卷计算"]], p.mbtiMode)}
        ${input("profile:mbti", "MBTI 类型", p.mbti, { placeholder: "例如 INTJ；不确定的维度填 X", readOnly: p.mbtiMode === "assessment" })}
        <details><summary>填写 / 修改 12 道观察题</summary>${profileTools.questions.map(([title,a,b], i) => `<label class="persona-field"><span>${i+1}. ${esc(title)}</span><select data-persona-field="answer:${i}" ${busy ? "disabled" : ""}>${[["", "请选择"], ["1", a], ["-1", b], ["0", "不了解 / 无明显倾向"]].map(([v,label]) => `<option value="${v}" ${String(p.answers[i] ?? "") === v ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`).join("")}${button("assess-mbti", "测算并采用结果")}</details>${result}
        ${input("profile:mbtiNotes", "观察依据 / 备注", p.mbtiNotes, { rows: 3, placeholder: "记录观察场景；结果仅供参考，可继续修正。" })}
        <div class="persona-actions">${button("save-details", "保存人物档案", { primary: true })}${button("save-details-generate", "保存并生成人物卡", { primary: true })}${button("reload-details", "重新读取已保存档案")}</div></section>`;
    }
    function render() {
      if (!service) return '<section class="module-page persona-page"><h2>人物分身</h2><div class="persona-empty">请在桌面版中创建人物分身。浏览器预览不读取真实资料，也不连接 AI。</div></section>';
      const d = draft();
      return `<section class="module-page persona-page"><header class="persona-heading"><div><h2>人物分身</h2><p>用文章、笔记、聊天记录和邮件，整理一个人的知识和表达方式。</p></div>${button("settings", "AI 设置")}</header><p class="persona-privacy">人物资料独立保存在本机。生成与对话会把你加入此人物的相关资料提交至当前 AI 服务；回答是基于资料的模拟。</p>
        ${error ? `<div class="module-error" role="alert">${esc(error)} ${button("dismiss-error", "关闭提示", { disabled: false })}</div>` : ""}${busy ? `<div class="persona-progress" role="status"><span data-persona-progress>${esc(progress)}</span>${activeRequest ? button("cancel", "停止", { disabled: false }) : ""}</div>` : ""}
        <div class="persona-layout"><aside class="persona-sidebar"><div class="persona-panel-heading"><h3>我的人物</h3>${button("new-person", "＋ 新建")}</div>${newPerson.open ? `<div class="persona-create">${input("new:name", "人物名称", newPerson.name)}${input("new:description", "简介（可选）", newPerson.description, { rows: 2 })}<div class="persona-actions">${button("create", "创建", { primary: true })}${button("close-new", "取消")}</div></div>` : ""}<div class="persona-people">${people.length ? people.map((item) => `<button type="button" data-persona-action="select" data-id="${attr(item.id)}" class="persona-person ${item.id === selectedId ? "selected" : ""}" ${busy ? "disabled" : ""}><strong>${esc(item.name || "未命名人物")}</strong><small>${esc(item.description || "点击查看资料与对话")}</small></button>`).join("") : '<p class="persona-hint">创建第一个人物，加入他的资料。</p>'}</div></aside>
        <div class="persona-content">${person ? `<details class="persona-profile" ${d.profileOpen ? "open" : ""}><summary>${esc(person.name)} <span>编辑名称与简介</span></summary>${input("name", "人物名称", d.name)}${input("description", "简介", d.description, { rows: 2 })}<div class="persona-actions">${button("save-profile", "保存信息")}${button("delete", deleting ? "确认删除人物及本地资料" : "删除人物", { danger: true })}${deleting ? button("keep-person", "保留人物") : ""}</div></details>${person.card && Number.isInteger(person.cardSourceRevision) && person.cardSourceRevision !== person.sourceRevision ? '<p class="persona-notice">资料已更新，建议根据当前资料重新生成人物卡预览。</p>' : ""}<nav class="persona-tabs">${[["profile", "人物档案"], ["sources", "资料"], ["card", "人物卡"], ["chat", "对话"], ["versions", "版本"]].map(([key, title]) => `<button type="button" data-persona-action="tab" data-id="${key}" class="${d.tab === key ? "active" : ""}" ${busy ? "disabled" : ""}>${title}${key === "card" && d.preview ? ' <span class="persona-dot">待保存</span>' : ""}</button>`).join("")}</nav>${d.notice ? `<p class="persona-notice" role="status">${esc(d.notice)}</p>` : ""}${d.tab === "profile" ? renderProfile() : d.tab === "card" ? renderCard() : d.tab === "chat" ? renderChat() : d.tab === "versions" ? renderVersions() : renderSources()}` : '<div class="persona-empty">新建人物后，依次加入资料、确认人物卡，即可开始对话。</div>'}</div></div></section>`;
    }

    async function handleAction(action, id = "") {
      if (action === "cancel") { if (activeRequest) { try {
        if (activeRequest.kind === "outlook-login") { activeRequest.cancelled = true; await outlookService.disconnect(); await refreshOutlook(); }
        else await (activeRequest.kind === "outlook" ? outlookService : service).cancel(activeRequest.requestId);
        progress = "正在停止…"; updateLive();
      } catch (cause) { error = cause?.message || "停止失败"; rerender(); } } return; }
      if (action === "dismiss-error") { error = ""; rerender(); return; }
      if (busy || !service) return;
      const d = draft();
      if (action === "settings") { await openSettings?.(); return; }
      if (action === "new-person") { newPerson.open = true; rerender(); return; }
      if (action === "close-new") { newPerson.open = false; rerender(); return; }
      if (action === "create") {
        if (!newPerson.name.trim()) { error = "请填写人物名称。"; rerender(); return; }
        await run("正在创建人物…", async () => { accept(await service.create({ name: newPerson.name.trim(), description: newPerson.description.trim() })); newPerson = { open: false, name: "", description: "" }; picker = null; }); return;
      }
      if (action === "select") { await run("正在打开人物…", async () => { accept(await service.get(id)); picker = null; }); return; }
      if (!person) return;
      if (action === "reload-details") { await run("正在读取人物档案…", async () => { accept(await service.get(selectedId), { details: true }); }); return; }
      if (action === "assess-mbti") {
        try { d.profile.mbti = profileTools.assess(d.profile.answers).type; d.profile.mbtiMode = "assessment"; d.notice = "已计算观察倾向；保存档案后生效。"; error = ""; }
        catch (cause) { error = cause.message; }
        rerender(); return;
      }
      if (action === "save-details" || action === "save-details-generate") {
        if (d.preview) { error = "请先保存或放弃人物卡预览，再修改档案。"; rerender(); return; }
        let normalized;
        try { normalized = profileTools.normalize(d.profile); } catch (cause) { error = cause.message; rerender(); return; }
        await run("正在保存人物档案…", async (rid) => {
          accept(await service.updateProfile({ id: selectedId, profile: normalized, baseRevision: d.profileRevision }), { details: true });
          d.notice = "人物档案已保存，可用于生成和对话。建议重新生成人物卡以同步概览。";
          if (action === "save-details-generate") {
            const preview = await service.generate({ id: selectedId, requestId: rid });
            d.preview = { ...preview, card: { ...preview.card } }; d.tab = "card";
          }
        }, action === "save-details-generate" ? "generate" : ""); return;
      }
      if (action === "outlook-config") { outlookConfigOpen = !(outlookConfigOpen ?? !outlook?.configured); rerender(); return; }
      if (action === "outlook-refresh" && outlookService) { await run("正在检查 Outlook 连接…", async () => { await refreshOutlook({ syncConfig: true }); }); return; }
      if (action === "outlook-configure" && outlookService) {
        if (!outlookConfig.clientId.trim() || !outlookConfig.tenantId.trim()) { error = "请填写微软应用的客户端 ID 和目录（租户）ID。"; rerender(); return; }
        await run("正在连接 Outlook，请在微软登录页面完成登录…", async () => {
          await outlookService.configure({ clientId: outlookConfig.clientId.trim(), tenantId: outlookConfig.tenantId.trim() });
          await refreshOutlook({ syncConfig: true });
          if (activeRequest?.cancelled) throw new Error("已停止 Outlook 登录。");
          await outlookService.connect();
          await refreshOutlook();
          outlookConfigOpen = false;
          d.notice = "Outlook 已连接。输入人物邮箱即可导入邮件。";
        }, "outlook-login"); return;
      }
      if (action === "outlook-connect" && outlookService) {
        await run("正在连接 Outlook，请在微软登录页面完成登录…", async () => { await outlookService.connect(); await refreshOutlook(); d.notice = "Outlook 已连接。输入人物邮箱即可导入邮件。"; }, "outlook-login"); return;
      }
      if (action === "outlook-disconnect" && outlookService) {
        await run("正在退出 Outlook…", async () => { await outlookService.disconnect(); await refreshOutlook(); d.notice = "已退出 Outlook，本机已导入的资料和人物卡仍然保留。"; }); return;
      }
      if (action === "outlook-import" && outlookService) {
        if (d.preview) { d.tab = "card"; error = "请先保存或放弃现有人物卡预览。"; rerender(); return; }
        if (!outlook?.connected) { error = "请先连接 Outlook 账户。"; rerender(); return; }
        if (person.outlook?.accountId && person.outlook.accountId !== outlook.account?.id) { error = "请登录此人物原先关联的 Outlook 账户后更新。"; rerender(); return; }
        const email = (person.outlook?.email || d.outlookEmail).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { error = "请填写有效的人物邮箱，例如 name@company.com。"; rerender(); return; }
        let since = null;
        if (d.outlookRange === "saved") since = d.outlookSince;
        else if (d.outlookRange !== "all") {
          const start = new Date();
          if (d.outlookRange === "quarter") start.setUTCMonth(start.getUTCMonth() - 3); else start.setUTCFullYear(start.getUTCFullYear() - 1);
          since = start.toISOString();
        }
        const importId = selectedId, previousRevision = person.sourceRevision, previousImportedAt = person.outlook?.lastImportedAt;
        d.notice = "";
        await run("正在搜索并导入 Outlook 邮件…", async (rid) => {
          try {
            const result = await outlookService.importAndGenerate({ id: importId, email, since, requestId: rid });
            accept(result.persona);
            d.outlookEmail = result.persona.outlook?.email || email;
            d.outlookSince = result.persona.outlook?.since || "";
            d.outlookRange = d.outlookSince ? "saved" : "all";
            d.notice = outlookStats(result.stats);
            if (result.preview) { d.preview = { ...result.preview, card: { ...result.preview.card } }; d.tab = "card"; d.notice += "预览已生成，可以编辑后保存为新版本。"; }
            else d.notice += result.unchanged ? "邮件资料没有变化，当前人物卡可继续使用。" : "未生成新预览。请查看资料，或调整邮件时间范围后重试。";
          } catch (cause) {
            try {
              accept(await service.get(importId));
              if (person.outlook) { d.outlookEmail = person.outlook.email; d.outlookSince = person.outlook.since || ""; d.outlookRange = d.outlookSince ? "saved" : "all"; }
              if (person.sourceRevision !== previousRevision || person.outlook?.lastImportedAt !== previousImportedAt) d.notice = "邮件资料已保存在本机。修正问题后，可点击下方“生成人物卡预览”或“用资料更新人物卡”重试生成。";
            } catch (_) { /* Keep the original import error if reloading also fails. */ }
            throw cause;
          }
        }, "outlook"); return;
      }
      if (action === "tab") { if (id === "profile" && JSON.stringify(d.profile) === JSON.stringify(profileTools.normalize(person.profile))) d.profileRevision = person.sourceRevision; d.tab = id; error = ""; rerender(); return; }
      if (action === "keep-person") { deleting = false; rerender(); return; }
      if (action === "delete") {
        if (!deleting) { deleting = true; rerender(); return; }
        await run("正在删除人物…", async () => { const old = selectedId; await service.remove({ id: old }); people = people.filter((item) => item.id !== old); drafts.delete(old); selectedId = ""; person = null; picker = null; deleting = false; if (people.length) accept(await service.get(people[0].id)); }); return;
      }
      if (action === "save-profile") {
        if (!d.name.trim()) { error = "人物名称不能为空。"; rerender(); return; }
        await run("正在保存信息…", async () => { accept(await service.updateProfile({ id: selectedId, name: d.name.trim(), description: d.description.trim() }), { profile: true }); d.notice = "人物信息已保存。"; }); return;
      }
      if (["add-source", "import-files"].includes(action) && d.kind === "chat" && !d.speaker.trim()) { error = "导入聊天记录前，请填写目标说话人的姓名或昵称。"; rerender(); return; }
      if (action === "add-source") {
        if (!d.text.trim()) { error = "请先粘贴资料内容。"; rerender(); return; }
        await run("正在加入资料…", async () => { accept(await service.addSources({ id: selectedId, sources: [{ title: d.title.trim() || KINDS.find(([key]) => key === d.kind)?.[1], kind: d.kind, text: d.text, ...(d.kind === "chat" ? { speaker: d.speaker.trim() } : {}) }] })); d.title = ""; d.text = ""; d.notice = "资料已加入。生成人物卡预览后，确认保存。"; }); return;
      }
      if (action === "import-files") { await run("请选择需要导入的文件…", async () => { const result = await service.importFiles({ id: selectedId, kind: d.kind, speaker: d.kind === "chat" ? d.speaker.trim() : undefined }); if (result.canceled) return; accept(result.persona); d.notice = "文件已加入人物资料。"; if (result.errors?.length) error = result.errors.map((item) => typeof item === "string" ? item : `${item.name || item.path || "文件"}：${item.error || item.message || "导入失败"}`).join("；"); }); return; }
      if (action === "remove-source") { await run("正在移除资料…", async () => { accept(await service.removeSource({ id: selectedId, sourceId: id })); d.notice = "资料已移除。已有的人物卡内容不会自动改写，请重新生成并确认。"; }); return; }
      if (action === "pick-notes") { await run("正在读取笔记…", async () => { const result = await api.workspace.list(); picker = { root: result.root, files: flatten(result.tree), selected: new Set() }; }); return; }
      if (action === "close-picker") { picker = null; rerender(); return; }
      if (action === "import-notes") {
        if (!picker?.selected.size) { error = "请至少选择一篇笔记。"; rerender(); return; }
        await run("正在加入笔记…", async () => { const current = await api.workspace.list(); if (current.root !== picker.root) { picker = null; throw new Error("笔记库已切换，请重新选择笔记。"); } accept(await service.importNotes({ id: selectedId, root: picker.root, paths: [...picker.selected] })); picker = null; d.notice = "选中的笔记已作为独立资料加入。"; }); return;
      }
      if (action === "generate" || action === "correct") {
        if (d.preview) { d.tab = "card"; error = "请先保存或放弃现有人物卡预览。"; rerender(); return; }
        if (action === "correct" && !d.correction.trim()) { error = "请填写需要纠正或补充的内容。"; rerender(); return; }
        await run("正在整理人物卡…", async (rid) => { const correction = action === "correct" ? d.correction.trim() : undefined; const result = await service.generate({ id: selectedId, correction, requestId: rid }); d.preview = { ...result, card: { ...result.card }, correction }; d.tab = "card"; d.notice = "预览已生成。你可以编辑各项内容，再保存为新版本。"; }, "generate"); return;
      }
      if (action === "edit-card") { d.preview = { card: { ...person.card }, baseVersion: person.cardVersion, sourceRevision: person.sourceRevision }; rerender(); return; }
      if (action === "discard-preview") { d.preview = null; d.notice = "预览已放弃，已保存的人物卡保持不变。"; rerender(); return; }
      if (action === "save-card") { if (!d.preview) return; await run("正在保存人物卡…", async () => { accept(await service.saveCard({ id: selectedId, ...d.preview })); if (d.preview.correction) d.correction = ""; d.preview = null; d.notice = "人物卡已保存，可以开始对话。"; }); return; }
      if (action === "restore") { await run("正在恢复人物卡…", async () => { accept(await service.restoreCard({ id: selectedId, version: Number(id) })); d.tab = "card"; d.notice = "已恢复所选内容，并保留版本历史。"; }); return; }
      if (action === "keep-conversation") { d.deletingConversation = false; rerender(); return; }
      if (action === "delete-conversation") {
        if (!d.deletingConversation) { d.deletingConversation = true; rerender(); return; }
        await run("正在删除当前会话…", async () => { accept(await service.deleteConversation({ id: selectedId, conversationId: person.activeConversationId })); d.deletingConversation = false; d.notice = "当前会话已删除。"; }); return;
      }
      if (action === "new-conversation") { await run("正在新建会话…", async () => { accept(await service.newConversation({ id: selectedId })); d.deletingConversation = false; d.tab = "chat"; }); return; }
      if (action === "conversation") { if (!id) return; await run("正在切换会话…", async () => { accept(await service.selectConversation({ id: selectedId, conversationId: id })); d.deletingConversation = false; }); return; }
      if (action === "send") {
        const message = d.question.trim();
        if (!message || !person.card) return;
        pendingMessage = message; stream = "";
        await run("正在参考资料回答…", async (rid) => { const result = await service.chat({ id: selectedId, message, requestId: rid }); accept(result.persona); d.question = ""; d.notice = ""; }, "chat");
      }
    }
    function bind(nextScope) {
      scope = nextScope;
      const page = scope.querySelector(".persona-page");
      if (!page) return;
      const profile = page.querySelector(".persona-profile");
      if (profile) profile.ontoggle = () => { draft().profileOpen = profile.open; };
      page.querySelectorAll("[data-persona-action]").forEach((element) => { element.onclick = (event) => { event.preventDefault(); event.stopPropagation(); void handleAction(element.dataset.personaAction, element.dataset.id); }; });
      page.querySelectorAll("[data-persona-field]").forEach((element) => {
        const key = element.dataset.personaField;
        const change = () => {
          if (key === "conversation") { void handleAction("conversation", element.value); return; }
          if (key.startsWith("answer:")) { draft().profile.answers[Number(key.slice(7))] = element.value === "" ? null : Number(element.value); }
          else if (key.startsWith("profile:")) { draft().profile[key.slice(8)] = element.value; if (key === "profile:mbtiMode") rerender(); }
          else if (key.startsWith("new:")) newPerson[key.slice(4)] = element.value;
          else if (key.startsWith("outlook-config:")) outlookConfig[key.slice(15)] = element.value;
          else if (key.startsWith("card:")) { if (draft().preview) draft().preview.card[key.slice(5)] = element.value; }
          else draft()[key] = element.value;
          if (key === "kind") { const speaker = page.querySelector("[data-persona-speaker]"); if (speaker) speaker.hidden = element.value !== "chat"; }
        };
        if (element.tagName === "SELECT") element.onchange = change; else element.oninput = change;
        if (key === "question") element.onkeydown = (event) => {
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void handleAction("send"); }
        };
      });
      page.querySelectorAll("[data-persona-note]").forEach((element) => { element.onchange = () => { if (!picker) return; if (element.checked) picker.selected.add(element.dataset.personaNote); else picker.selected.delete(element.dataset.personaNote); }; });
    }
    return { load, render, bind, handleAction };
  }
  window.DMPersonaManager = { create };
})();
