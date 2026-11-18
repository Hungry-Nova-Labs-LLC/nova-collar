// Guided primary chat models. The main process owns files, downloads, runtime,
// connection credentials and capability checks; the renderer passes model IDs.
(() => {
  const byId=id=>document.getElementById(id),panel=byId('local-chat-setup'),settings=byId('local-chat-settings');
  if(!panel||!window.pup?.localChatStatus){if(settings)settings.hidden=true;return;}
  const api=window.pup,cards=byId('local-chat-cards'),actions=byId('local-chat-actions'),message=byId('local-chat-status');
  const stages={downloading:'Downloading your chat model',verifying:'Verifying the download',copying:'Copying your model',importing:'Checking your GGUF file',
    loading:'Loading your model',starting:'Starting your local model',checking:'Checking chat and tools','checking-chat':'Checking chat','checking-tools':'Checking tool support',
    stopping:'Unloading the model',removing:'Removing the download',cancelling:'Cancelling setup'};
  const terminal=new Set(['idle','ready','running','installed','error','cancelled','stopped','not-installed']);
  let snapshot=null,requestPending=false,cancelPending=false,eventRevision=0,actionError='',previousFocus=null,previousInert=false;
  let returnToSetup=false,previousWakeHidden=true,primaryState=null,removeId=null,licenseLoaded=false,pendingSelectionId=null;
  const gb=bytes=>`${(bytes/1_000_000_000).toFixed(bytes>=10_000_000_000?0:2).replace(/\.00$/,'')} GB`;
  const bounded=value=>String(value||'').slice(0,260);
  const rows=()=>Array.isArray(snapshot?.models)?snapshot.models:[];
  const turnBusy=()=>Boolean(primaryState?.conversation?.active||primaryState?.conversation?.question);
  const operationBusy=()=>Boolean(snapshot?.busyId)||Boolean(snapshot?.stage&&!terminal.has(snapshot.stage));
  const busy=()=>requestPending||cancelPending||operationBusy();
  function button(label,fn,{primary=false,disabled=false}={}){
    const item=document.createElement('button');item.type='button';item.textContent=label;item.className=primary?'go':'';item.disabled=disabled;item.onclick=fn;return item;
  }
  function errorText(code){return ({
    'config-changed':'Your connection changed while the model was downloading. The download is kept. Choose Use model when you want to switch.',
    'active-turn':'Your current task is still running. Finish or stop it, then choose Use model. The download is kept.',
    'busy':'Another model operation is finishing. Please wait a moment.',
    'cancelled':'Setup was cancelled. You can retry when you are ready.',
    'unsupported-platform':'Local GGUF chat is not available for this computer yet. You can still connect an existing model server.',
    'unsupported-model':'This GGUF model could not be run by this version of Nova Collar. Your current connection is unchanged.',
    'invalid-gguf':'That file is not a supported GGUF model. Choose another file.',
    'gguf-invalid':'That file is not a supported GGUF model. Choose another file.',
    'gguf-header':'That file is not a supported GGUF model. Choose another file.',
    'model-too-large':'This file is larger than the supported model size. Choose a smaller GGUF file.',
    'unsupported-gguf':'This GGUF model is not compatible with this version of Nova Collar.',
    'missing-chat-template':'This GGUF file does not include a chat template. Choose a model prepared for chat.',
    'insufficient-free-memory':'There is not enough available memory right now. Close other apps, then try again.',
    'model-missing':'This model is not available on disk. Download or import it again.',
    'model-changed':'The stored model has changed. Import it again or retry its download.',
    'import-too-large':'This file is larger than the supported model size. Choose a smaller GGUF file.',
    'disk-space':'There is not enough free disk space. Free some space, then retry.',
    'insufficient-disk':'There is not enough free disk space. Free some space, then retry.',
    'insufficient-memory':'There is not enough available memory to load this model. Close other apps or choose a smaller model.',
    'memory-low':'Available memory is low. Close other apps or choose a smaller model.',
    'download-hash':'The downloaded file did not match its published checksum. Retry to get a verified copy.',
    'hash-mismatch':'The downloaded file did not match its published checksum. Retry to get a verified copy.',
    'download-unavailable':'The download could not finish. Check your internet connection, then retry.',
    'download-http':'The download is unavailable right now. Please try again later.',
    'download-not-published':'The model download is unavailable right now. Please try again later.',
    'download-timeout':'The download stopped making progress. Check your connection, then retry.',
    'runtime-unavailable':'The local model runtime is unavailable. Install a complete Nova Collar build, then try again.',
    'chat-check-failed':'This model did not pass the local chat check. Try another model. Your current connection is unchanged.',
    'tool-check-failed':'The model could not use tools in the local check. It may be available for chat only.',
    'not-installed':'Download this model or open a GGUF file before choosing Use model.',
    'model-selected':'Choose another model or return to your previous connection before removing this stored copy.',
    'model-not-local':'This is not a local chat model. Choose a downloaded or imported model.',
    'check-timeout':'The compatibility check took too long. Close other apps, then retry or choose a smaller model.',
    'model-active':'Unload this model before removing its stored copy.',
    'source-changed':'The selected file changed while it was being copied. Choose it again.',
  })[code]||'That step could not finish. Try again or choose another model. Your saved connection is kept.';}
  function apply(value){if(!value||typeof value!=='object')return;snapshot=value;render();}
  async function refresh(){
    const revision=eventRevision;
    try{const value=await api.localChatStatus();if(eventRevision===revision)apply(value?.status||value);return snapshot;}
    catch{return null;}
  }
  function recommendedId(){
    if(snapshot?.recommendedId)return snapshot.recommendedId;
    const memory=Number(snapshot?.memoryGB)||8;
    return rows().filter(r=>!r.imported&&Number.isFinite(r.minMemoryGB)&&r.minMemoryGB<=memory).sort((a,b)=>b.minMemoryGB-a.minMemoryGB)[0]?.id;
  }
  function render(){
    if(!snapshot)return;
    const selected=rows().find(row=>row.id===snapshot.activeModelId),working=operationBusy(),supported=snapshot.supported!==false;
    byId('local-chat-summary').textContent=selected?`On this computer · ${bounded(selected.label)}`:rows().some(r=>r.installed)?'Local models are downloaded and ready to use.':'Download a chat model or open a GGUF file. No model account needed.';
    if(panel.hidden)return;
    const focused=document.activeElement,focusedLabel=focused?.tagName==='BUTTON'?focused.textContent:null,focusedCard=focused?.closest?.('.local-chat-card')?.dataset.modelId;
    panel.dataset.stage=snapshot.stage||'idle';panel.setAttribute('aria-busy',String(busy()));
    const memory=Number.isFinite(snapshot.memoryGB)?snapshot.memoryGB:NaN,disk=Number.isFinite(snapshot.freeDiskBytes)?snapshot.freeDiskBytes:NaN;
    byId('local-chat-machine').textContent=[Number.isFinite(memory)&&memory>0?`${Math.round(memory)} GB memory`:null,
      Number.isFinite(disk)&&disk>=0?`${gb(disk)} free disk space`:'Free disk space will be checked'].filter(Boolean).join(' · ');
    const errorCode=snapshot.errorCode||(!supported?'unsupported-platform':'');
    message.textContent=actionError||(errorCode?errorText(errorCode):selected?(selected.loaded===false?'The selected model is unloaded. Its download is kept.':'Ready to chat on this computer.'):turnBusy()?'Downloads can finish in the background. Model changes wait until your current task is finished.':'');
    const wrap=byId('local-chat-progress-wrap'),progress=byId('local-chat-progress'),progressText=byId('local-chat-progress-text');
    wrap.hidden=!working;
    if(working){
      byId('local-chat-progress-stage').textContent=stages[snapshot.stage]||'Finishing model setup';
      const received=snapshot.progress?.receivedBytes,total=snapshot.progress?.totalBytes;
      if(snapshot.stage==='downloading'&&Number.isFinite(received)&&Number.isFinite(total)&&total>0){
        const percent=Math.max(0,Math.min(100,Math.floor(received/total*100)));progress.value=percent;progressText.textContent=`${percent}% · ${gb(received)} of ${gb(total)}`;
      }else{progress.removeAttribute('value');progressText.textContent=snapshot.stage==='checking'||snapshot.stage==='checking-tools'?'A small local test checks compatibility. This may take a moment.':'Please wait…';}
    }
    const recommended=recommendedId();cards.replaceChildren();
    for(const row of rows()){
      const card=document.createElement('article');card.className='local-chat-card';card.dataset.modelId=row.id;
      const active=row.id===snapshot.activeModelId||row.active===true,installed=row.installed===true,loaded=row.loaded??active;
      card.classList.toggle('current',active);card.classList.toggle('recommended',!row.imported&&(row.recommended===true||row.id===recommended));
      const head=document.createElement('div');head.className='local-chat-card-head';
      const title=document.createElement('h2');title.textContent=bounded(row.label)||'Imported GGUF model';head.append(title);
      const badge=document.createElement('span');badge.className='local-chat-badge';
      badge.textContent=active&&loaded?'In use':active?'Selected · unloaded':row.tools===false?'Chat only':row.imported?'Your GGUF':row.recommended===true||row.id===recommended?'Recommended':'Local chat';head.append(badge);card.append(head);
      const description=document.createElement('p');description.textContent=bounded(row.description)||'Your own local model. Compatibility is checked before use.';card.append(description);
      const size=row.asset?.bytes??row.bytes,info=document.createElement('p');info.className='local-chat-card-info';
      info.textContent=[Number.isFinite(size)?`${gb(size)} ${installed?'on disk':'download'}`:null,Number.isFinite(row.minMemoryGB)?`Best with ${row.minMemoryGB} GB memory`:null].filter(Boolean).join(' · ');card.append(info);
      const belowMemory=row.canFitMemory===false||Number.isFinite(memory)&&Number.isFinite(row.minMemoryGB)&&memory<row.minMemoryGB;
      let diskFit=row.canFitDisk!==false;
      if(!installed&&Number.isFinite(disk)&&Number.isFinite(size)&&disk<size+256*1024**2)diskFit=false;
      const note=document.createElement('p');note.className='local-chat-card-note';
      note.textContent=row.errorCode?errorText(row.errorCode):!installed&&!diskFit?'Free some disk space before downloading.':belowMemory?'Choose a smaller model for this computer. These setup choices keep room for Nova and your other apps.':row.tools===false?'Chat is available. This model has not qualified for Nova’s tools.':installed?'Stored on this computer. No download needed.':'';
      card.append(note);
      const controls=document.createElement('div');controls.className='local-chat-card-actions';
      if(removeId===row.id){
        const confirm=document.createElement('p');confirm.textContent=active?(snapshot.previousConnectionAvailable?'Remove this stored model and return Nova to your saved connection?':'Remove this stored model? Nova will need another chat model before it can answer.'):'Remove this stored model? You can add it again later.';if(row.imported)confirm.textContent+=' Your original GGUF file is kept.';controls.append(confirm);
        controls.append(button(active&&snapshot.previousConnectionAvailable?'Remove and return to previous connection':'Remove stored copy',()=>{removeId=null;void perform('remove',()=>api.localChatRemove(row.id),row.id);},{disabled:busy()||active&&loaded||turnBusy()}),button('Keep model',()=>{removeId=null;render();},{disabled:busy()}));
      }else{
        if(active&&loaded)controls.append(button('Unload',()=>perform('stop',()=>api.localChatStop()),{disabled:busy()||turnBusy()}));
        else if(installed)controls.append(button(active?'Load model':'Use model',()=>perform('use',()=>api.localChatUse(row.id),row.id),{primary:true,disabled:busy()||turnBusy()||belowMemory||!supported}));
        else controls.append(button(row.stage==='error'||row.stage==='cancelled'?'Retry download':'Download & use',()=>perform('install',()=>api.localChatInstall(row.id),row.id),{primary:true,disabled:busy()||!diskFit||belowMemory||!supported}));
        if(installed&&(!active||!loaded))controls.append(button('Remove',()=>{removeId=row.id;render();},{disabled:busy()}));
      }
      card.append(controls);cards.append(card);
    }
    byId('local-chat-import').disabled=busy()||!supported;
    actions.replaceChildren();
    if(working)actions.append(button(cancelPending?'Cancelling…':'Cancel setup',cancel,{disabled:cancelPending}));
    if(snapshot.previousConnectionAvailable)actions.append(button('Return to previous connection',()=>perform('restore',()=>api.localChatRestorePrevious()),{disabled:busy()||turnBusy()}));
    actions.append(button(working?'Continue in background':returnToSetup?'Back':'Done',()=>close(false),{primary:!working,disabled:cancelPending}));
    if(focusedLabel&&panel.contains(focused)===false&&!focused.isConnected){
      const scope=focusedCard?Array.from(cards.children).find(card=>card.dataset.modelId===focusedCard):actions;
      const replacement=Array.from(scope?.querySelectorAll('button')||[]).find(item=>item.textContent===focusedLabel&&!item.disabled);
      if(replacement)replacement.focus({preventScroll:true});else panel.focus({preventScroll:true});
    }
  }
  function close(selected=false){
    const wasOpen=!panel.hidden;
    panel.hidden=true;removeId=null;
    const workspace=byId('creature');if(wasOpen&&workspace)workspace.inert=previousInert;
    if(!selected&&returnToSetup){byId('setup').hidden=false;byId('wake').hidden=previousWakeHidden;}
    if(selected){byId('setup').hidden=true;returnToSetup=false;pendingSelectionId=null;}
    if(previousFocus?.isConnected&&!previousFocus.closest('[hidden]'))previousFocus.focus();
  }
  function updatePrimary(state,{selected=false}={}){
    if(!state)return;primaryState=state;
    if(selected)close(true);
    window.applyLocalChatState?.(state,selected);
  }
  async function perform(action,fn,id=null){
    if(requestPending||cancelPending)return;
    const removingSelection=action==='remove'&&id===snapshot?.activeModelId;
    if(action==='install'||action==='use')pendingSelectionId=id;
    requestPending=true;actionError='';const revision=eventRevision;render();
    try{
      const result=await fn();
      if(eventRevision===revision)apply(result?.status||result);
      if(result?.ok===false&&!result?.cancelled&&result?.errorCode!=='cancelled'&&!result?.status?.errorCode)actionError=errorText(result?.errorCode||'unavailable');
      const good=result?.ok===true&&!result?.status?.errorCode&&!['error','cancelled'].includes(result?.status?.stage);
      const removedSelection=good&&removingSelection&&result.state&&result.status?.activeModelId!==id;
      const selected=good&&!snapshot?.busyId&&result.state&&(action==='restore'&&!result.state.managedLocal
        ||(action==='use'||action==='install')&&result.state.ready&&result.state.managedLocal&&result.status?.activeModelId===id
        ||action==='import'&&result.state.ready&&result.state.managedLocal&&snapshot?.activeModelId&&snapshot.activeModelId===result.state.managedModelId);
      if(result?.ok===false||result?.status?.errorCode)pendingSelectionId=null;
      const state=result?.state?{...result.state,localChat:snapshot}:null;
      if(removedSelection)close(true);
      if(eventRevision===revision||selected||action==='stop'||action==='restore'||action==='remove')updatePrimary(state,{selected:Boolean(selected)});
      if(removedSelection&&!state.ready)window.openSetup?.(state.setupReport);
    }catch{pendingSelectionId=null;actionError='That action could not finish. Try again. Your saved connection is kept.';}
    finally{requestPending=false;render();}
  }
  async function cancel(){
    if(cancelPending)return;cancelPending=true;pendingSelectionId=null;actionError='';render();
    try{const result=await api.localChatCancel();apply(result?.status||result);updatePrimary(result?.state);}
    catch{actionError='Cancellation could not finish. Try again.';}
    finally{cancelPending=false;render();}
  }
  window.syncLocalChatState=state=>{primaryState=state;if(state?.localChat&&!requestPending&&!cancelPending)apply(state.localChat);else render();};
  window.openLocalChatSetup=async(options={})=>{
    actionError='';const current=await refresh();
    if(!current){byId('local-chat-summary').textContent='Local model settings could not be opened. Try again.';return;}
    if(panel.hidden){previousFocus=document.activeElement;const workspace=byId('creature');previousInert=Boolean(workspace?.inert);if(workspace)workspace.inert=true;}
    returnToSetup=Boolean(options.fromSetup&&!byId('setup').hidden);previousWakeHidden=byId('wake').hidden;
    byId('setup').hidden=true;byId('wake').hidden=true;panel.hidden=false;render();panel.focus();
    if(options.importFile){byId('local-chat-advanced').open=true;await perform('import',()=>api.localChatImport());}
  };
  byId('local-chat-open').onclick=()=>window.openLocalChatSetup();
  byId('local-chat-import').onclick=()=>perform('import',()=>api.localChatImport());
  byId('local-chat-license').addEventListener('toggle',async event=>{
    if(!event.target.open||licenseLoaded)return;
    try{const result=await api.localChatLicense();if(typeof result?.text==='string'&&result.text.length<=32768){byId('local-chat-license-text').textContent=result.text;licenseLoaded=true;}else throw new Error();}
    catch{byId('local-chat-license-text').textContent='The included license could not be read. Try opening this section again.';}
  });
  panel.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close(false);return;}
    if(event.key!=='Tab')return;
    const items=Array.from(panel.querySelectorAll('button:not(:disabled),summary')).filter(item=>item.getClientRects().length);
    if(!items.length)return;const first=items[0],last=items.at(-1);
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel)){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel)){event.preventDefault();first.focus();}
  });
  api.on?.(event=>{
    if(event.type==='local-chat'){
      eventRevision++;actionError='';apply(event.status||event);
      const selected=Boolean(pendingSelectionId&&event.state?.ready&&event.state?.managedLocal&&snapshot?.activeModelId===pendingSelectionId&&!snapshot.busyId&&['ready','running'].includes(snapshot.stage)&&!snapshot.errorCode);
      if(snapshot.errorCode)pendingSelectionId=null;
      updatePrimary(event.state?{...event.state,localChat:snapshot}:null,{selected});
    }
    if(event.type==='conversation'){primaryState={...primaryState,conversation:event};render();}
  });
  refresh();
})();
