(() => {
  const root = document.getElementById("setup");
  const kicker = document.getElementById("setup-kicker");
  const title = document.getElementById("setup-title");
  const body = document.getElementById("setup-body");
  const list = document.getElementById("setup-list");
  const log = document.getElementById("setup-log");
  const acts = document.getElementById("setup-acts");
  if (!root) return;
  let report = null;
  let pendingCredential = null;
  const button = (label,fn,primary=false) => {
    const item=document.createElement("button");item.type="button";item.className=primary?"go":"";item.textContent=label;item.onclick=fn;return item;
  };
  function show(step) {root.hidden=false;root.dataset.step=step;log.hidden=step!=="install";}
  async function scan() {
    pendingCredential=null;show("scan");kicker.textContent="Checking this computer";title.textContent="Looking for a model server";
    body.textContent="Checking local model servers. No other computer is scanned and nothing is installed.";
    list.replaceChildren();acts.replaceChildren();root.classList.add("busy");
    try {report=await window.pup.setupScan();} catch {report={found:[],error:"The scan could not finish. Try again or connect manually."};}
    finally {root.classList.remove("busy");}
    if(report?.decision?.mode==="auto" && report.state) return close(report.state,`Connected to ${report.decision.selected.model}.`);
    found();
  }
  function found() {
    show("found");kicker.textContent="Model connection";list.replaceChildren();acts.replaceChildren();
    let count=0;
    for(const hit of report?.found || []) {
      for(const model of hit.models || []) {
        count++;
        const loaded=hit.modelDetails?.some(row=>row.id===model&&row.loaded);
        const item=button(`${hit.name} · ${model}${loaded?" · loaded":""}`,()=>useHit(hit,model));
        item.className="chat-item";list.append(item);
      }
      if(hit.authRequired) {
        const item=button(`${hit.name} · API key required`,()=>manual(hit.url));item.className="chat-item";list.append(item);
      }
    }
    title.textContent=count?"Choose a model":window.pup.localChatStatus?"Choose how to use Nova Collar":"Connect a model server";
    body.textContent=report?.error || report?.decision?.error || (count
      ? "Choose the model to use. Already loaded models are marked. Your choice is saved on this computer."
      : report?.found?.some(hit=>hit.authRequired)
        ? "A local server is running and requires an API key. Enter the key for that server to find its models."
        : report?.found?.length
          ? "A server is running, but no chat model is available. Load a chat model in Ollama or LM Studio, then scan again."
          : "Start your model server, then scan again. You can also enter a local server address or choose another provider.");
    if(window.pup.localChatStatus) {
      if(!count && !report?.error && !report?.decision?.error) body.textContent="Download a chat model to use on this computer, or connect a model you already use. Your connection settings stay private.";
      acts.append(button("Download a chat model",()=>window.openLocalChatSetup?.({fromSetup:true}),true),button("Connect a model I already use",skip));
    }
    const more=document.createElement("details");more.id="setup-more-options";more.className="setup-more-options";
    const summary=document.createElement("summary");summary.textContent="More connection options";more.append(summary);
    const options=document.createElement("div");options.className="setup-acts";
    options.append(button("Scan again",scan),button("Connect manually",()=>manual()));
    if(window.pup.localChatStatus)options.append(button("Open a GGUF file",()=>window.openLocalChatSetup?.({fromSetup:true,importFile:true})));
    else options.append(button("Choose another provider",skip));
    const memory=report?.memory;
    if(!count && memory?.model && memory.platform!=="win32") {
      options.append(button(`Install Ollama and download ${memory.model.name} (${memory.model.diskGb} GB)`,install));
    }
    more.append(options);acts.append(more);
  }
  function field(label,type,value="") {
    const wrap=document.createElement("label");wrap.textContent=label;
    const input=document.createElement("input");input.type=type;input.value=value;input.autocomplete="off";input.spellcheck=false;input.setAttribute("aria-label",label);
    wrap.append(input);list.append(wrap);return input;
  }
  function manual(address="http://127.0.0.1:11434/v1") {
    show("manual");kicker.textContent="Local connection";title.textContent="Connect to your server";
    body.textContent="Enter a server address on this computer. The API key is optional and stays in Nova Collar's private local profile. Find models, or enter a model ID you already know.";
    list.replaceChildren();acts.replaceChildren();
    const url=field("Local server URL","url",address);
    const key=field("API key (optional)","password");
    const model=field("Model ID","text");
    acts.append(button("Find models and connect",async()=>{
      root.classList.add("busy");
      try {
        report=await window.pup.setupScan({url:url.value,apiKey:key.value});
        if(report.error) {body.textContent=report.error;return;}
        const candidates=(report.found || []).flatMap(hit=>(hit.models || []).map(id=>({hit,model:id,loaded:hit.modelDetails?.some(item=>item.id===id&&item.loaded)})));
        pendingCredential={url:report.found?.[0]?.url || url.value,apiKey:key.value};
        const loaded=candidates.filter(item=>item.loaded);
        const selected=loaded.length===1?loaded[0]:candidates.length===1?candidates[0]:null;
        if(selected) return await useHit(selected.hit,selected.model);
        found();
      } catch {body.textContent="The server could not be checked. Confirm its address and key, or scan again.";}
      finally {root.classList.remove("busy");}
    },true),button("Connect using model ID",()=>useHit({url:url.value,name:"Local server"},model.value,key.value)),button("Back",found));
  }
  async function install() {
    show("install");kicker.textContent="Download";title.textContent="Setting up Ollama";
    body.textContent="Installing Ollama and downloading the selected model onto this computer. This can take a while.";
    log.textContent="";acts.replaceChildren();root.classList.add("busy");
    try {
      const result=await window.pup.setupInstall();
      if(!result?.ok) {body.textContent=result?.error || "Installation stopped.";acts.replaceChildren(button("Back",found));return;}
      close(result.state,`Connected to ${result.model}.`);
    } catch {body.textContent="Installation stopped. You can connect to an existing server instead.";acts.replaceChildren(button("Back",found));}
    finally {root.classList.remove("busy");}
  }
  async function useHit(hit,model,apiKey) {
    const credential=apiKey === undefined && pendingCredential?.url===hit.url ? pendingCredential.apiKey : apiKey;
    try {
      const result=await window.pup.setupUse({url:hit.url,model,apiKey:credential});
      if(!result?.ok) {body.textContent=result?.error || "The connection could not be saved.";return;}
      pendingCredential=null;close(result.state,`Selected ${hit.name}: ${model}.`);
    } catch {body.textContent="The connection could not be saved. Check that Nova Collar's local profile is writable, then try again.";}
  }
  async function skip() {
    pendingCredential=null;
    try {const result=await window.pup.setupSkip();close(result?.state,"");}
    catch {body.textContent="The connection could not be saved. Check that Nova Collar's local profile is writable, then try again.";}
  }
  function close(state,note) {
    root.hidden=true;root.classList.remove("busy");if(note)window.noteSetup?.(note);window.afterSetup?.(state);
  }
  window.pup.on(event=>{if(event.type!=="setup-log")return;log.hidden=false;log.textContent+=`${event.line}\n`;log.scrollTop=log.scrollHeight;});
  window.openSetup=initial=>{pendingCredential=null;if(initial?.found){report=initial;found();}else scan();};
})();
