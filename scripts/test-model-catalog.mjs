import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catalogModels, getCatalog, refreshCatalog } from "../src/main/model-catalog.js";

const chatIds = ["Nova-Qwen27B", "Nova-Mean", "Nova-Roan", "Nova-Fast:Gemma4", "Nova-Pocket:MemoryLab", "qwen2.5-coder:1.5b-base", "nova-heavy", "Nova-Scrapper"];
const mixedInventory = () => ({ data: [
  ...chatIds.map(id => ({ id, tool_call: !["Nova-Scrapper", "qwen2.5-coder:1.5b-base"].includes(id), limit: { context: 32768, output: 2048 } })),
  { id: "embeddinggemma-2", type: "embedding", modalities: ["text", "image", "audio", "video"], dimensions: [128, 256, 512, 768], description: "Synthetic embedding-only inventory row." },
] });

test("mixed gateway discovery keeps every chat ID and omits embedding-only models", () => {
  const models = catalogModels(mixedInventory());
  assert.deepEqual(models.map(model => model.id), chatIds);
  assert.equal(models.find(model => model.id === "Nova-Scrapper").tools, false);
  assert.equal(models.find(model => model.id === "qwen2.5-coder:1.5b-base").tools, false);
  assert.ok(models.some(model => model.id === "nova-heavy"));
});

test("explicit embedding metadata is honored without confusing input modality or no-tools with chat support", () => {
  const models = catalogModels({ data: [
    { id: "plain-chat", tool_call: false, modalities: ["text"] },
    { id: "dual-chat", type: "chat", capabilities: { chat: true, embeddings: true } },
    { id: "vector-type", type: "embedding", modalities: ["text", "image"] },
    { id: "vector-kind", kind: "embeddings" },
    { id: "vector-task", task: "feature_extraction" },
    { id: "vector-capabilities", capabilities: { chat: false, embeddings: true } },
  ] });
  assert.deepEqual(models.map(model => model.id), ["plain-chat", "dual-chat"]);
});

test("older caches that stripped model type cannot reintroduce EmbeddingGemma into chat choices", () => {
  const home = mkdtempSync(join(tmpdir(), "collar-catalog-cache-"));
  try {
    const cfg = { home, chatUrl: "https://models.example/v1", chatKey: "synthetic-catalog-key", toolsKey: "" };
    const scope = createHash("sha256").update(JSON.stringify([cfg.chatUrl, cfg.chatKey])).digest("hex");
    const saved = { scope, updatedAt: Date.now(), models: [
      ...chatIds.map(id => ({ id, label: id, tools: id !== "Nova-Scrapper" })),
      { id: "embeddinggemma-2", label: "EmbeddingGemma 2", description: "An old cache without type metadata." },
    ] };
    writeFileSync(join(home, "model-catalog.json"), JSON.stringify(saved));
    assert.deepEqual(getCatalog(cfg).models.map(model => model.id), chatIds);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("fresh catalog persistence and restart retain only chat models without persisting the credential", async () => {
  const home = mkdtempSync(join(tmpdir(), "collar-catalog-refresh-"));
  const previousFetch = globalThis.fetch;
  try {
    const cfg = { home, chatUrl: "https://models.example/v1", chatKey: "synthetic-catalog-key", toolsKey: "" };
    globalThis.fetch = async (url, init) => {
      assert.equal(url, cfg.chatUrl + "/models");
      assert.equal(init.redirect, "error");
      return Response.json(mixedInventory());
    };
    assert.deepEqual((await refreshCatalog(cfg, { force: true })).models.map(model => model.id), chatIds);
    const stored = readFileSync(join(home, "model-catalog.json"), "utf8");
    assert.ok(!stored.includes("embeddinggemma-2"));
    assert.ok(!stored.includes(cfg.chatKey));
    const restarted = await import("../src/main/model-catalog.js?chat-catalog-restart");
    assert.deepEqual(restarted.getCatalog(cfg).models.map(model => model.id), chatIds);
  } finally { globalThis.fetch = previousFetch; rmSync(home, { recursive: true, force: true }); }
});

test("saved embedding-only lane IDs stay out of actual configuration choices without changing saved selections", () => {
  const home = mkdtempSync(join(tmpdir(), "collar-catalog-profile-"));
  try {
    const env = "HNL_CHAT_URL=https://models.example/v1\nHNL_MODEL=nova-heavy\nHNL_CHAT_KEY=synthetic-profile-key\nHNL_FAST_MODEL=embeddinggemma-2\nHNL_THINK_MODEL=embeddinggemma-2\n";
    writeFileSync(join(home, "env"), env, { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {join} from 'node:path';
      const {APP_HOME,loadConfig,publicState}=await import('./src/main/config.js');
      assert.equal(APP_HOME,process.env.NOVAPUP_HOME);
      const before=readFileSync(join(APP_HOME,'env'),'utf8');
      const cfg=loadConfig();
      assert.equal(cfg.model,'nova-heavy');
      assert.equal(cfg.fastModel,'embeddinggemma-2');
      assert.equal(cfg.thinkModel,'embeddinggemma-2');
      const state=publicState(cfg);
      assert.equal(state.model,'nova-heavy');
      assert.ok(state.models.some(row=>row.id==='nova-heavy'));
      assert.ok(!state.models.some(row=>row.id==='embeddinggemma-2'));
      const embeddingSelection={...cfg,model:'embeddinggemma-2'};
      assert.equal(publicState(embeddingSelection).model,'embeddinggemma-2');
      assert.ok(!publicState(embeddingSelection).models.some(row=>row.id==='embeddinggemma-2'));
      assert.equal(embeddingSelection.model,'embeddinggemma-2');
      assert.equal(readFileSync(join(APP_HOME,'env'),'utf8'),before);
      process.stdout.write(JSON.stringify({ok:true}));
    `], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 20000,
      env: { ...process.env, NOVAPUP_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || "Isolated configuration fixture failed");
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    assert.equal(readFileSync(join(home, "env"), "utf8"), env);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
