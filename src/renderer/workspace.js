// Desktop navigation delegates to the existing renderer controls. Conversation,
// approval and terminal behavior remain owned by their public modules.
(() => {
  const root = document.getElementById("creature");
  // The old compact header preference must not hide desktop navigation.
  root.dataset.home = "on";
  const byId = (id) => document.getElementById(id);
  const sidebar = document.createElement("aside");
  sidebar.id = "workspace-sidebar";
  sidebar.setAttribute("aria-label", "Workspace navigation");
  sidebar.innerHTML = '<div class="workspace-sidebar-top"><button id="workspace-new-chat" type="button">＋ New chat</button><button id="workspace-command" type="button" aria-label="Search commands" title="Commands · ⌘K">⌘K</button></div><p class="workspace-sidebar-label">Workspace</p>';
  root.insertBefore(sidebar, byId("stage"));
  sidebar.append(byId("home-bar"));
  const chatsNav = byId("chats-btn");
  chatsNav.parentElement.prepend(chatsNav);
  const labels = {
    "chats-btn": ["All chats", "Browse saved conversations"],
    "crew-btn": ["Agents & tasks", "Manage agents and assigned tasks"],
    "sense-btn": ["Work review", "Review evidence and lessons from recent work"],
    "spec-btn": ["Spec editor", "Write and refine a specification"],
    "term-btn": ["Terminal", "Show or hide the terminal"],
    "settings-btn": ["Settings", "Models, appearance and tools"],
    "pin": ["Keep on top", "Keep this window above other apps"],
  };
  for (const [id, [label, title]] of Object.entries(labels)) {
    const button = byId(id);
    if (!button) continue;
    const span = button.querySelector("span");
    if (span) span.textContent = label;
    button.title = title;
  }
  const savedHeading = document.createElement("p");
  savedHeading.className = "workspace-sidebar-label";
  savedHeading.textContent = "Recent chats";
  const saved = document.createElement("div");
  saved.id = "workspace-sessions-list";
  saved.className = "workspace-sessions-list";
  sidebar.append(savedHeading, saved);
  const toolsHeading = document.createElement("p");
  toolsHeading.className = "workspace-sidebar-label";
  toolsHeading.textContent = "Tools";
  sidebar.append(toolsHeading, byId("drawers"));

  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "workspace-menu-btn";
  menu.textContent = "☰";
  menu.title = "Toggle sidebar";
  menu.setAttribute("aria-label", "Toggle sidebar");
  menu.setAttribute("aria-controls", sidebar.id);
  menu.setAttribute("aria-expanded", "false");
  byId("eyes").before(menu);
  byId("eyes").className = "workspace-mark";
  byId("eyes").textContent = "N";
  byId("eyes").setAttribute("aria-hidden", "true");
  const closeSidebar = () => {
    document.body.dataset.sidebar = "";
    menu.setAttribute("aria-expanded", "false");
  };
  menu.onclick = () => {
    const open = document.body.dataset.sidebar !== "open";
    document.body.dataset.sidebar = open ? "open" : "";
    menu.setAttribute("aria-expanded", String(open));
  };
  sidebar.addEventListener("click", (event) => {
    if (event.target.closest("#home-bar button, .workspace-session")) closeSidebar();
  });
  byId("stage").addEventListener("pointerdown", closeSidebar);

  const heading = document.createElement("header");
  heading.className = "workspace-heading";
  heading.innerHTML = '<div><p class="workspace-eyebrow">Conversation</p><h1 id="workspace-chat-title">New chat</h1></div><div class="workspace-heading-actions"><button type="button" class="workspace-directory" title="Choose working folder">Choose folder</button><button type="button" id="workspace-context" title="Inspect the last model request">Context</button></div>';
  byId("chat").before(heading);
  heading.querySelector(".workspace-directory").onclick = () => byId("cwd-pick").click();
  byId("workspace-context").onclick = () => {
    if (byId("settings").hidden) byId("settings-btn").click();
    byId("context-last").click();
  };
  const footer = document.createElement("footer");
  footer.className = "workspace-status";
  footer.innerHTML = '<span id="workspace-state" role="status"><span id="workspace-state-label">Ready</span><span id="workspace-state-detail" aria-hidden="true"></span></span><span id="workspace-folder"></span><span id="workspace-hint">Enter to send · Shift+Enter for a new line</span>';
  root.append(footer);
  byId("input").placeholder = "Ask Nova to work on something…";
  byId("input").setAttribute("aria-label", "Message Nova Collar");
  byId("workspace-new-chat").onclick = () => {
    byId("new-chat").click();
    closeSidebar();
    byId("input").focus();
  };

  const paintSessions = () => {
    saved.replaceChildren();
    const rows = [...byId("chats-list").querySelectorAll(".chat-item")];
    for (const row of rows.slice(0, 12)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-session";
      const title = row.querySelector("span")?.textContent || "New chat";
      button.textContent = title;
      button.title = title;
      if (row.classList.contains("current")) {
        button.classList.add("current");
        button.setAttribute("aria-current", "page");
      }
      button.onclick = () => row.click();
      saved.append(button);
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "workspace-empty";
      empty.textContent = "Your saved chats appear here.";
      saved.append(empty);
    }
    const current = rows.find((row) => row.classList.contains("current"));
    byId("workspace-chat-title").textContent = current?.querySelector("span")?.textContent || "New chat";
  };
  new MutationObserver(paintSessions).observe(byId("chats-list"), { childList: true, subtree: true, characterData: true });
  paintSessions();
  function paintWorkdir(path) {
    if (!path) return;
    const short = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
    const button = heading.querySelector(".workspace-directory");
    button.textContent = short;
    button.title = `Working folder: ${path}`;
    byId("workspace-folder").textContent = path;
    byId("workspace-folder").title = path;
  }
  window.addEventListener("collar:workdir", (event) => paintWorkdir(event.detail));
  paintWorkdir(byId("cwd").value);
  let provider = null, statusClock = null, stopping = false;
  const stateLabel = byId("workspace-state-label");
  const stateDetail = byId("workspace-state-detail");
  const seconds = (ms) => `${Math.max(0, Math.floor(ms / 1000))}s`;
  const clearProvider = () => {
    provider = null;
    if (statusClock !== null) clearInterval(statusClock);
    statusClock = null;
  };
  const paintStatus = () => {
    const active = !byId("stop").hidden;
    const paused = !byId("resume-input").hidden;
    const question = !byId("question-open").hidden;
    const pending = byId("pending-input").textContent.match(/^(\d+) messages? (?:paused|waiting for the next step)$/);
    const word = byId("now-word").textContent;
    if (!active) { clearProvider(); stopping = false; }
    let label = "Ready", detail = "";
    if (question) label = "Waiting for your answer";
    else if (paused) label = "Paused · input saved";
    else if (stopping) label = "Stopping…";
    else if (pending && Number(pending[1]) > 0) label = `${pending[1]} ${Number(pending[1]) === 1 ? "message" : "messages"} waiting for the next step`;
    else if (active && provider) {
      const age = seconds(Date.now() - provider.at);
      const waited = seconds(Date.now() - provider.startedAt);
      if (provider.state === "requesting") { label = "Waiting for model"; detail = `· ${waited}`; }
      if (provider.state === "queued") { label = "Queued for model"; detail = `· ${provider.position ? `position ~${provider.position} · ` : ""}${waited}`; }
      if (provider.state === "admitted") { label = "Model admitted"; detail = `· waiting for tokens ${waited}`; }
      if (provider.state === "retrying") { label = "Model busy"; detail = `· retry in ${Math.max(0, Math.ceil((provider.retryAt - Date.now()) / 1000))}s`; }
      if (provider.state === "thinking") { label = "Thinking"; detail = `· last tokens ${age} ago`; }
      if (provider.state === "writing") { label = "Writing"; detail = `· last tokens ${age} ago`; }
      if (provider.state === "tool") { label = "Preparing tool call"; detail = `· last data ${age} ago`; }
    } else if (active) label = word || "Working";
    if (stateLabel.textContent !== label) stateLabel.textContent = label;
    stateDetail.textContent = detail;
    byId("workspace-state").title = [label, detail].filter(Boolean).join(" ");
    byId("workspace-state").dataset.providerState = active && provider && !question && !paused && !pending && !stopping ? provider.state : "";
    byId("workspace-state").dataset.active = active ? "true" : "false";
    byId("workspace-new-chat").disabled = active;
    byId("workspace-new-chat").title = active ? "Stop the current turn before starting a new chat" : "Start a new conversation";
    const ticking = active && provider && !question && !paused && !pending && !stopping;
    if (ticking && statusClock === null) statusClock = setInterval(paintStatus, 1000);
    if (!ticking && statusClock !== null) { clearInterval(statusClock); statusClock = null; }
  };
  window.pup.on((event) => {
    if (["done", "error"].includes(event.type) || event.type === "conversation" && !event.active) {
      clearProvider(); stopping = false; paintStatus(); return;
    }
    if (event.type !== "provider_progress" || byId("stop").hidden || stopping) return;
    if (!["requesting", "queued", "admitted", "retrying", "thinking", "writing", "tool"].includes(event.state)) return;
    if (["queued", "admitted", "retrying"].includes(event.state)
      && (!Number.isFinite(event.waitMs) || event.waitMs < 0 || event.waitMs > 1_800_000)) return;
    if (event.position !== undefined && (!Number.isInteger(event.position) || event.position < 1 || event.position > 1024)) return;
    const now = Date.now();
    const requestId = typeof event.requestId === "string" && event.requestId.length <= 160 ? event.requestId : "";
    const sameQueue = provider?.state === "queued" && event.state === "queued" && provider.requestId === requestId;
    const startedAt = event.state === "queued" ? Math.min(sameQueue ? provider.startedAt : now, now - event.waitMs) : now;
    provider = { state: event.state, at: now, startedAt, requestId,
      ...(event.state === "queued" && event.position !== undefined ? { position: event.position } : {}),
      ...(event.state === "retrying" ? { retryAt: now + event.waitMs } : {}) };
    paintStatus();
  });
  for (const id of ["stop", "question-stop"]) byId(id)?.addEventListener("click", () => {
    stopping = true; clearProvider(); paintStatus();
  });
  window.addEventListener("beforeunload", clearProvider);
  const statusObserver = new MutationObserver(paintStatus);
  for (const id of ["stop", "resume-input", "question-open", "pending-input", "now-word"]) {
    statusObserver.observe(byId(id), { attributes: true, childList: true, characterData: true, subtree: true });
  }
  paintStatus();

  const dialog = document.createElement("dialog");
  dialog.id = "workspace-commands";
  dialog.setAttribute("aria-labelledby", "workspace-command-title");
  dialog.innerHTML = '<form method="dialog"><header><h2 id="workspace-command-title">Commands</h2><button aria-label="Close commands">×</button></header></form><input id="workspace-command-search" type="search" placeholder="Find a command…" aria-label="Find a command" autocomplete="off"><div id="workspace-command-list"></div>';
  document.body.append(dialog);
  const commands = [
    ["New chat", "workspace-new-chat"], ["All chats", "chats-btn"],
    ["Choose working folder", "cwd-pick"], ["Toggle terminal", "term-btn"],
    ["Inspect context", "workspace-context"], ["Switch model", "model-btn"],
    ["Agents & tasks", "crew-btn"], ["Review recent work", "sense-btn"],
    ["Spec editor", "spec-btn"],
    ["Settings", "settings-btn"],
  ];
  const commandSearch = byId("workspace-command-search");
  const paintCommands = () => {
    const list = byId("workspace-command-list");
    list.replaceChildren();
    for (const [name, target] of commands) {
      if (!byId(target) || !name.toLowerCase().includes(commandSearch.value.toLowerCase())) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.disabled = byId(target).disabled;
      button.onclick = () => { dialog.close(); closeSidebar(); byId(target).click(); };
      list.append(button);
    }
    if (!list.childElementCount) {
      const empty = document.createElement("p");
      empty.textContent = "No matching commands.";
      list.append(empty);
    }
  };
  byId("workspace-command").onclick = () => {
    commandSearch.value = "";
    paintCommands();
    dialog.showModal();
    commandSearch.focus();
  };
  commandSearch.oninput = paintCommands;
  commandSearch.onkeydown = (event) => {
    const first = byId("workspace-command-list").querySelector("button:not(:disabled)");
    if (event.key === "ArrowDown") { event.preventDefault(); first?.focus(); }
    if (event.key === "Enter" && first) { event.preventDefault(); first.click(); }
  };
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      // Keep native questions and approvals in control of the keyboard.
      if (document.querySelector("dialog[open]") && !dialog.open) return;
      if (dialog.open) dialog.close(); else byId("workspace-command").click();
    }
    if (event.key === "Escape") closeSidebar();
  });
  dialog.addEventListener("close", () => byId("input").focus());
})();
