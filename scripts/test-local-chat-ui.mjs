// Actual renderer/preload/IPC bridge; synthetic managers only. No downloads,
// model requests, shell children, owner profiles or provider credentials.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=fileURLToPath(new URL('..',import.meta.url));
if(!process.versions.electron){
  const home=mkdtempSync(join(tmpdir(),'nova-local-chat-ui-')),env={...process.env};
  for(const key of Object.keys(env))if(/^(?:HNL_|NOVA_|NP_|NOVAPUP_|APPLE_|CSC_|OPENAI_|SSH_|OLLAMA_)/.test(key)||/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/.test(key))delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;env.NOVA_LOCAL_CHAT_UI_HOME=home;
  const child=spawn(createRequire(import.meta.url)('electron'),[fileURLToPath(import.meta.url),...process.argv.slice(2)],{cwd:root,env,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
  await new Promise(done=>child.once('exit',(code,signal)=>{clearTimeout(timer);process.exitCode=signal?1:code??1;done();}));
  rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}else void(async()=>{
  const {app,BrowserWindow,ipcMain}=await import('electron');
  const {registerLocalChatIpc}=await import('../src/main/local-chat-ipc.js');
  const home=process.env.NOVA_LOCAL_CHAT_UI_HOME;assert(home?.startsWith(join(tmpdir(),'nova-local-chat-ui-')));
  app.setPath('userData',join(home,'electron'));app.setPath('sessionData',join(home,'electron'));
  globalThis.fetch=async()=>{throw new Error('Network disabled in local chat UI fixture');};
  const catalog=JSON.parse(readFileSync(join(root,'data/local-chat-models.json'),'utf8'));
  let local={supported:true,memoryGB:16,freeMemoryGB:10,freeDiskBytes:30_000_000_000,models:catalog.models.map(r=>({...r,bytes:r.asset.bytes,installed:false,active:false,loaded:false,canFitDisk:true})),
    activeModelId:'',previousConnectionAvailable:false,busyId:'',stage:'ready',progress:{receivedBytes:0,totalBytes:0}};
  let state={ready:false,setupDone:false,hasExplicitConnection:false,managedLocal:false,model:'',models:[],packs:[],os:process.platform,
    workdir:'/synthetic/project',session:{current:'fixture',chats:[]},messages:[],conversation:{active:false,paused:false,pending:[],question:null},setupReport:{found:[],decision:{mode:'none'}}};
  let listener,guard=()=>true,finishInstall,win,phase='startup',installCalls=0,checkCalls=0,stopCalls=0,removeCalls=0,importCalls=0,setupDoneCalls=0,licenseCalls=0;
  let externalModelCalls=0;
  let pickedFile='/synthetic/selected.gguf',adviserPrompted=false,holdUse=false,finishUse,selectImport=false;
  const safe=value=>JSON.parse(JSON.stringify(value));
  const snapshot=()=>safe({...state,localChat:local});
  const emit=patch=>{local={...local,...patch};listener?.({type:'local-chat',...safe(local)});};
  const select=id=>{local.activeModelId=id;local.models=local.models.map(r=>({...r,active:r.id===id,loaded:r.id===id}));state={...state,ready:true,setupDone:true,managedLocal:true,managedModelId:id,hasExplicitConnection:true,model:'local-gguf:'+id,localModelLabel:local.models.find(r=>r.id===id)?.label,
    models:[{id:'local-gguf:'+id,label:local.models.find(r=>r.id===id)?.label,managed:true,hint:'on this computer'}]};};
  const api={
    localChatStatus:()=>safe(local),setLocalChatGuard:fn=>{guard=fn;},onLocalChatStatus:fn=>{listener=fn;return()=>{listener=null;};},
    localChatInstall:async id=>{installCalls++;const stale=safe(local);emit({busyId:id,stage:'downloading',errorCode:'',progress:{receivedBytes:640417920,totalBytes:1280835840}});
      await new Promise(done=>{finishInstall=done;});return {ok:local.stage!=='cancelled'&&local.stage!=='error',status:safe(local),stale};},
    localChatCancel:async()=>{emit({stage:'cancelled',errorCode:'cancelled'});await delay(50);emit({busyId:''});finishInstall?.();return {ok:true,status:safe(local)};},
    localChatUse:async id=>{checkCalls++;assert(guard());if(holdUse){local.models=local.models.map(r=>({...r,loaded:r.id===id}));emit({busyId:id,stage:'running',errorCode:''});await new Promise(done=>{finishUse=done;});holdUse=false;}select(id);emit({busyId:'',stage:'running',errorCode:''});return {ok:true,status:safe(local)};},
    localChatStop:async()=>{stopCalls++;local.models=local.models.map(r=>({...r,loaded:false}));emit({stage:'ready'});return {ok:true,status:safe(local)};},
    localChatRemove:async id=>{removeCalls++;const selected=local.activeModelId===id;local.models=local.models.filter(r=>r.id!==id||!r.imported).map(r=>r.id===id?{...r,installed:false,active:false,loaded:false}:r);if(selected){local.activeModelId='';state={...state,managedLocal:false,ready:local.previousConnectionAvailable,model:local.previousConnectionAvailable?'fixture-provider':'',models:local.previousConnectionAvailable?[{id:'fixture-provider',label:'Fixture provider'}]:[]};}emit({stage:'ready'});return {ok:true,status:safe(local)};},
    localChatRestorePrevious:async()=>{local.activeModelId='';local.models=local.models.map(r=>({...r,active:false,loaded:false}));state={...state,ready:true,managedLocal:false,model:'fixture-provider',models:[{id:'fixture-provider',label:'Fixture provider'}]};emit({stage:'ready'});return {ok:true,status:safe(local)};},
    localChatImport:async()=>{importCalls++;local.models.push({id:'imported-fixture',label:'My imported model',bytes:1000,installed:true,imported:true,tools:false,minMemoryGB:4,active:false,loaded:false});select('imported-fixture');emit({stage:'running',busyId:''});return {ok:true,status:safe(local)};},
    localChatLicense:()=>{licenseCalls++;return {title:'Model license',text:'Synthetic Apache license <img src=x> is plain text.'};},
  };
  const d1Status=()=>({supported:true,stage:'not-installed',installed:false,enabled:false,firstRunPrompted:adviserPrompted});
  const until=async(fn,label)=>{for(let n=0;n<200;n++){if(await fn())return;await delay(15);}throw new Error('UI did not reach '+label);};
  const deadline=setTimeout(()=>{console.error('Local chat UI timed out during '+phase);app.exit(1);},35000);
  try{
    await app.whenReady();win=new BrowserWindow({width:1160,height:900,show:false,webPreferences:{preload:join(root,'src/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
    const send=event=>win.webContents.send('pup',event);
    registerLocalChatIpc({ipcMain,fromWindow:event=>event.sender===win.webContents,api,snapshot,send,canChange:()=>!state.conversation.active,pickFile:()=>pickedFile,markSetupDone:()=>{setupDoneCalls++;state.setupDone=true;}});
    for(const [name,fn]of Object.entries({'state':snapshot,'model':()=>{externalModelCalls++;return snapshot();},'models:scan':snapshot,'voice:read':()=>({text:'Fixture voice'}),'spec:read':()=>({text:''}),
      'decision-local:status':d1Status,'decision-local:defer':()=>{adviserPrompted=true;return d1Status();},'setup:scan':()=>({found:[],decision:{mode:'none'}})}))ipcMain.handle(name,fn);
    const js=code=>win.webContents.executeJavaScript(code);
    const click=async(label,id=null)=>{
      const selector=id?`.local-chat-card[data-model-id="${id}"] button`:'#local-chat-actions button';
      await until(()=>js(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`),'enabled action '+label);
      const result=await js(`(()=>{const b=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`);
      assert.equal(result,true,'Required enabled local-model button: '+label);
    };
    phase='first launch without a provider';await win.loadFile(join(root,'src/renderer/index.html'));
    await until(()=>js('!document.getElementById("setup").hidden && document.getElementById("setup-acts").textContent.includes("Download a chat model")'),'download-first choice');
    assert.equal(state.ready,false);assert.equal(await js('document.getElementById("decision-setup").hidden'),true);
    assert.deepEqual(await js('Array.from(document.querySelectorAll("#setup-acts > button")).map(b=>b.textContent)'),['Download a chat model','Connect a model I already use']);
    assert.equal(await js('document.getElementById("setup-more-options").open'),false);
    assert.equal(await js('Array.from(document.querySelectorAll("#setup-more-options button")).some(b=>b.textContent==="Connect manually")'),true);
    await js('Array.from(document.querySelectorAll("#setup-acts button")).find(b=>b.textContent==="Download a chat model").click()');
    await until(()=>js('!document.getElementById("local-chat-setup").hidden && document.querySelectorAll(".local-chat-card").length===3'),'three model cards');
    assert.equal(await js('document.querySelector(".local-chat-card.recommended").dataset.modelId'),'qwen35-4b-q4');
    assert.match(await js('document.getElementById("local-chat-machine").textContent'),/16 GB/);
    assert.equal(await js('document.querySelector(".local-chat-card[data-model-id=qwen35-9b-q4] button").disabled'),true,'below setup memory tier is disabled');
    assert.equal(await js('document.querySelectorAll("#local-chat-setup input[type=password]").length'),0);
    phase='byte progress and cancellation';await click('Download & use','qwen35-2b-q4');
    await until(()=>js('document.getElementById("local-chat-progress-text").textContent.startsWith("50%")'),'50% progress');
    assert.equal(state.ready,false);assert.equal(checkCalls,0);assert.equal(installCalls,1);
    phase='compact progress and keyboard focus';win.setSize(390,740);await delay(100);
    assert.equal(await js('(()=>{const p=document.getElementById("local-chat-setup"),b=Array.from(document.querySelectorAll("#local-chat-actions button")).find(b=>b.textContent==="Cancel setup"),r=b.getBoundingClientRect(),v=p.getBoundingClientRect();return p.scrollWidth<=p.clientWidth&&r.top>=v.top&&r.bottom<=v.bottom})()'),true,'compact Cancel remains visible without horizontal overflow');
    await js('document.getElementById("local-chat-setup").focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    assert.equal(await js('document.getElementById("local-chat-setup").contains(document.activeElement)'),true);
    await js('Array.from(document.querySelectorAll("#local-chat-actions button")).at(-1).focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    assert.equal(await js('document.getElementById("local-chat-setup").contains(document.activeElement)'),true,'Tab cycles inside modal');
    win.setSize(1160,900);await delay(80);
    phase='cancel acknowledgement';
    await click('Cancel setup');
    await until(()=>local.busyId===''&&local.stage==='cancelled','cancel barrier');
    await until(()=>js('!Array.from(document.querySelectorAll(".local-chat-card[data-model-id=qwen35-2b-q4] button")).find(b=>b.textContent==="Download & use").disabled'),'retry enabled after cancellation');
    phase='native qualification state before selection';await click('Download & use','qwen35-2b-q4');
    await until(()=>installCalls===2,'second explicit install');emit({stage:'checking',progress:{receivedBytes:1280835840,totalBytes:1280835840}});
    await until(()=>js('document.getElementById("local-chat-progress").hasAttribute("value")===false'),'indeterminate local check');
    local.models=local.models.map(r=>r.id==='qwen35-2b-q4'?{...r,installed:true}:r);select('qwen35-2b-q4');emit({stage:'running',busyId:'',errorCode:''});finishInstall?.();
    await until(()=>js('document.getElementById("local-chat-setup").hidden'),'local primary selected');
    await until(()=>js('!document.getElementById("decision-setup").hidden'),'adviser offered after primary connection');
    assert.equal(state.ready,true);assert.equal(state.model,'local-gguf:qwen35-2b-q4');
    assert.equal(await js('document.getElementById("model-btn").textContent'),'Qwen3.5 2B · Light');
    assert.equal(await js('document.getElementById("chat").textContent.includes("Choose a model to begin")'),false,'ephemeral setup notice updates after selection');
    assert.match(await js('document.getElementById("chat").textContent'),/Ready for your message/);assert.equal(await js('document.getElementById("setup").hidden'),true);
    await js('Array.from(document.querySelectorAll("#decision-setup-acts button")).find(b=>b.textContent==="Maybe later").click()');
    await until(()=>adviserPrompted,'adviser deferred');
    phase='settings and model picker re-entry';await js('document.getElementById("settings-btn").click();document.getElementById("local-chat-open").click()');
    await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'Settings model manager');
    await click('Unload','qwen35-2b-q4');await until(()=>stopCalls===1,'unload');
    await until(()=>js('document.querySelector(".local-chat-card[data-model-id=qwen35-2b-q4]").textContent.includes("Load model")'),'selected unloaded model');
    holdUse=true;await click('Load model','qwen35-2b-q4');await until(()=>checkCalls===1&&Boolean(finishUse),'explicit reload begins');
    assert.equal(local.stage,'running');assert.equal(local.busyId,'qwen35-2b-q4');
    assert.equal(await js('document.getElementById("local-chat-setup").hidden'),false,'existing selection stays open during runtime startup before qualification completes');
    assert.equal(await js('document.getElementById("creature").inert'),true,'workspace stays inert while the model check is pending');
    assert.equal(await js('document.getElementById("local-chat-import").disabled'),true,'other model actions remain disabled until qualification settles');
    emit({stage:'checking'});finishUse();
    await until(()=>js('document.getElementById("local-chat-setup").hidden'),'settled reload selection complete');
    assert.equal(local.busyId,'');assert.equal(local.stage,'running');assert.equal(await js('document.getElementById("creature").inert'),false);
    await js('document.getElementById("model-btn").click()');
    await until(()=>js('Boolean(document.getElementById("models-local-chat-open"))'),'model picker local entry');
    assert.equal(await js('Array.from(document.querySelectorAll(".lanes-pick option")).some(o=>o.value.startsWith("local-gguf:"))'),false,'managed models are excluded from provider lanes');
    assert.match(await js('document.querySelector("#models-list .model-active").textContent'),/On this computer · Qwen3.5 2B/);
    await js('document.querySelector("#models-list button[data-managed-model]").click()');assert.equal(externalModelCalls,0,'managed row opens its local picker rather than external setModel');await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'model picker manager');
    assert.equal(await js('document.getElementById("local-chat-import").disabled'),false,'model actions available after final completion');
    phase='import is native picker and chat-only capability is clear';
    await js('document.getElementById("local-chat-advanced").open=true;document.getElementById("local-chat-import").click()');
    await until(()=>importCalls===1&&local.models.some(r=>r.imported),'native import callback');
    await until(()=>js('document.getElementById("local-chat-setup").hidden'),'qualified import selects primary');
    await js('window.openLocalChatSetup()');await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'imported model controls');
    assert.match(await js('document.querySelector(".local-chat-card[data-model-id=imported-fixture]").textContent'),/Chat is available.*not qualified for Nova’s tools/,'chat-only import remains explicit while selected');
    await click('Unload','imported-fixture');
    await click('Remove','imported-fixture');assert.equal(removeCalls,0);
    await click('Keep model','imported-fixture');assert.equal(removeCalls,0);
    await click('Remove','imported-fixture');await click('Remove stored copy','imported-fixture');await until(()=>removeCalls===1,'remove stored copy only');
    await until(()=>js('!document.getElementById("setup").hidden'),'selected import removal returns to primary setup');
    await js('window.openLocalChatSetup({fromSetup:true})');await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'choose retained original');
    await click('Use model','qwen35-2b-q4');await until(()=>js('document.getElementById("local-chat-setup").hidden'),'original selection restored explicitly');
    await js('window.openLocalChatSetup()');await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'model manager for license');
    phase='license is offline text and resource constraints are visible';
    await js('document.getElementById("local-chat-license").open=true');await until(()=>licenseCalls===1,'license API');
    assert.equal(await js('document.querySelectorAll("#local-chat-license-text img").length'),0);
    assert.match(await js('document.getElementById("local-chat-license-text").textContent'),/<img/);
    emit({freeDiskBytes:1});await until(()=>js('document.querySelector(".local-chat-card[data-model-id=qwen35-9b-q4]").textContent.includes("Free some disk space")'),'disk guidance');
    assert.equal(await js('document.querySelector(".local-chat-card[data-model-id=qwen35-9b-q4] button").disabled'),true);
    emit({freeDiskBytes:30_000_000_000,errorCode:'unavailable',error:'PRIVATE_PATH_OR_KEY<img src=x>'});
    assert.equal(await js('document.getElementById("local-chat-setup").textContent.includes("PRIVATE_PATH_OR_KEY")'),false);
    emit({errorCode:'',previousConnectionAvailable:true});
    phase='restore preserves provider path';await click('Return to previous connection');
    await until(()=>!state.managedLocal&&state.model==='fixture-provider','previous connection restored');
    assert.equal(await js('document.getElementById("local-chat-setup").hidden'),true);
    await js('window.openLocalChatSetup()');await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'manager reopened');
    phase='explicit selected removal can return to saved provider';
    await click('Use model','qwen35-2b-q4');await until(()=>js('document.getElementById("local-chat-setup").hidden'),'reselect local');
    await js('window.openLocalChatSetup()');await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'selected manager');
    await click('Unload','qwen35-2b-q4');await until(()=>js('document.querySelector(".local-chat-card[data-model-id=qwen35-2b-q4]").textContent.includes("Load model")'),'unloaded selected');
    await click('Remove','qwen35-2b-q4');assert.match(await js('document.querySelector(".local-chat-card[data-model-id=qwen35-2b-q4]").textContent'),/saved connection/);
    await click('Remove and return to previous connection','qwen35-2b-q4');await until(()=>!state.managedLocal&&state.model==='fixture-provider','explicit return on removal');
    assert.equal(await js('document.getElementById("local-chat-setup").hidden'),true);
    phase='only local model can be removed without downloading a replacement';
    local.models=local.models.map(r=>r.id==='qwen35-2b-q4'?{...r,installed:true,loaded:false}:r);local.previousConnectionAvailable=false;select('qwen35-2b-q4');local.models=local.models.map(r=>({...r,loaded:false}));
    await js('window.openLocalChatSetup()');await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'only model manager');
    await click('Remove','qwen35-2b-q4');assert.match(await js('document.querySelector(".local-chat-card[data-model-id=qwen35-2b-q4]").textContent'),/need another chat model/);
    await click('Remove stored copy','qwen35-2b-q4');await until(()=>!state.ready&&!state.managedLocal,'no fallback after only-model removal');
    await until(()=>js('!document.getElementById("setup").hidden'),'connection setup reopened');
    emit({freeDiskBytes:null});await js('window.openLocalChatSetup({fromSetup:true})');
    await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'final model choices');
    assert.equal(await js('document.getElementById("local-chat-machine").textContent.includes("0 GB free")'),false);
    const screenshot=process.argv.find(x=>x.startsWith('--screenshot='))?.slice(13);if(screenshot){await delay(150);writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());}
    win.setSize(390,740);await delay(100);assert.equal(await js('document.getElementById("local-chat-setup").scrollWidth<=document.getElementById("local-chat-setup").clientWidth'),true);
    assert.equal(await js('(()=>{const p=document.getElementById("local-chat-setup"),b=document.querySelector("#local-chat-actions button"),r=b.getBoundingClientRect(),v=p.getBoundingClientRect();return r.bottom<=v.bottom})()'),true,'compact footer stays reachable');
    phase='first-launch import selects primary and offers adviser once';
    win.setSize(1160,900);adviserPrompted=false;selectImport=true;
    state={...state,ready:false,setupDone:false,managedLocal:false,managedModelId:'',model:'',models:[],hasExplicitConnection:false};
    state.messages=[{role:'user',content:'Saved user message stays.'},{role:'assistant',content:'Choose a model to begin. This is saved conversation text.'}];
    local.activeModelId='';local.models=local.models.filter(r=>!r.imported).map(r=>({...r,active:false,loaded:false}));
    await win.loadFile(join(root,'src/renderer/index.html'));
    await until(()=>js('!document.getElementById("setup").hidden'),'fresh provider-free import setup');
    await js('window.__qaAdviserOffers=0;new MutationObserver(()=>{if(!document.getElementById("decision-setup").hidden)window.__qaAdviserOffers++}).observe(document.getElementById("decision-setup"),{attributes:true,attributeFilter:["hidden"]});undefined');
    await js('Array.from(document.querySelectorAll("#setup-acts > button")).find(b=>b.textContent==="Download a chat model").click()');
    await until(()=>js('!document.getElementById("local-chat-setup").hidden'),'first-launch import picker');
    await js('document.getElementById("local-chat-advanced").open=true;document.getElementById("local-chat-import").click()');
    await until(()=>js('document.getElementById("local-chat-setup").hidden'),'successful import closes picker');
    assert(state.ready&&state.managedLocal);assert.equal(state.managedModelId,'imported-fixture');
    assert.match(await js('document.getElementById("chat").textContent'),/Saved user message stays/);
    assert.match(await js('document.getElementById("chat").textContent'),/Choose a model to begin. This is saved conversation text/,'saved assistant history is never rewritten by setup readiness');
    assert.equal(await js('document.getElementById("setup").hidden'),true,'successful first-launch import does not reopen primary setup');
    await until(()=>js('!document.getElementById("decision-setup").hidden'),'adviser offer follows imported primary');
    assert.equal(await js('window.__qaAdviserOffers'),1);
    await js('Array.from(document.querySelectorAll("#decision-setup-acts button")).find(b=>b.textContent==="Maybe later").click()');
    await until(()=>adviserPrompted,'import adviser deferred');
    await js('(async()=>{await window.maybeOfferDecisionSetup(await window.pup.state());})()');await delay(30);
    assert.equal(await js('document.getElementById("decision-setup").hidden'),true);assert.equal(await js('window.__qaAdviserOffers'),1,'one optional adviser offer');
    assert.deepEqual(errors,[]);assert(setupDoneCalls>=1);
    console.log('PASS local chat UI: real renderer/preload/IPC; provider-free onboarding, three cards, progress/cancel, primary-before-adviser, Settings/model picker, unload/reload, chat-only import, remove confirmation, offline license, disk fit, safe errors, and restore; zero downloads/model requests');
  }catch(error){console.error('Local chat UI failure during '+phase+':',error);process.exitCode=1;}
  finally{clearTimeout(deadline);finishInstall?.();win?.destroy();app.exit(process.exitCode||0);}
})();
