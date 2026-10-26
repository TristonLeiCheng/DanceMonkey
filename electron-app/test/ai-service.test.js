const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function service(fetch, configStore = { read: () => ({ apiKey: "test-only", apiEndpoint: "http://localhost/v1", model: "test-model" }) }) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/ai.js"), "utf8"), {
    module, require: (name) => name === "./system-proxy" ? { fetchWithSystemProxy: fetch } : require(name),
    AbortController, TextDecoder, setTimeout, clearTimeout, Buffer,
  });
  return module.exports.createAiService(configStore);
}

test("AI service consumes a final SSE line and passes bounded generation options", async () => {
  let body;
  const ai = service(async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response('data: {"choices":[{"delta":{"content":"完整"}}]}\n\ndata: {"choices":[{"delta":{"content":"回答"}}]}', { headers: { "content-type": "text/event-stream" } });
  });
  const chunks = [];
  assert.equal(await ai.chat({ temperature: 0, maxTokens: 6000 }, (text) => chunks.push(text)), "完整回答");
  assert.deepEqual(chunks, ["完整", "回答"]);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 6000);
});

test("AI empty streams and provider error streams fail rather than creating a false success", async () => {
  for (const body of ['data: [DONE]\n\n', 'data: {"error":{"message":"quota exceeded"}}\n\n']) {
    const ai = service(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await assert.rejects(ai.chat({}), /有效文本|quota exceeded/);
  }
});

test("AI cancellation aborts the owned request and duplicate IDs cannot overwrite it", async () => {
  const ai = service((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })));
  }));
  const pending = ai.chat({ requestId: "same" });
  await assert.rejects(ai.chat({ requestId: "same" }), /重复/);
  assert.equal(ai.cancel("same"), true);
  await assert.rejects(pending, /停止/);
  assert.equal(ai.cancel("same"), false);
});

test("multi-call AI sessions keep the original provider when global settings change", async () => {
  let config = { apiKey: "fixture-a", apiEndpoint: "http://localhost:1111/v1", model: "model-a" };
  const calls = [];
  const ai = service(async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization, model: JSON.parse(options.body).model });
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  }, { read: () => config });
  const captured = ai.createSession();
  config = { apiKey: "fixture-b", apiEndpoint: "http://localhost:2222/v1", model: "model-b" };
  await captured.chat({}); await captured.chat({}); await ai.chat({});
  assert.equal(calls[0].url, "http://localhost:1111/v1/chat/completions");
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].model, "model-a");
  assert.equal(calls[2].model, "model-b");
  assert.notEqual(calls[2].authorization, calls[0].authorization);
});

test('AI and captured persona sessions use the latest network mode while keeping their provider snapshot',async()=>{
 let config={apiKey:'fixture',apiEndpoint:'http://localhost/v1',model:'fixture-model',aiNetworkMode:'system',petAnimal:'engineer-fox',petDisplaySize:128};
 const calls=[];const store={read:()=>config,write:patch=>(config={...config,...patch})};
 const ai=service(async(_url,_options,mode)=>{calls.push(mode);return Response.json({choices:[{message:{content:'ok'}}]});},store);
 const persona=ai.createSession();ai.saveSettings({apiEndpoint:config.apiEndpoint,apiKey:config.apiKey,model:config.model,aiNetworkMode:'direct'});
 await persona.chat({});await ai.chat({});assert.deepEqual(calls,['direct','direct']);assert.equal(config.petAnimal,'engineer-fox');assert.equal(config.petDisplaySize,128);
 ai.saveSettings({apiEndpoint:config.apiEndpoint,apiKey:config.apiKey,model:config.model});assert.equal(ai.getSettings().aiNetworkMode,'direct','older partial saves preserve network mode');
 config.aiNetworkMode='system';await persona.chat({});assert.equal(calls.at(-1),'system');
});
