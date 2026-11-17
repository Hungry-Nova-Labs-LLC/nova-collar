// Real Electron main/preload/renderer first-launch scenarios. Each child gets
// temporary Nova/browser storage and a temporary shell HOME; provider I/O is synthetic.
// Electron retains its OS-provided HOME so native framework shutdown works.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const require=createRequire(import.meta.url);
const project=fileURLToPath(new URL('..',import.meta.url));
const scenario=process.env.NOVA_FIRST_LAUNCH_SCENARIO;
const scenarioNames=['auto','multiple','none','saved','auth'];

function isolatedEnvironment(home,selected){
 const env={...process.env};
 for(const key of Object.keys(env)){
  if(/^(?:HNL_|OLLAMA_|NOVA_LOCAL_|LM_STUDIO|OPENAI_|APPLE_|SSH_AUTH_SOCK$|SSH_AGENT_PID$)/.test(key)
    || /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/.test(key))delete env[key];
 }
 delete env.ELECTRON_RUN_AS_NODE;
 return{...env,NOVA_FIRST_LAUNCH_SCENARIO:selected,NOVA_FIRST_LAUNCH_HOME:home,
  NOVAPUP_HOME:join(home,'settings'),NP_LAYA_MODEL:join(home,'no-optional-model'),
  ZDOTDIR:home,XDG_CONFIG_HOME:join(home,'config'),
  APPDATA:join(home,'app-data'),SHELL:process.platform==='win32'?env.SHELL:'/bin/sh'};
}

async function orchestrate(){
 const electron=require('electron');
 const runtime=typeof electron==='string'?electron:process.execPath;
 const selectedScenarios=process.env.NOVA_FIRST_LAUNCH_ONLY?scenarioNames.filter(name=>name===process.env.NOVA_FIRST_LAUNCH_ONLY):scenarioNames;
 assert(selectedScenarios.length,'Unknown requested first-launch scenario.');
 for(const selected of selectedScenarios){
  const home=mkdtempSync(join(tmpdir(),'nova-first-launch-app-'));
  try{
   const result=await new Promise((resolve,reject)=>{
    const child=spawn(runtime,[fileURLToPath(import.meta.url)],{cwd:project,env:isolatedEnvironment(home,selected),stdio:'inherit'});
    const marker=join(home,'first-launch-passed.json');
    let quitDeadline;
    const finished=()=>{try{const value=JSON.parse(readFileSync(marker,'utf8'));return value.passed===true&&value.scenario===selected;}catch{return false;}};
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('First-launch Electron scenario timed out: '+selected));},45_000);
    // Successful assertions also require an ordinary app.quit() exit. A forced
    // cleanup is reserved for failures and must never count as a passing test.
    const poll=setInterval(()=>{if(finished()&&!quitDeadline)quitDeadline=setTimeout(()=>{
     child.kill('SIGKILL');reject(Error('First-launch Electron did not quit normally: '+selected));
    },6000);},100);
    const clear=()=>{clearTimeout(timer);clearInterval(poll);clearTimeout(quitDeadline);};
    child.once('error',error=>{clear();reject(error);});
    child.once('exit',(code,signal)=>{clear();resolve(code===0&&!signal&&finished()?0:1);});
   });
   assert.equal(result,0,'First-launch Electron scenario failed: '+selected);
  }finally{rmSync(home,{recursive:true,force:true});}
 }
 console.log('PASS first launch: actual Electron main/preload/renderer auto-connect, all-model choice, no-provider state, saved profile, and local API-key flow');
 if(process.versions.electron)electron.app.exit(0);
}

async function runScenario(){
 assert(scenarioNames.includes(scenario),'Unknown first-launch fixture scenario.');
 const {app,BrowserWindow}=require('electron');
 const home=process.env.NOVA_FIRST_LAUNCH_HOME;
 assert(home&&process.env.NOVAPUP_HOME===join(home,'settings'));
 mkdirSync(join(home,'app-data'),{recursive:true});
 mkdirSync(process.env.NOVAPUP_HOME,{recursive:true});
 app.setPath('appData',join(home,'app-data'));
 app.setPath('userData',join(home,'electron'));
 app.setPath('sessionData',join(home,'electron'));
 const fatal=error=>{console.error('FIRST_LAUNCH_FIXTURE_FAILURE',scenario,error);app.exit(1);};
 process.on('uncaughtException',fatal);process.on('unhandledRejection',fatal);
 const calls=[];
 const json=(value,status=200)=>Response.json(value,{status});
 globalThis.fetch=async(input,options={})=>{
  const url=new URL(String(input));
  const authorization=options.headers?.authorization||'';
  calls.push({host:url.hostname,port:url.port,path:url.pathname,method:options.method||'GET',authorization});
  if(url.hostname==='saved.fixture.invalid'){
   assert.equal(scenario,'saved');assert.equal(url.pathname,'/v1/models');
   assert.equal(authorization,'Bearer synthetic-saved-key');
   return json({data:[{id:'fixture-saved',type:'chat'}]});
  }
  assert.equal(url.hostname,'127.0.0.1','Fixture blocks every non-loopback provider request.');
  assert(['11434','1234','8080','8000'].includes(url.port));
  assert.equal(options.redirect,'error');
  assert(options.method!=='POST'||url.pathname==='/api/show','Discovery must never load, download, generate or embed.');
  if(scenario==='auth'&&url.port==='1234'){
   if(authorization!=='Bearer synthetic-local-key')return json({error:'API key required'},401);
   if(url.pathname==='/v1/models')return json({data:[{id:'fixture-protected'},{id:'text-embedding-nomic-embed-text-v1.5'}]});
   if(url.pathname==='/api/v1/models')return json({models:[
    {key:'fixture-protected',type:'llm',loaded_instances:[],capabilities:{trained_for_tool_use:false}},
    {key:'text-embedding-nomic-embed-text-v1.5',type:'embedding',loaded_instances:[]},
   ]});
   return json({},404);
  }
  assert.equal(authorization,'','A local credential must never be broadcast to a different server.');
  if((scenario==='auto'||scenario==='multiple')&&url.port==='11434'){
   if(url.pathname==='/api/tags')return json({models:(scenario==='auto'?['fixture-auto']:['fixture-first','fixture-second','fixture-vector']).map(name=>({name}))});
   if(url.pathname==='/api/ps')return json({models:[]});
   if(url.pathname==='/api/show'){
    const name=JSON.parse(options.body).model;
    return json({capabilities:name==='fixture-vector'?['embedding']:['completion']});
   }
  }
  if(scenario==='multiple'&&url.port==='1234'){
   if(url.pathname==='/v1/models')return json({data:[{id:'fixture-third'},{id:'text-embedding-nomic-embed-text-v1.5'}]});
   if(url.pathname==='/api/v1/models')return json({models:[
    {key:'fixture-third',type:'llm',loaded_instances:[],capabilities:{trained_for_tool_use:false}},
    {key:'text-embedding-nomic-embed-text-v1.5',type:'embedding',loaded_instances:[]},
   ]});
  }
  return json({},404);
 };
 const envPath=join(process.env.NOVAPUP_HOME,'env');
 let savedBytes;
 if(scenario==='saved'){
  writeFileSync(envPath,['HNL_CHAT_URL=https://saved.fixture.invalid/v1','HNL_MODEL=fixture-saved','HNL_CHAT_KEY=synthetic-saved-key',''].join('\n'),{mode:0o600});
  savedBytes=readFileSync(envPath);
 }
 const cwd=join(home,'project');mkdirSync(cwd);
 writeFileSync(join(process.env.NOVAPUP_HOME,'workdir.json'),JSON.stringify({path:cwd}));
 const deadline=setTimeout(()=>fatal(Error('First-launch scenario deadline exceeded.')),30_000);
 const until=async(fn,label)=>{
  for(let i=0;i<500;i++){if(await fn())return;await delay(30);}
  console.error('FIRST_LAUNCH_WAIT_STATE',JSON.stringify({scenario,label,appReady:app.isReady(),windows:BrowserWindow.getAllWindows().map(window=>({destroyed:window.isDestroyed(),loading:window.webContents.isLoading()})),calls:calls.map(({port,path,method})=>({port,path,method}))}));
  throw Error('Timed out waiting for '+label);
 };
 try{
  const config=await import('../src/main/config.js');
  assert.equal(config.APP_HOME,process.env.NOVAPUP_HOME);
  const nativePty=require('node-pty'),originalSpawn=nativePty.spawn;
  // Only fixture-owned shell children get the temporary HOME. This keeps login
  // shells away from real profiles while preserving Electron's native OS HOME.
  nativePty.spawn=(file,args,options)=>originalSpawn(file,args,{...options,env:{...options.env,HOME:home,USERPROFILE:home,ZDOTDIR:home}});
  await import('../src/main/index.js');
  await until(()=>BrowserWindow.getAllWindows().some(win=>!win.webContents.isLoading()),'real main window');
  const win=BrowserWindow.getAllWindows()[0],js=body=>win.webContents.executeJavaScript(body);
  const ui=fn=>js('('+fn.toString()+')()');
  await until(()=>js('Boolean(window.pup&&window.openSetup&&window.afterSetup)'),'real preload and renderer setup');
  await until(()=>win.isVisible(),'native window visibility');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

  const state=()=>js('window.pup.state()');
  if(scenario==='auto'){
   await until(()=>js('document.getElementById("setup").hidden'),'automatic setup dismissal');
   const current=await state();
   assert.equal(current.ready,true);assert.equal(current.localModel,'fixture-auto');
   assert.equal(current.setupReport.decision.mode,'auto');assert.equal(current.setupDone,true);
   assert.equal(config.loadConfig().localModel,'fixture-auto');
   assert.equal(await js('document.getElementById("wake").hidden'),true);
  }else if(scenario==='multiple'){
   await until(()=>js('!document.getElementById("setup").hidden&&document.querySelectorAll("#setup-list button").length===3'),'all model choices');
   const text=await js('document.getElementById("setup-list").textContent');
   for(const model of ['fixture-first','fixture-second','fixture-third'])assert(text.includes(model));
   assert(!text.includes('fixture-vector'));assert(!text.includes('nomic'));
   assert.equal((await state()).ready,false);assert.equal(config.loadConfig().localModel,'');
   await js('Array.from(document.querySelectorAll("#setup-list button")).find(button=>button.textContent.includes("fixture-second")).click()');
   await until(()=>js('document.getElementById("setup").hidden'),'manual model selection');
   assert.equal(config.loadConfig().localModel,'fixture-second');assert.equal((await state()).ready,true);
  }else if(scenario==='none'){
   await until(()=>js('!document.getElementById("setup").hidden&&document.getElementById("setup-acts").textContent.includes("Connect manually")'),'no-provider guidance');
   const current=await state();assert.equal(current.ready,false);assert.equal(current.localModel,'');
   const labels=await js('Array.from(document.querySelectorAll("#setup-acts button")).map(button=>button.textContent)');
   for(const label of ['Scan again','Connect manually','Choose another provider'])assert(labels.includes(label));
   assert.equal(current.setupReport.decision.mode,'none');
  }else if(scenario==='saved'){
   await until(()=>js('document.getElementById("setup").hidden'),'saved connection setup dismissal');
   const current=await state();assert.equal(current.model,'fixture-saved');assert.equal(current.ready,true);
   assert.equal(current.setupReport.decision.mode,'saved');assert(readFileSync(envPath).equals(savedBytes));
  }else if(scenario==='auth'){
   await until(()=>js('!document.getElementById("setup").hidden&&document.getElementById("setup-list").textContent.includes("API key required")'),'authenticated server prompt');
   assert.equal((await state()).ready,false);
   await js('Array.from(document.querySelectorAll("#setup-list button")).find(button=>button.textContent.includes("API key required")).click()');
   await until(()=>ui(()=>Boolean(document.querySelector('input[aria-label="API key (optional)"]'))),'manual API key field');
   assert.equal(await ui(()=>document.querySelector('input[aria-label="Local server URL"]').value),'http://127.0.0.1:1234/v1');
   await ui(()=>{document.querySelector('input[aria-label="API key (optional)"]').value='synthetic-local-key';Array.from(document.querySelectorAll('#setup-acts button')).find(button=>button.textContent==='Find models and connect').click();});
   await until(()=>js('document.getElementById("setup").hidden'),'authenticated model selection');
   const cfg=config.loadConfig();assert.equal(cfg.localModel,'fixture-protected');assert.equal(cfg.localKey,'synthetic-local-key');
   assert.equal(cfg.localUrl,'http://127.0.0.1:1234/v1');assert.equal((await state()).ready,true);
   assert(calls.filter(row=>row.authorization==='Bearer synthetic-local-key').every(row=>row.port==='1234'));
   const unchanged=await ui(()=>window.pup.setupUse({url:'http://127.0.0.1:1234/v1',model:'fixture-protected'}));
   assert.equal(unchanged.ok,true);assert.equal(config.loadConfig().localKey,'synthetic-local-key','omitting a key preserves the chosen endpoint credential');
   const cleared=await ui(()=>window.pup.setupUse({url:'http://127.0.0.1:1234/v1',model:'fixture-protected',apiKey:''}));
   assert.equal(cleared.ok,true);assert.equal(config.loadConfig().localKey,'','an explicit blank key clears a mistaken credential');
   assert.equal((await ui(()=>window.pup.setupUse({url:'http://127.0.0.1:1234/v1',model:'fixture-protected',apiKey:'synthetic-local-key'}))).ok,true);
   if(process.platform!=='win32'&&process.getuid?.()!==0){
    const before=readFileSync(envPath);chmodSync(envPath,0o400);
    try{
     await ui(()=>window.openSetup({found:[{name:'LM Studio',url:'http://127.0.0.1:1234/v1',models:['fixture-protected']}]}));
     await ui(()=>Array.from(document.querySelectorAll('#setup-list button')).find(button=>button.textContent.includes('fixture-protected')).click());
     await until(()=>ui(()=>document.getElementById('setup-body').textContent.includes('writable')),'recoverable profile permission error');
     const message=await ui(()=>document.getElementById('setup-body').textContent);
     assert(!message.includes(home)&&!message.includes('synthetic-local-key')&&!/EACCES|permission denied/.test(message));
     assert(readFileSync(envPath).equals(before),'a failed profile write must preserve the previous configuration bytes');
    }finally{chmodSync(envPath,0o600);}
    await ui(()=>Array.from(document.querySelectorAll('#setup-list button')).find(button=>button.textContent.includes('fixture-protected')).click());
    await until(()=>ui(()=>document.getElementById('setup').hidden),'connection retry after profile permission recovery');
    assert.equal(config.loadConfig().localKey,'synthetic-local-key');
   }

  }
  assert(calls.every(row=>row.method!=='POST'||row.path==='/api/show'));
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'setup must fit horizontally');
  if(process.env.NOVA_FIRST_LAUNCH_SCREENSHOT_DIR){
   mkdirSync(process.env.NOVA_FIRST_LAUNCH_SCREENSHOT_DIR,{recursive:true});
   writeFileSync(join(process.env.NOVA_FIRST_LAUNCH_SCREENSHOT_DIR,scenario+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  writeFileSync(join(home,'first-launch-passed.json'),JSON.stringify({scenario,passed:true}));
  console.log('PASS first-launch Electron scenario: '+scenario);
  clearTimeout(deadline);app.once('quit',()=>console.log('PASS normal app.quit: '+scenario));app.quit();
 }catch(error){clearTimeout(deadline);fatal(error);}
}

if(scenario)void runScenario().catch(error=>{console.error(error);require('electron').app.exit(1);});
else void orchestrate().catch(error=>{
 console.error(error);
 if(process.versions.electron)require('electron').app.exit(1);
 else process.exitCode=1;
});
