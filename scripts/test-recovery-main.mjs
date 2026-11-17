// Real main/preload/renderer APIs with an isolated synthetic owner profile.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "collar-recovery-main-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "no-model");
app.setPath("userData", join(root, "electron")); app.setPath("sessionData", join(root, "electron"));
globalThis.fetch = async url => {
  if (String(url).endsWith("/models")) return Response.json({ data: [] });
  if (String(url).endsWith("/api/tags")) return Response.json({ models: [] });
  throw new Error("Network/inference is forbidden in the recovery-main fixture.");
};
for (const event of ["uncaughtException", "unhandledRejection"]) process.on(event, error => { console.error(error); app.exit(1); });
const deadline = setTimeout(() => { console.error("Recovery main fixture timed out"); app.exit(1); }, 30_000);
const until = async fn => { for (let n = 0; n < 100; n++) { if (await fn()) return; await delay(50); } throw new Error("Expected recovery window state was not reached."); };

async function main() {
  try {
    const { ensureHome, saveKeys } = await import("../src/main/config.js");
    const { createSession, readSession, saveSession } = await import("../src/main/sessions.js");
    const { Checkpoint } = await import("../src/main/checkpoints.js");
    const { beginRecoveryPoint, finishRecoveryPoint } = await import("../src/main/recovery-points.js");
    ensureHome(); saveKeys({ chatUrl: "https://ai.hungrynova.com/v1", chatKey: "synthetic-fixture-key", model: "synthetic-model" });
    const cwd = join(root, "project"); mkdirSync(cwd);
    writeFileSync(join(process.env.NOVAPUP_HOME, "workdir.json"), JSON.stringify({ path: cwd }));
    const session = createSession();
    saveSession(session.id, [{ role: "user", content: "Synthetic owner source history" }], { turnState: { active: false, inFlight: "" } });
    const file = join(cwd, "example.txt"); writeFileSync(file, "accepted source");
    const point = beginRecoveryPoint(session.id, { cwd, history: [{ role: "user", content: "Earlier accepted conversation" }], request: "Synthetic change attempt", goal: "Finish synthetic work" });
    const checkpoint = new Checkpoint(session.id, cwd); checkpoint.track([file]); writeFileSync(file, "attempt source"); finishRecoveryPoint(point, checkpoint.finish("finished"));
    const original = JSON.stringify(readSession(session.id));
    await import("../src/main/index.js");
    await until(() => BrowserWindow.getAllWindows().some(window => !window.webContents.isLoading()));
    const win = BrowserWindow.getAllWindows()[0], js = source => win.webContents.executeJavaScript(source);
    await until(() => js('Boolean(window.pup?.recoveryPoints && document.getElementById("workspace-recovery"))'));
    const points = await js("window.pup.recoveryPoints()");
    assert.equal(points.ok, true); assert(points.points.some(row => row.id === point.id));
    const recovered = await js(`window.pup.recoverPoint(${JSON.stringify(point.id)})`);
    assert.equal(recovered.ok, true); assert.notEqual(recovered.session.current, session.id);
    assert.equal(readFileSync(file, "utf8"), "accepted source");
    assert.equal(JSON.stringify(readSession(session.id)), original);
    assert.equal(recovered.recovery.verification, "requires-fresh-checks");
    await js(`window.showRecoveredSession(${JSON.stringify(recovered)})`);
    assert((await js('document.getElementById("chat").textContent')).includes("Original chat"));
    assert.equal((await js("window.pup.recoveryOperations()")).operations[0].state, "complete");
    assert.equal((await js('window.pup.recoverPoint("invalid-id")')).ok, false);
    console.log("PASS: actual main/preload/renderer recovery APIs, new branch, unchanged original history, source restore, fresh-verification status and invalid-id rejection; no live provider call or private profile.");
    clearTimeout(deadline); win.destroy(); rmSync(root, { recursive: true, force: true }); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
}
void main();
