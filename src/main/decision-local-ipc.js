// Keep renderer requests bounded to the local adviser controls. The renderer
// never supplies a URL, file path, model name, executable or command.
export function registerDecisionLocalIpc({ ipcMain, fromWindow, api, send, openLicense }) {
  let installation = null;
  const denied = () => ({ ok: false, error: "This window cannot change adviser settings." });
  const safeFailure = async () => ({ ...await api.decisionLocalStatus(), stage: "error", errorCode: "unavailable",
    error: "The adviser could not finish this step. Please try again." });
  const handle = (name, action) => ipcMain.handle(`decision-local:${name}`, async (event, input) => {
    if (!fromWindow(event)) return denied();
    try { return await action(input); } catch { return safeFailure(); }
  });
  const unsubscribe = api.onDecisionLocalStatus(send);
  handle("status", () => api.decisionLocalStatus());
  handle("install", () => {
    if (!installation) {
      installation = Promise.resolve().then(() => api.decisionLocalInstall())
        .catch(async () => { send({ type: "decision-local", ...await safeFailure(), stage: "error" }); })
        .finally(() => { installation = null; });
    }
    return api.decisionLocalStatus();
  });
  handle("cancel", async () => {
    const pending = installation;
    const result = await api.decisionLocalCancel();
    // A cancelled status can be emitted before the background install's final
    // cleanup. Acknowledge only after its IPC deduplication slot is released.
    await pending;
    return result;
  });
  handle("enabled", enabled => {
    if (typeof enabled !== "boolean") return { ok: false, error: "Choose whether to use the local adviser." };
    return api.decisionLocalSetEnabled(enabled);
  });
  handle("defer", () => api.decisionLocalDefer());
  handle("check", () => api.decisionLocalCheck());
  handle("license", () => openLicense());
  return { unsubscribe, installationPending: () => Boolean(installation) };
}
