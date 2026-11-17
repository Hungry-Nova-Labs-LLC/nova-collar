// Optional local adviser setup. Only the main process downloads or starts models.
(() => {
  const byId = id => document.getElementById(id);
  const panel = byId("decision-setup");
  const settings = byId("decision-local-settings");
  if (!panel || !window.pup?.decisionLocalStatus) {
    if (settings) settings.hidden = true;
    return;
  }
  const api = window.pup;
  const title = byId("decision-setup-title");
  const kicker = byId("decision-setup-kicker");
  const body = byId("decision-setup-body");
  const detail = byId("decision-setup-detail");
  const status = byId("decision-setup-status");
  const actions = byId("decision-setup-acts");
  const progress = byId("decision-progress");
  const progressWrap = byId("decision-progress-wrap");
  const progressText = byId("decision-progress-text");
  const summary = byId("decision-local-summary");
  const settingsButton = byId("decision-local-open");
  const activeStages = new Set(["downloading", "verifying", "starting", "checking", "cancelling"]);
  const stageText = {downloading: "Downloading the adviser", verifying: "Verifying the download", starting: "Starting the local adviser", checking: "Checking a sample decision", cancelling: "Stopping installation"};
  let snapshot = null;
  let requestPending = false;
  let cancelPending = false;
  let offered = false;
  let previousFocus = null;
  let previousInert = false;
  let generation = 0;
  let eventRevision = 0;
  let actionError = "";
  let primaryState = null;

  const button = (text, fn, primary = false) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = text;
    item.className = primary ? "go" : "";
    item.disabled = requestPending || cancelPending;
    item.onclick = fn;
    return item;
  };
  const active = () => activeStages.has(snapshot?.stage);
  const megabytes = bytes => `${Math.round(bytes / 1_000_000).toLocaleString()} MB`;
  function errorText(reason) {
    const messages = {
      "unsupported-platform": "This computer is not supported by the local adviser yet. You can keep using your connected chat model.",
      "insufficient-disk": "There is not enough free space. Free some space, then try again.",
      "not-enough-space": "There is not enough free space. Free some space, then try again.",
      "disk-space": "There is not enough free space. Free some space, then try again.",
      "download-failed": "The download could not finish. Check your internet connection, then retry.",
      "download-timeout": "The download timed out. Check your internet connection, then retry.",
      "download-not-published": "The free model download is not available yet. Please try again later.",
      "hash-mismatch": "The download did not pass verification. Retry to get a fresh verified copy.",
      "download-hash": "The download did not pass verification. Retry to get a fresh verified copy.",
      "verification-failed": "The download did not pass verification. Retry to get a fresh verified copy.",
      "check-failed": "The local check did not finish successfully. You can retry it below.",
      "self-check-failed": "The local check did not finish successfully. You can retry it below.",
      "runtime-missing": "The local runtime is unavailable. Try updating Nova Collar, then check again.",
      "runtime-unavailable": "The local runtime is unavailable. Try updating Nova Collar, then check again.",
      "cancelled": "Installation was cancelled. Your chat connection is ready to use.",
    };
    return messages[reason] || "The adviser could not be set up. You can retry below or keep using your connected chat model.";
  }
  function apply(value) {
    if (!value || typeof value !== "object") return;
    // No raw provider errors, local paths, endpoints, keys, or prompts enter this view.
    snapshot = value;
    render();
  }
  function render() {
    const s = snapshot;
    if (!s) return;
    const installing = active();
    const enabled = Boolean(s.installed && s.enabled);
    summary.textContent = installing ? stageText[s.stage]
      : enabled ? "On · d1-Omni-2B runs on this computer after a failed check."
      : s.installed ? "Installed · local adviser is off. The download is kept for next time."
      : s.supported === false ? "Local installation is not available on this computer yet."
      : "Optional · free local adviser, about 1.85 GB. Your chat model stays selected.";
    settingsButton.textContent = s.installed || installing ? "Manage local adviser" : "Set up local adviser";
    if (panel.hidden) return;
    panel.dataset.stage = String(s.stage || "not-installed");
    panel.setAttribute("aria-busy", String(installing || requestPending || cancelPending));
    kicker.textContent = installing ? "On this computer" : s.installed ? "Local decision adviser" : "Optional · recommended";
    title.textContent = installing ? stageText[s.stage] : enabled ? "Your local adviser is on" : s.installed ? "Your local adviser is installed" : "A little help with the next step";
    body.textContent = "After a check fails, this small model can suggest a next step. Your connected chat model does the work, and Nova still checks the result.";
    detail.textContent = s.installed ? "The model stays on this computer across app updates. Turning it off keeps the download."
      : "Install and enable d1-Omni-2B on this computer. About 1.85 GB for the model, plus a small runtime included with Nova Collar. No model account or API key needed.";
    status.textContent = actionError || (s.supported === false ? errorText(s.reason || "unsupported-platform")
      : s.stage === "error" ? errorText(s.errorCode || s.reason || s.code)
      : s.stage === "cancelled" ? errorText("cancelled")
      : enabled ? "Ready · local check passed. Advice is optional and can be wrong."
      : s.installed ? "Ready to enable."
      : "");
    progressWrap.hidden = !installing;
    if (installing) {
      const total = s.progress?.totalBytes;
      const received = s.progress?.receivedBytes;
      const percent = Number.isFinite(total) && total > 0 && Number.isFinite(received) && received >= 0
        ? Math.max(0, Math.min(100, Math.floor(received / total * 100)))
        : Number.isFinite(s.progress?.percent) ? Math.max(0, Math.min(100, Math.floor(s.progress.percent))) : null;
      if (s.stage === "downloading" && percent !== null) {
        progress.value = percent;
        progressText.textContent = Number.isFinite(received) && Number.isFinite(total)
          ? `${percent}% · ${megabytes(received)} of ${megabytes(total)}` : `${percent}% downloaded`;
      } else {
        progress.removeAttribute("value");
        progressText.textContent = s.stage === "checking" ? "One small local test. This may take a moment." : `${stageText[s.stage]}…`;
      }
    }
    actions.replaceChildren();
    if (installing) {
      const cancel = button(s.stage === "cancelling" ? "Cancelling…" : "Cancel installation", cancelInstall);
      cancel.disabled = s.stage === "cancelling";
      actions.append(cancel, button("Continue to chat", dismiss));
    } else if (s.supported === false) {
      actions.append(button("Continue to chat", dismiss, true));
    } else if (s.installed) {
      actions.append(button(enabled ? "Turn off local adviser" : "Enable local adviser", () => perform(() => api.decisionLocalSetEnabled(!enabled)), !enabled));
      actions.append(button(s.stage === "error" ? "Retry local check" : "Check local adviser", () => perform(() => api.decisionLocalCheck())));
      actions.append(button("Done", dismiss, enabled));
    } else {
      actions.append(button(s.stage === "error" || s.stage === "cancelled" ? "Retry installation" : "Install free local adviser", () => perform(() => api.decisionLocalInstall()), true));
      actions.append(button("Maybe later", dismiss));
    }
  }
  async function perform(fn) {
    if (requestPending) return;
    requestPending = true;
    actionError = "";
    const revision = eventRevision;
    render();
    try {
      const value = await fn();
      // The background install may emit progress before its start acknowledgement.
      if (eventRevision === revision) apply(value);
    }
    catch { actionError = "That action could not finish. Try again, or return to chat."; }
    finally { requestPending = false; render(); }
  }
  async function cancelInstall() {
    // Cancellation remains available while an install request is in flight.
    if (cancelPending) return;
    cancelPending = true;
    apply({...snapshot, stage: "cancelling"});
    try { apply(await api.decisionLocalCancel()); }
    catch { actionError = "Cancellation could not finish. Try again, or return to chat."; }
    finally { cancelPending = false; render(); }
  }
  async function dismiss() {
    offered = true;
    generation++;
    panel.hidden = true;
    const workspace = byId("creature");
    if (workspace) workspace.inert = previousInert;
    if (previousFocus?.isConnected) previousFocus.focus();
    try { apply(await api.decisionLocalDefer()); } catch { /* Settings remains available. */ }
  }
  function show() {
    if (panel.hidden) {
      previousFocus = document.activeElement;
      const workspace = byId("creature");
      previousInert = Boolean(workspace?.inert);
      if (workspace) workspace.inert = true;
    }
    panel.hidden = false;
    render();
    panel.focus();
  }
  async function refresh() {
    const revision = eventRevision;
    try { const value = await api.decisionLocalStatus(); if (eventRevision === revision) apply(value); return snapshot; }
    catch { return null; }
  }
  window.openDecisionSetup = async () => {
    generation++;
    const current = await refresh();
    if (current) show();
    else summary.textContent = "The local adviser settings could not be opened. Try again.";
  };
  window.maybeOfferDecisionSetup = async state => {
    primaryState = state;
    if (!state?.ready || state.conversation?.active || state.conversation?.paused || state.conversation?.pending?.length || state.conversation?.question || offered) return;
    const token = ++generation;
    const s = await refresh();
    const draft = byId("input") || byId("say");
    if (token !== generation || !s || s.firstRunPrompted || s.installed || s.supported === false || offered
      || primaryState?.conversation?.active || (draft && draft.value.trim()) || document.querySelector("dialog[open]") || !byId("setup")?.hidden || !byId("wake")?.hidden) return;
    offered = true;
    show();
  };
  settingsButton.onclick = window.openDecisionSetup;
  byId("decision-local-license").onclick = async () => {
    try {
      const result = await api.decisionLocalLicense();
      if (result?.ok !== true) status.textContent = "The license could not be opened. Try again from Settings.";
    }
    catch { status.textContent = "The license could not be opened. Try again from Settings."; }
  };
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    if (event.key !== "Tab") return;
    const items = Array.from(panel.querySelectorAll("button:not(:disabled),a[href]"));
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
  });
  api.on?.(event => {
    if (event.type === "decision-local") { eventRevision++; actionError = ""; apply(event.status || event); }
    if (event.type === "conversation" && primaryState) primaryState = {...primaryState, conversation: event};
  });
  refresh();
})();
