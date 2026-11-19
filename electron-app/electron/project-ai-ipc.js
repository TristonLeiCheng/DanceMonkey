const path = require("node:path");
const projectAi = require("./project-ai");
const model = require("../src/zen-model");

const ORIGIN_ERROR = "此操作只能从 DM 主窗口发起。";

/**
 * Registers every `projectAi:*` channel. Each handler first checks that the request comes from the
 * main frame of a trusted DM window; note windows share the preload script but must not reach these
 * channels, several of which write tasks, projects or notes.
 *
 * Stores change when the vault switches, so they are passed as getters.
 */
function registerProjectAiIpc({ ipcMain, trusted, getGeneration, assertWritable, aiService, personaService,
  getWorkspace, getZenStore, getChatStore, getNoteChatStore, listNotes, refreshQuickNotes = () => {},
  getDesktopPet = () => null, localDay = () => model.localDate(new Date()) }) {
  const channels = [];

  function assertOrigin(event) {
    if (!trusted(event) || !event?.sender || event.senderFrame !== event.sender.mainFrame) throw new Error(ORIGIN_ERROR);
  }
  function assertContext(event, generation) {
    assertOrigin(event);
    if (generation !== getGeneration()) throw new Error("笔记库已变化，请重新选择引用笔记后提问。");
  }
  const handle = (channel, fn) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args) => {
      assertOrigin(event);
      return fn(event, ...args);
    });
  };
  const stream = (event, requestId) => (chunk) => {
    if (!event.sender.isDestroyed()) event.sender.send("ai:chunk", { requestId, chunk });
  };
  const reconcile = () => getNoteChatStore()?.reconcile(getWorkspace());

  handle("projectAi:history:get", (_event, projectId) => {
    reconcile();
    return getChatStore().get(getWorkspace().root, projectId);
  });
  handle("projectAi:history:set", (_event, projectId, messages) => {
    reconcile();
    return getChatStore().set(getWorkspace().root, projectId, messages);
  });
  handle("projectAi:listNotes", (event, payload = {}) => {
    assertContext(event, payload.generation);
    reconcile();
    const workspace = getWorkspace();
    const moveVersion = getNoteChatStore().moveVersion(workspace.root);
    return listNotes(workspace, payload).map((item) => ({ ...item, moveVersion }));
  });
  handle("projectAi:resolveReferences", (event, payload = {}) => {
    assertContext(event, payload.generation);
    reconcile();
    const root = getWorkspace().root;
    if (payload.projectId) getChatStore().get(root, payload.projectId);
    return getChatStore().resolveReferences(root, payload.references);
  });
  // Project data is read here from the active vault; the renderer only names the project.
  handle("projectAi:chat", async (event, payload = {}) => {
    const requestId = payload.requestId;
    let unlockReferences;
    try {
      assertContext(event, payload.generation);
      reconcile();
      const workspace = getWorkspace();
      const chatStore = getChatStore();
      const selected = chatStore.resolveReferences(workspace.root, payload.referenceItems || (payload.references || []).map((file) => ({ path: file, title: path.posix.basename(file, ".md") })));
      const request = projectAi.buildProjectChatRequest(workspace, getZenStore().load(), { ...payload,
        references: selected.map((item) => item.path), messages: chatStore.resolveMessages(workspace.root, payload.messages) });
      request.sources = chatStore.resolveReferences(workspace.root, request.sources);
      unlockReferences = getNoteChatStore().lock(workspace.root, request.sources.map((source) => source.path));
      if (!event.sender.isDestroyed()) event.sender.send("ai:chunk", { requestId, sources: request.sources });
      const text = await aiService.chat({ requestId, model: payload.model, systemPrompt: request.systemPrompt, messages: request.messages }, stream(event, requestId));
      assertContext(event, payload.generation);
      // Validate against the latest data: tasks may have changed while the reply streamed.
      const extracted = request.readOnly ? { display: projectAi.splitActions(text).display, actions: [], dropped: 0 } : projectAi.extractActions(text, getZenStore().load(), payload.projectId);
      return { success: true, text: extracted.display || text, actions: extracted.actions, droppedActions: extracted.dropped, context: request.context, sources: request.sources };
    } catch (error) {
      return { success: false, error: error?.message || "AI 请求失败" };
    } finally {
      unlockReferences?.();
    }
  });
  handle("projectAi:applyAction", (_event, projectId, action, generation) => {
    assertWritable(generation);
    return projectAi.applyAction(getZenStore(), projectId, action);
  });
  handle("projectAi:undoAction", (_event, projectId, undo, generation) => {
    assertWritable(generation);
    return projectAi.undoAction(getZenStore(), projectId, undo);
  });
  handle("projectAi:plan", async (_event, payload = {}) => {
    try {
      const request = projectAi.buildPlanRequest(getZenStore().load(), payload.projectId, { notes: payload.notes });
      const text = await aiService.chat({ requestId: payload.requestId, model: payload.model, systemPrompt: request.systemPrompt,
        messages: request.messages, temperature: 0.4, maxTokens: 4000 });
      return { success: true, plan: projectAi.parsePlan(text, getZenStore().load(), payload.projectId) };
    } catch (error) {
      return { success: false, error: error?.message || "AI 拆解计划失败" };
    }
  });
  handle("projectAi:applyPlan", (_event, projectId, plan, generation) => {
    assertWritable(generation);
    return projectAi.applyPlan(getZenStore(), projectId, plan);
  });
  handle("projectAi:saveNote", (_event, input = {}, generation) => {
    assertWritable(generation);
    const zen = getZenStore();
    const state = zen.load();
    const project = input.projectId ? state.projects.find((entry) => (entry.Id ?? entry.id) === input.projectId) : null;
    const note = getWorkspace().createAiNote({ title: input.title, body: input.body, sources: input.sources, kind: input.kind === "digest" ? "digest" : "insight", project: project ? project.Name ?? project.name : "" });
    refreshQuickNotes();
    if (!project || project.ArchivedAt) return { path: note.path, linked: false, state };
    const linked = [...new Set([...(project.LinkedNotes || []), note.path])];
    return { path: note.path, linked: true, state: zen.updateProject(input.projectId, { linkedNotes: linked }) };
  });
  handle("projectAi:cancel", (_event, requestId) => aiService.cancel(requestId) || personaService.cancel(requestId));
  handle("projectAi:extractNoteTasks", async (_event, payload = {}) => {
    try {
      return { success: true, ...await projectAi.extractNoteTasks(aiService, getZenStore().load(), payload) };
    } catch (error) {
      return { success: false, error: error?.message || "AI 提取失败" };
    }
  });
  handle("projectAi:personaReview", async (event, payload = {}) => {
    const requestId = payload.requestId;
    try {
      const state = getZenStore().load();
      const project = state.projects.find((entry) => (entry.Id ?? entry.id) === payload.projectId);
      if (!project) throw new Error("项目不存在，可能已被删除或笔记库已切换。");
      const context = projectAi.buildProjectContext(state, payload.projectId, { include: { tasks: true, milestones: true, updates: true, notes: false }, maxChars: 9000, withIds: false });
      const result = await personaService.review({ id: payload.personaId, subject: `项目：${project.Name ?? project.name}`.slice(0, 200),
        material: context.text, focus: String(payload.focus || "").slice(0, 500), requestId }, stream(event, requestId));
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error?.message || "人物审阅失败" };
    }
  });
  handle("projectAi:brief:get", () => getChatStore().getBrief(getWorkspace().root, localDay()));
  handle("projectAi:brief", async (event, payload = {}) => {
    const requestId = payload.requestId;
    const root = getWorkspace().root;
    try {
      const request = projectAi.buildBriefRequest(getZenStore().load());
      const text = await aiService.chat({ requestId, model: payload.model, systemPrompt: request.systemPrompt, messages: request.messages, temperature: 0.4, maxTokens: 1200 }, stream(event, requestId));
      const brief = { date: localDay(), text: text.trim(), generatedAt: new Date().toISOString() };
      if (root === getWorkspace().root) getChatStore().setBrief(root, brief);
      const headline = projectAi.briefHeadline(brief.text);
      const petNotified = Boolean(headline && getDesktopPet()?.announce?.(`今日简报：${headline}`, { section: "projects" }));
      return { success: true, brief, counts: request.counts, petNotified };
    } catch (error) {
      return { success: false, error: error?.message || "生成简报失败" };
    }
  });
  handle("projectAi:draftUpdate", async (_event, payload = {}) => {
    try {
      const request = projectAi.buildWeeklyDraftRequest(getZenStore().load(), payload.projectId, { notes: payload.notes });
      const text = await aiService.chat({ requestId: payload.requestId, model: payload.model, systemPrompt: request.systemPrompt,
        messages: request.messages, temperature: 0.3, maxTokens: 1500 });
      return { success: true, draft: projectAi.parseWeeklyDraft(text), counts: request.counts };
    } catch (error) {
      return { success: false, error: error?.message || "AI 起草失败" };
    }
  });

  return { channels };
}

module.exports = { registerProjectAiIpc, ORIGIN_ERROR };
