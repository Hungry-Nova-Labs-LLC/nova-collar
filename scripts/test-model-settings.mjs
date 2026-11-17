import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRequestSettings, applyModelRequestSettings } from "../src/main/model-settings.js";
import { requestBudget } from "../src/main/request-budget.js";
const home = mkdtempSync(join(tmpdir(), "collar-model-settings-"));
after(() => rmSync(home, { recursive: true, force: true }));
const cfg = { home }, target = { url: "http://127.0.0.1:12000/v1", model: "fixture-model", local: true };
const entry = { ...target, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true };
const save = (profiles) => writeFileSync(join(home, "model-settings.json"), JSON.stringify({ version: 1, profiles }));
test("a profile preserves the selected context/output and reasoning without changing routes", () => {
  save([entry]);
  const selected = modelRequestSettings(cfg, target);
  assert.equal(selected.reasoning, true); assert.equal(selected.temperature, 0);
  assert.deepEqual(requestBudget(cfg, target), { contextTokens: 131072, outputTokens: 8192, lean: true });
  const body = { model: target.model };
  applyModelRequestSettings(body, selected);
  assert.deepEqual(body, { model: target.model, temperature: 0, chat_template_kwargs: { enable_thinking: true } });
});
test("profile matching requires both endpoint and upstream model", () => {
  save([entry]);
  for (const other of [{ ...target, model: "other" }, { ...target, url: "http://127.0.0.1:12001/v1" }]) assert.deepEqual(modelRequestSettings(cfg, other), {});
  assert.equal(modelRequestSettings(cfg, { ...target, url: target.url + "/" }).contextTokens, 131072);
});
test("invalid profiles fail closed and do not alter the legacy budget", () => {
  for (const patch of [{ contextTokens: -1 }, { outputTokens: Infinity }, { temperature: "0" }, { reasoning: "true" }, { reasoningEffort: "invalid" }, { url: "https://user:password@example.test/v1" }]) {
    save([{ ...entry, ...patch }]);
    assert.deepEqual(modelRequestSettings(cfg, target), {});
    assert.deepEqual(requestBudget(cfg, target), { contextTokens: 12288, outputTokens: 1536, lean: true });
  }
});
test("explicit request limits win, reply budget remains bounded and secrets are never returned", () => {
  save([{ ...entry, apiKey: "fixture-not-a-real-key", reasoning: false, reasoningEffort: "high" }]);
  const selected = modelRequestSettings(cfg, target);
  assert.equal(selected.apiKey, undefined);
  const budget = requestBudget(cfg, target, { ctx: 8192, predict: 65536 });
  assert.equal(budget.contextTokens, 8192); assert.equal(budget.outputTokens, 2048);
  const body = { temperature: 0.7 }; applyModelRequestSettings(body, selected);
  assert.equal(body.temperature, 0.7); assert.equal(body.chat_template_kwargs.enable_thinking, false); assert.equal(body.reasoning_effort, "high");
});
