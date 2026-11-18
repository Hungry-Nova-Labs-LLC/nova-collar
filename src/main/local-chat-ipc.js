export function registerLocalChatIpc({ ipcMain, fromWindow, api, snapshot, send, canChange, pickFile, markSetupDone }) {
  let pending = null, choosing = false;
  const status = () => api.localChatStatus();
  const response = async result => ({ ...(result || {}), status: result?.status || await status(), state: snapshot() });
  const denied = () => ({ ok: false, errorCode: "active-turn", error: "Finish or stop active work before changing the primary model." });
  const handle = (name, fn) => ipcMain.handle(`local-chat:${name}`, async (event, value) => {
    if (!fromWindow(event)) return { ok: false, errorCode: "denied" };
    try { return await fn(value); } catch { return { ok: false, errorCode: "unavailable", status: await status() }; }
  });
  api.setLocalChatGuard(canChange);
  const unsubscribe = api.onLocalChatStatus(value => send({ ...value, state: snapshot() }));
  handle("status", status);
  handle("install", async id => {
    if (typeof id !== "string" || id.length > 96) return { ok: false, errorCode: "model-missing" };
    if (!pending) {
      pending = api.localChatInstall(id).then(async result => { if (result.ok) markSetupDone(); send({ type: "local-chat", ...result.status, state: snapshot() }); })
        .catch(async () => send({ type: "local-chat", ...await status(), errorCode: "unavailable", state: snapshot() }))
        .finally(() => { pending = null; });
    }
    return response({ ok: true });
  });
  handle("import", async () => {
    if (!canChange()) return denied();
    if (choosing || pending || (await status()).busyId) return response({ ok: false, errorCode: "busy" });
    choosing = true;
    try {
      const file = await pickFile(); if (!file) return response({ ok: false, errorCode: "cancelled" });
      if (!canChange()) return denied();
      const result = await api.localChatImport(file); if (result.ok) markSetupDone(); return response(result);
    } finally { choosing = false; }
  });
  handle("use", async id => { if (!canChange()) return denied(); const result = await api.localChatUse(id); if (result.ok) markSetupDone(); return response(result); });
  handle("stop", async () => canChange() ? response(await api.localChatStop()) : denied());
  handle("cancel", async () => { const result = await api.localChatCancel(); await pending; return response(result); });
  handle("remove", async id => canChange() ? response(await api.localChatRemove(id)) : denied());
  handle("restore", async () => canChange() ? response(await api.localChatRestorePrevious()) : denied());
  handle("license", () => api.localChatLicense());
  return { unsubscribe };
}
