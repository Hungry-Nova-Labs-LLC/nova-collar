// Actual renderer, production preload and production IPC bridge. Provider,
// download and model runtime are synthetic; storage belongs only to this test.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!process.versions.electron) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(?:HNL_|NOVA_|NP_|NOVAPUP_|APPLE_|CSC_|OPENAI_|SSH_)/.test(key) || /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = createRequire(import.meta.url)("electron");
  const ownedHome = mkdtempSync(join(tmpdir(), "nova-decision-ui-"));
  env.NOVA_DECISION_UI_HOME = ownedHome;
  const child = spawn(executable, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {cwd: root, env, stdio: "inherit"});
  const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
  await new Promise(resolve => child.once("exit", (code, signal) => {clearTimeout(timer); process.exitCode = signal ? 1 : code ?? 1; resolve();}));
  rmSync(ownedHome, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
} else {
  void (async () => {
  const {app, BrowserWindow, ipcMain} = await import("electron");
  const {registerDecisionLocalIpc} = await import("../src/main/decision-local-ipc.js");
  const home = process.env.NOVA_DECISION_UI_HOME;
  assert(home && home.startsWith(join(tmpdir(), "nova-decision-ui-")), "UI fixture requires its isolated launcher profile");
  app.setPath("userData", join(home, "electron"));
  app.setPath("sessionData", join(home, "electron"));
  globalThis.fetch = async () => {throw new Error("Network disabled in UI fixture");};
  let win, listener, stopInstall, enabledCalls = 0, checkCalls = 0, installCalls = 0, cancelCalls = 0, licenseCalls = 0, licenseOK = true;
  let local = {supported: true, stage: "not-installed", installed: false, enabled: false, firstRunPrompted: false};
  let state = {ready: false, setupDone: false, hasExplicitConnection: false, model: "", os: process.platform,
    models: [], packs: [], workdir: "/synthetic/project", session: {current: "fixture", chats: []}, messages: [],
    setupReport: {found: [{name: "Fixture server", url: "http://127.0.0.1:1234/v1", models: ["fixture-chat"]}], decision: {mode: "choose"}},
    conversation: {active: false, paused: false, pending: [], question: null}};
  const safeCopy = value => JSON.parse(JSON.stringify(value));
  const emit = patch => {local = {...local, ...patch}; listener?.({type: "decision-local", ...safeCopy(local)});};
  const api = {
    decisionLocalStatus: () => safeCopy(local),
    decisionLocalInstall: async () => {
      installCalls++; emit({stage: "downloading", firstRunPrompted: true, progress: {receivedBytes: 923120592, totalBytes: 1846241184}});
      await new Promise(resolve => {stopInstall = resolve;});
      return safeCopy(local);
    },
    decisionLocalCancel: async () => {cancelCalls++; emit({stage: "cancelled", enabled: false}); await delay(60); stopInstall?.(); return safeCopy(local);},
    decisionLocalSetEnabled: enabled => {enabledCalls++; emit({enabled, stage: "ready"}); return safeCopy(local);},
    decisionLocalDefer: () => {local.firstRunPrompted = true; return safeCopy(local);},
    decisionLocalCheck: () => {checkCalls++; emit({stage: "ready"}); return safeCopy(local);},
    onDecisionLocalStatus: fn => {listener = fn; return () => {listener = null;};},
  };
  let phase = "startup";
  const deadline = setTimeout(() => {console.error(`Decision setup UI timed out during ${phase}`); app.exit(1);}, 35_000);
  try {
    await app.whenReady();
    win = new BrowserWindow({width: 1060, height: 820, show: false,
      webPreferences: {preload: join(root, "src/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false}});
    const errors = [];
    win.webContents.on("console-message", details => {if (details.level === "error") errors.push(details.message);});
    const send = event => win.webContents.send("pup", event);
    registerDecisionLocalIpc({ipcMain, fromWindow: event => event.sender === win.webContents, api, send, openLicense: () => {licenseCalls++; return {ok: licenseOK};}});
    ipcMain.handle("state", () => safeCopy(state));
    ipcMain.handle("setup:use", (_event, pick) => {
      assert.equal(pick.model, "fixture-chat");
      state = {...state, ready: true, setupDone: true, hasExplicitConnection: true, model: pick.model, models: [{id: pick.model, label: pick.model}]};
      return {ok: true, state: safeCopy(state)};
    });
    ipcMain.handle("voice:read", () => ({text: "Fixture voice"}));
    ipcMain.handle("spec:read", () => ({text: ""}));
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (predicate, label) => {for (let n = 0; n < 150; n++) {if (await predicate()) return; await delay(20);} throw new Error(`UI did not reach ${label}`);};
    const click = async label => {const result = await js(`(()=>{const buttons=Array.from(document.querySelectorAll('#decision-setup-acts button'));const b=buttons.find(b=>b.textContent===${JSON.stringify(label)});if(!b)return buttons.map(x=>x.textContent);b.click();return true})()`);assert.equal(result,true,`Expected button ${label}; found ${JSON.stringify(result)}`);};
    const load = () => win.loadFile(join(root, "src/renderer/index.html"));
    phase = "primary connection precedes adviser";
    await load();
    await until(() => js('!document.getElementById("setup").hidden && document.querySelectorAll("#setup-list button").length===1'), "primary model choice");
    assert.equal(await js('document.getElementById("decision-setup").hidden'), true);
    await js('document.querySelector("#setup-list button").click()');
    await until(() => js('!document.getElementById("decision-setup").hidden'), "post-connection adviser offer");
    assert.equal(await js('document.getElementById("setup").hidden'), true);
    assert.equal(await js('document.getElementById("creature").inert'), true);
    assert.match(await js('document.getElementById("model-btn").textContent'), /fixture-chat/);
    assert.match(await js('document.getElementById("decision-setup-detail").textContent'), /1\.85 GB/);
    assert.match(await js('document.querySelector(".decision-license").textContent'), /\$10M/);
    phase = "license and deferral";
    await js('document.getElementById("decision-local-license").click()');
    await until(() => licenseCalls === 1, "local license opening");
    licenseOK = false;
    await js('document.getElementById("decision-local-license").click()');
    await until(() => js('document.getElementById("decision-setup-status").textContent.includes("license could not be opened")'), "safe resolved license failure");
    licenseOK = true;
    await click("Maybe later");
    await until(() => local.firstRunPrompted, "persistent deferral");
    assert.equal(await js('document.getElementById("creature").inert'), false);
    await load();
    await until(() => js('document.getElementById("model-btn").textContent.includes("fixture-chat")'), "saved primary connection");
    await delay(60);
    assert.equal(await js('document.getElementById("decision-setup").hidden'), true);
    phase = "Settings re-entry";
    await js('document.getElementById("settings-btn").click();document.getElementById("decision-local-open").click()');
    await until(() => js('!document.getElementById("decision-setup").hidden'), "Settings re-entry");
    phase = "install button";
    await click("Install free local adviser");
    await until(() => js('document.getElementById("decision-progress-text").textContent.startsWith("50%")'), "byte-based download progress");
    assert.equal(installCalls, 1); assert.equal(enabledCalls, 0); assert.equal(checkCalls, 0);
    phase = "cancel button";
    await click("Cancel installation");
    await until(() => js('document.getElementById("decision-setup-status").textContent.includes("cancelled")'), "cancellation");
    assert.equal(cancelCalls, 1);
    assert.equal(await js('Array.from(document.querySelectorAll("#decision-setup-acts button")).find(b=>b.textContent==="Retry installation").disabled'), true, "retry stays disabled until cancellation settles");
    await until(() => js('!Array.from(document.querySelectorAll("#decision-setup-acts button")).find(b=>b.textContent==="Retry installation").disabled'), "cancellation settled before retry");
    phase = "retry button";
    await click("Retry installation");
    await until(() => installCalls === 2, "explicit retry");
    for (const stage of ["verifying", "starting", "checking"]) {
      emit({stage});
      await until(() => js(`document.getElementById('decision-setup').dataset.stage===${JSON.stringify(stage)}`), stage);
      assert.equal(await js('document.getElementById("decision-progress").hasAttribute("value")'), false);
    }
    emit({installed: true, enabled: true, stage: "ready"}); stopInstall?.();
    await until(() => js('document.getElementById("decision-setup-title").textContent.includes("is on")'), "backend-qualified installation");
    assert.equal(enabledCalls, 0, "renderer must not race backend install orchestration");
    assert.equal(checkCalls, 0, "renderer must not duplicate install's backend self-check");
    phase = "enable/disable and installed local check";
    await click("Turn off local adviser");
    await until(() => !local.enabled && enabledCalls === 1, "local adviser off");
    assert.equal(local.installed, true);
    await click("Check local adviser");
    await until(() => checkCalls === 1, "explicit local check");
    await click("Enable local adviser");
    await until(() => local.enabled && enabledCalls === 2, "local adviser on");
    assert.equal(installCalls, 2, "reenabling must retain the installed download");
    await click("Done");
    phase = "auto-connected return and active work";
    local = {...local, installed: false, enabled: false, stage: "not-installed", firstRunPrompted: false};
    state = {...state, setupReport: {found: [], decision: {mode: "saved"}}, conversation: {...state.conversation, active: true}};
    await load(); await delay(150);
    assert.equal(await js('document.getElementById("decision-setup").hidden'), true, "active work must not be interrupted");
    state.conversation.active = false;
    await js('document.getElementById("input").value="unfinished draft"');
    await js(`window.maybeOfferDecisionSetup(${JSON.stringify(state)})`);
    assert.equal(await js('document.getElementById("decision-setup").hidden'), true, "draft must not be interrupted");
    await js('document.getElementById("input").value=""');
    await js(`window.maybeOfferDecisionSetup(${JSON.stringify(state)})`);
    await until(() => js('!document.getElementById("decision-setup").hidden'), "saved or auto-connected provider offer");
    assert.equal(state.model, "fixture-chat");
    const screenshot = process.argv.find(value => value.startsWith("--screenshot="))?.slice(13);
    if (screenshot) {await delay(200); writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());}
    phase = "safe errors and compact layout";
    emit({stage: "error", reason: "hash-mismatch", error: "PRIVATE_ENDPOINT_AND_PROFILE_DETAILS<img src=x>"});
    await until(() => js('document.getElementById("decision-setup-status").textContent.includes("verification")'), "safe actionable error");
    assert.equal(await js('document.getElementById("decision-setup").textContent.includes("PRIVATE_ENDPOINT")'), false);
    win.setSize(390, 740);
    await delay(100);
    assert.equal(await js('document.getElementById("decision-setup").scrollWidth<=document.getElementById("decision-setup").clientWidth'), true);
    assert.equal(await js('document.querySelectorAll("#decision-setup input[type=checkbox]").length'), 0, "license is a notice, not an artificial EULA gate");
    assert.deepEqual(errors, []);
    console.log("PASS decision setup: production renderer/preload/IPC, primary-first offer, deferral, Settings, byte progress, cancel/retry, backend stage orchestration, toggles, safe errors, and compact layout; zero downloads/model requests");
  } catch (error) {console.error(`Decision setup UI failure during ${phase}:`, error); process.exitCode = 1;}
  finally {clearTimeout(deadline); stopInstall?.(); win?.destroy(); app.exit(process.exitCode || 0);}
  })();
}
