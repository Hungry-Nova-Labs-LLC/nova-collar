// Owner-selected recovery uses local main-process APIs; models cannot invoke it.
(() => {
  const actions = document.querySelector(".workspace-heading-actions");
  if (!actions || !window.pup.recoveryPoints) return;
  const button = document.createElement("button");
  button.type = "button"; button.id = "workspace-recovery"; button.textContent = "Recovery";
  actions.append(button);
  const dialog = document.createElement("dialog");
  dialog.id = "workspace-recovery-dialog";
  dialog.setAttribute("aria-labelledby", "workspace-recovery-title");
  dialog.innerHTML = '<form method="dialog"><header><h2 id="workspace-recovery-title">Recovery points</h2><button aria-label="Close recovery">×</button></header></form><p>Restore recorded local files and open an earlier working state in a new chat. Original history stays available. External actions are not undone.</p><p id="workspace-recovery-status" role="status"></p><div id="workspace-recovery-operations"></div><div id="workspace-recovery-list"></div>';
  document.body.append(dialog);
  const status = dialog.querySelector("#workspace-recovery-status");
  let submitting = false;
  const active = () => submitting || !document.getElementById("stop").hidden;
  const paintBusy = () => { button.disabled = active(); };
  new MutationObserver(paintBusy).observe(document.getElementById("stop"), { attributes: true });
  const textNode = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  const draw = async () => {
    status.textContent = "Reading local recovery records…";
    const [saved, operations] = await Promise.all([window.pup.recoveryPoints(), window.pup.recoveryOperations()]);
    const list = dialog.querySelector("#workspace-recovery-list"), pending = dialog.querySelector("#workspace-recovery-operations");
    list.replaceChildren(); pending.replaceChildren();
    if (!saved.ok || !operations.ok) { status.textContent = saved.error || operations.error || "Recovery records are unavailable."; return; }
    const blockers = operations.operations.filter(row => !["complete", "acknowledged"].includes(row.state));
    for (const operation of blockers) {
      const card = document.createElement("section");
      card.append(textNode("h3", "Incomplete recovery needs inspection"), textNode("p", `${operation.id} · ${operation.state}`), textNode("p", "Inspect the current files and operation receipt before continuing. Recording an inspection does not certify a successful restore."));
      const detail = document.createElement("details"); detail.append(textNode("summary", "Operation receipt"), textNode("pre", JSON.stringify(operation, null, 2))); card.append(detail);
      const note = document.createElement("textarea"); note.maxLength = 2000; note.placeholder = "Describe what you inspected (at least 24 characters)"; note.setAttribute("aria-label", "Manual recovery inspection note");
      const ack = textNode("button", "Record my inspection"); ack.type = "button"; ack.disabled = true;
      note.oninput = () => { ack.disabled = active() || note.value.trim().length < 24; };
      ack.onclick = async () => {
        if (active()) return;
        submitting = true; paintBusy(); ack.disabled = true;
        try {
          const result = await window.pup.acknowledgeRecovery(operation.id, note.value);
          if (!result.ok) status.textContent = result.error;
          else { status.textContent = "Inspection recorded. Fresh checks are still required."; await draw(); }
        } catch (error) { status.textContent = error.message; }
        finally { submitting = false; paintBusy(); ack.disabled = note.value.trim().length < 24; }
      };
      card.append(note, ack); pending.append(card);
    }
    for (const point of saved.points.slice(0, 100)) {
      const card = document.createElement("section");
      card.append(textNode("h3", point.request || "Working-state boundary"), textNode("p", `${new Date(point.createdAt).toLocaleString()} · ${point.verification.replaceAll("-", " ")}`));
      const restore = textNode("button", "Restore recorded files into a new chat"); restore.type = "button";
      restore.disabled = !point.available || blockers.length > 0 || active();
      restore.onclick = async () => {
        if (active()) return;
        submitting = true; paintBusy(); restore.disabled = true; status.textContent = "Checking the complete restore range…";
        try {
          const result = await window.pup.recoverPoint(point.id);
          if (!result.ok) status.textContent = result.error || "Recovery was not completed.";
          else { window.showRecoveredSession(result); dialog.close(); }
        } catch (error) { status.textContent = error.message; }
        finally { submitting = false; paintBusy(); restore.disabled = !point.available || blockers.length > 0; }
      };
      card.append(restore); list.append(card);
    }
    status.textContent = blockers.length ? "Work is blocked until the incomplete recovery is inspected." : saved.points.length ? "Each point records its test coverage. Fresh verification is required after a restore." : "Recovery points appear after your next owner chat turn.";
  };
  button.onclick = () => {
    if (active()) return;
    dialog.showModal(); draw().catch(error => { status.textContent = error.message; });
  };
  window.pup.on(event => {
    if (event.type === "recovery_unavailable") button.title = `Recovery unavailable: ${event.error}`;
    if (event.type === "recovery_point") button.title = "Inspect recorded working-state boundaries";
  });
  paintBusy();
})();
