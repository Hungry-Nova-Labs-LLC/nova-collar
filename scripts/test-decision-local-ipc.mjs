import assert from "node:assert/strict";
import test from "node:test";
import { registerDecisionLocalIpc } from "../src/main/decision-local-ipc.js";

function fixture() {
  const handlers = new Map(), calls = [], events = [];
  let finish;
  const status = { supported: true, stage: "not-installed", installed: false, enabled: false };
  const api = Object.fromEntries(["Status", "Cancel", "SetEnabled", "Defer", "Check"].map(name => [`decisionLocal${name}`, (...args) => {
    calls.push([name, ...args]); return { ...status };
  }]));
  api.decisionLocalInstall = () => { calls.push(["Install"]); return new Promise(resolve => { finish = resolve; }); };
  api.onDecisionLocalStatus = listener => { listener({ type: "decision-local", ...status }); return () => calls.push(["Unsubscribe"]); };
  const controls = registerDecisionLocalIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, fromWindow: event => event === "owned",
    api, send: event => events.push(event), openLicense: () => { calls.push(["License"]); return { ok: true }; } });
  const invoke = (name, input, sender = "owned") => handlers.get(`decision-local:${name}`)(sender, input);
  return { api, calls, events, controls, invoke, finish: () => finish() };
}

test("every local adviser action rejects an untrusted renderer before side effects", async () => {
  const f = fixture(); f.calls.length = 0;
  for (const action of ["status", "install", "cancel", "enabled", "defer", "check", "license"]) {
    assert.equal((await f.invoke(action, true, "foreign")).ok, false);
  }
  assert.deepEqual(f.calls, []);
});

test("install returns promptly, deduplicates clicks and permits another attempt after settling", async () => {
  const f = fixture();
  assert.equal((await f.invoke("install")).stage, "not-installed");
  assert.equal(f.controls.installationPending(), true);
  await f.invoke("install");
  assert.equal(f.calls.filter(([name]) => name === "Install").length, 1);
  f.finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controls.installationPending(), false);
  await f.invoke("install");
  assert.equal(f.calls.filter(([name]) => name === "Install").length, 2);
  f.finish();
});

test("enabled accepts only an explicit boolean and renderer data cannot choose paths or URLs", async () => {
  const f = fixture();
  for (const value of ["true", 1, null, {}, { enabled: true, endpoint: "https://fixture.invalid", path: "/tmp/fixture" }]) {
    assert.equal((await f.invoke("enabled", value)).ok, false);
  }
  await f.invoke("enabled", true); await f.invoke("enabled", false);
  assert.deepEqual(f.calls.filter(([name]) => name === "SetEnabled"), [["SetEnabled", true], ["SetEnabled", false]]);
  await f.invoke("license", { path: "/tmp/fixture" });
  assert.deepEqual(f.calls.find(([name]) => name === "License"), ["License"]);
  await f.invoke("cancel"); await f.invoke("defer"); await f.invoke("check");
  assert(f.calls.some(([name]) => name === "Check"));
  f.controls.unsubscribe(); assert(f.calls.some(([name]) => name === "Unsubscribe"));
});

test("an async status survives action failure and raw errors stay private", async () => {
  const f = fixture();
  f.api.decisionLocalStatus = async () => ({ supported: true, installed: true, enabled: false, stage: "ready" });
  f.api.decisionLocalCheck = async () => { throw Error("synthetic-private-key-and-path"); };
  const result = await f.invoke("check");
  assert.equal(result.installed, true); assert.equal(result.stage, "error");
  assert.equal(result.errorCode, "unavailable");
  assert(!JSON.stringify(result).includes("synthetic-private"));
});

test("cancel acknowledgement releases the install slot before an immediate retry", async () => {
  const f = fixture();
  await f.invoke("install");
  f.api.decisionLocalCancel = async () => { f.finish(); return { stage: "cancelled" }; };
  assert.equal((await f.invoke("cancel")).stage, "cancelled");
  assert.equal(f.controls.installationPending(), false);
  await f.invoke("install");
  assert.equal(f.calls.filter(([name]) => name === "Install").length, 2);
  f.finish();
});
