// Real renderer; synthetic conversations and local IPC only. No provider,
// credentials, personal sessions or shell commands participate in this check.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "collar-workspace-ui-"));
app.setPath("userData", join(home, "electron"));
app.setPath("sessionData", join(home, "electron"));
globalThis.fetch = async () => { throw new Error("Network is disabled in this UI fixture."); };
let phase = "Electron startup";
const deadline = setTimeout(() => { console.error(`Workspace check timed out during ${phase}`); app.exit(1); }, 30_000);
const rows = [
  { id: "workspace", title: "Nova Collar workspace", updated: Date.now() },
  { id: "research", title: "Research notes", updated: Date.now() - 86_400_000 },
  { id: "review", title: "Review a change", updated: Date.now() - 172_800_000 },
];
let current = "workspace", workdir = "/workspace/nova-collar", win;
let recoveryRestores = 0;
const messages = {
  workspace: [
    { role: "user", content: "Build a clearer workspace for Nova Collar." },
    { role: "assistant", content: "Your work stays in one place. Saved chats, the terminal and agents are always within reach.\n\n### One place to work\n\n- **Saved chats** stay in the sidebar.\n- **Working folder** is visible before you send a request.\n- **Context** opens the request inspector.\n- **Terminal** keeps its existing dock and resize controls.\n\nThis is a layout preview with sample conversations. No model request is running." },
  ],
  research: [{ role: "assistant", content: "Research conversation fixture." }],
  review: [{ role: "assistant", content: "Review conversation fixture." }],
};
const state = () => ({ ready: true, setupDone: true, os: process.platform,
  model: "preview", models: [{ id: "preview", label: "UI preview · no model" }], packs: [],
  workdir, messages: messages[current] || [], session: { current, chats: rows },
  conversation: { active: false, paused: false, pending: [], question: null } });
const handlers = {
  state,
  openChat: (id) => { current = id; return state(); },
  newChat: () => { current = "new"; rows.unshift({ id: current, title: "New chat", updated: Date.now() }); return state(); },
  specRead: () => ({ text: "" }),
  readVoice: () => ({ text: "Preview voice" }),
  contextInfo: () => ({ ok: true, snapshot: null }),
  refreshModels: state,
  pickWorkdir: () => ({ ok: true, path: workdir = "/workspace/another-project" }),
  pin: () => true,
  stop: () => ({ ok: true }),
  recoveryPoints: () => ({ ok: true, points: [{ id: "synthetic-point", createdAt: new Date().toISOString(), request: "<img src=x> synthetic local boundary", verification: "recorded-checks-passed", available: true }] }),
  recoveryOperations: () => ({ ok: true, operations: [] }),
  recoverPoint: id => {
    assert.equal(id, "synthetic-point"); recoveryRestores++;
    if (recoveryRestores === 1) return { ok: false, error: "Synthetic later-owner-edit conflict. No files changed." };
    current = "recovered"; rows.unshift({ id: current, title: "Recovered fixture", updated: Date.now() });
    messages.recovered = [{ role: "assistant", content: "Recovered fixture branch. Fresh verification is required." }];
    return { ...state(), ok: true, recovery: { verification: "requires-fresh-checks" } };
  },
  acknowledgeRecovery: () => ({ ok: true, recoverySucceeded: false }),
};
const until = async (fn) => {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await delay(30); }
  throw new Error("Workspace UI did not reach the expected state.");
};
async function main() {
try {
  await app.whenReady();
  phase = "renderer load";
  ipcMain.handle("workspace-fixture", (_event, name, ...args) => {
    if (!handlers[name]) throw new Error(`Unsupported preview action: ${name}`);
    return handlers[name](...args);
  });
  const preload = join(home, "preload.cjs");
  writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');const api={os:process.platform,on:fn=>{const listener=(_event,value)=>fn(value);ipcRenderer.on('workspace-event',listener);return()=>ipcRenderer.removeListener('workspace-event',listener)},termWrite:()=>{},termResize:()=>{},min:()=>{},quit:()=>{}};for(const name of ${JSON.stringify(Object.keys(handlers))})api[name]=(...args)=>ipcRenderer.invoke('workspace-fixture',name,...args);contextBridge.exposeInMainWorld('pup',api);`);
  win = new BrowserWindow({ width: 1280, height: 860, show: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (_event, details) => { if (details.level === "error") errors.push(details.message); });
  await win.loadFile(join(root, "src/renderer/index.html"));
  phase = "initial workspace state";
  const js = (s) => win.webContents.executeJavaScript(s);
  await until(() => js('document.querySelectorAll(".workspace-session").length===3'));
  await js('localStorage.setItem("np-home","off")');
  await win.loadFile(join(root, "src/renderer/index.html"));
  await until(() => js('document.querySelectorAll(".workspace-session").length===3'));
  assert.equal(await js('document.getElementById("creature").dataset.home'), "on");
  assert.equal(await js('getComputedStyle(document.getElementById("home-bar")).display'), "flex");
  phase = "navigation checks";
  assert.equal(await js('document.querySelectorAll(".ears").length'), 0);
  assert.equal(await js('document.getElementById("workspace-chat-title").textContent'), rows[0].title);
  assert.equal(await js('document.getElementById("workspace-folder").textContent'), workdir);
  assert.equal(await js('getComputedStyle(document.getElementById("chat")).fontSize'), "15px");
  await js('document.querySelectorAll(".workspace-session")[1].click()');
  await until(() => js('document.getElementById("chat").textContent.includes("Research conversation fixture")'));
  assert.equal(current, "research");
  await js('document.querySelector(".workspace-directory").click()');
  await until(() => js('document.getElementById("workspace-folder").textContent.includes("another-project")'));
  await js('document.getElementById("workspace-context").click()');
  await until(() => js('document.getElementById("context-report").textContent.includes("No dispatched request")'));
  await js('document.querySelector("#settings .sheet-x").click();document.getElementById("workspace-command").click()');
  assert.equal(await js('document.getElementById("workspace-commands").open'), true);
  await js('var search=document.getElementById("workspace-command-search");search.value="terminal";search.dispatchEvent(new Event("input"))');
  assert.equal(await js('document.querySelectorAll("#workspace-command-list button").length'), 1);
  await js('document.querySelector("#workspace-command-list button").click()');
  assert.equal(await js('document.getElementById("stage").dataset.term'), "on");
  await js('document.getElementById("term-btn").click();document.querySelector(".workspace-session").click()');
  await until(() => js('document.getElementById("workspace-chat-title").textContent==="Nova Collar workspace"'));
  phase = "observed provider progress";
  const event = (value) => win.webContents.send("workspace-event", value);
  const statusText = () => js('document.getElementById("workspace-state").textContent');
  await js(`window.__workspaceTimers=new Set();window.__interval=window.setInterval;window.__clearInterval=window.clearInterval;
    window.setInterval=(fn,ms)=>{const id=window.__interval(fn,ms);window.__workspaceTimers.add(id);return id};
    window.clearInterval=id=>{window.__workspaceTimers.delete(id);window.__clearInterval(id)};true;`);
  event({ type: "conversation", active: true, paused: false, pending: [], question: null });
  await until(() => js('!document.getElementById("stop").hidden'));
  event({ type: "provider_progress", state: "requesting" });
  await until(async () => (await statusText()).includes("Waiting for model"));
  assert(!(await statusText()).includes("Queued"));
  event({ type: "provider_progress", state: "queued", waitMs: 7000, position: 3, requestId: "ui-queue", text: "UNTRUSTED_STATUS_TEXT", backend: "UNTRUSTED_BACKEND" });
  await until(async () => (await statusText()).includes("position ~3"));
  assert.match(await statusText(), /7s/);
  assert(!(await statusText()).includes("UNTRUSTED"));
  assert.equal(await js('window.__workspaceTimers.size'), 1);
  await delay(1100);
  assert.match(await statusText(), /8s/);
  event({ type: "provider_progress", state: "admitted", waitMs: 8100, requestId: "ui-queue" });
  await until(async () => (await statusText()).includes("Model admitted"));
  assert(!(await statusText()).includes("position"));
  event({ type: "provider_progress", state: "writing", text: "PRIVATE_THOUGHT_OR_MESSAGE" });
  await until(async () => (await statusText()).includes("Writing"));
  assert(!(await statusText()).includes("PRIVATE_THOUGHT"));
  event({ type: "provider_progress", state: "queued", waitMs: -1, position: 0, text: "Invalid metadata" });
  await delay(40);
  assert((await statusText()).includes("Writing"));
  await js('window.dispatchEvent(new MessageEvent("message",{data:{type:"provider_progress",state:"queued",waitMs:0,position:99}}))');
  assert(!(await statusText()).includes("99"));
  event({ type: "provider_progress", state: "retrying", waitMs: 1500, attempt: 1 });
  await until(async () => (await statusText()).includes("retry in"));
  event({ type: "conversation", active: true, paused: false, pending: [{ id: "guidance-1" }], question: null });
  await until(async () => (await statusText()).includes("1 message waiting for the next step"));
  assert.equal(await js('window.__workspaceTimers.size'), 0);
  event({ type: "conversation", active: false, paused: true, pending: [{ id: "guidance-1" }], question: null });
  await until(async () => (await statusText()).includes("Paused · input saved"));
  event({ type: "conversation", active: true, paused: false, pending: [], question: { id: "question-fixture", questions: [{ id: "scope", question: "Keep this draft?", options: ["Keep"] }] } });
  await until(async () => (await statusText()).includes("Waiting for your answer"));
  event({ type: "provider_progress", state: "thinking" });
  await delay(40);
  assert((await statusText()).includes("Waiting for your answer"));
  event({ type: "conversation", active: true, paused: false, pending: [], question: null });
  event({ type: "provider_progress", state: "queued", waitMs: 0, position: 2 });
  await until(async () => (await statusText()).includes("position ~2"));
  await js('document.getElementById("stop").click()');
  await until(async () => (await statusText()).includes("Stopping"));
  assert.equal(await js('document.getElementById("workspace-state").dataset.providerState'), "");
  assert.equal(await js('window.__workspaceTimers.size'), 0);
  event({ type: "provider_progress", state: "queued", waitMs: 0, position: 99 });
  await delay(40);
  assert(!(await statusText()).includes("99"));
  event({ type: "done", text: "" });
  await until(async () => (await statusText()) === "Ready");
  event({ type: "conversation", active: true, paused: false, pending: [], question: null });
  event({ type: "provider_progress", state: "thinking" });
  await until(async () => (await statusText()).includes("Thinking"));
  event({ type: "error", text: "Synthetic fixture failure" });
  await until(async () => (await statusText()) === "Ready");
  assert.equal(await js('window.__workspaceTimers.size'), 0);
  event({ type: "history_archive_error", code: "corrupt", error: "UNTRUSTED_ARCHIVE_DETAIL" });
  await until(() => js('document.getElementById("chat").textContent.includes("Local archive unavailable")'));
  assert(!(await js('document.getElementById("chat").textContent')).includes("UNTRUSTED_ARCHIVE_DETAIL"));
  phase = "explicit recovery controls";
  await js('document.getElementById("workspace-recovery").click()');
  await until(() => js('document.querySelectorAll("#workspace-recovery-list section").length===1'));
  assert.equal(await js('document.querySelectorAll("#workspace-recovery-list img").length'), 0, "saved requests render as inert text");
  assert.equal(recoveryRestores, 0, "opening a point never restores or replays anything");
  await js('document.querySelector("#workspace-recovery-list section button").click()');
  await until(() => js('document.getElementById("workspace-recovery-status").textContent.includes("later-owner-edit conflict")'));
  assert.equal(await js('document.getElementById("workspace-recovery-dialog").open'), true);
  assert.equal(recoveryRestores, 1, "a conflict is not retried automatically");
  await js('document.querySelector("#workspace-recovery-list section button").click()');
  await until(() => js('document.getElementById("workspace-chat-title").textContent==="Recovered fixture"'));
  assert.equal(await js('document.getElementById("workspace-recovery-dialog").open'), false);
  assert.equal(await js('document.getElementById("chat").textContent.includes("Fresh verification is required")'), true);
  rows.shift(); current = "workspace";
  await js('window.pup.openChat("workspace").then(window.showRecoveredSession)');
  // Restore the original public sample before screenshots; fixture activity is not a live run.
  await js('document.querySelectorAll(".workspace-session")[1].click()');
  await until(() => js('document.getElementById("workspace-chat-title").textContent==="Research notes"'));
  await js('document.querySelector(".workspace-session").click()');
  await until(() => js('document.getElementById("workspace-chat-title").textContent==="Nova Collar workspace"'));
  const output = process.env.NOVA_WORKSPACE_SCREENSHOTS;
  const capture = async (name) => {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await delay(150);
    if (output) { mkdirSync(output, { recursive: true }); writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG()); }
  };
  await capture("Nova-Collar-Workspace-Desktop.png");
  phase = "narrow layout";
  win.setSize(420, 760);
  await until(() => js('innerWidth===420'));
  assert.equal(await js('getComputedStyle(document.getElementById("workspace-sidebar")).display'), "none");
  await js('document.querySelector(".workspace-menu-btn").click()');
  assert.equal(await js('getComputedStyle(document.getElementById("workspace-sidebar")).display'), "flex");
  await js('document.querySelector(".workspace-menu-btn").click()');
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
  const bounds = await js('Object.fromEntries(["send","input","model-btn"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,right:r.right,bottom:r.bottom}]}))');
  for (const [id, box] of Object.entries(bounds)) {
    assert.ok(box.x >= 0 && box.right <= 421 && box.bottom <= 761, `${id} is outside the narrow window: ${JSON.stringify(box)}`);
  }
  event({ type: "conversation", active: true, paused: false, pending: [], question: null });
  event({ type: "provider_progress", state: "queued", waitMs: 2000, position: 4 });
  await until(async () => (await statusText()).includes("position ~4"));
  const statusBounds = await js('var r=document.getElementById("workspace-state").getBoundingClientRect();({x:r.x,right:r.right})');
  assert(statusBounds.x >= 0 && statusBounds.right <= 420, "Provider status stays inside the narrow footer");
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
  event({ type: "done", text: "" });
  await until(async () => (await statusText()) === "Ready");
  assert.equal(await js('window.__workspaceTimers.size'), 0);
  await capture("Nova-Collar-Workspace-Narrow.png");
  assert.deepEqual(errors, []);
  console.log("PASS: real workspace renderer; saved-chat switching, folder selection, context inspection, command search/terminal, explicit recovery selection/conflict/no-retry/new-branch rendering, validated provider queue/admission/retry/token activity, elapsed wait, pending/question precedence, Stop/done/error clearing and active-only timer, mobile drawer and visible composer/model controls at 1280px and 420px. Zero renderer errors. Screenshots use restored public sample conversations; no model or private profile.");
  clearTimeout(deadline); win.destroy(); rmSync(home, { recursive: true, force: true }); app.exit(0);
} catch (error) {
  console.error(error); clearTimeout(deadline); app.exit(1);
}
}
void main();
