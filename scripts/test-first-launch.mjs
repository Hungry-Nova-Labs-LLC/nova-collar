// Real HTTP loopback fixtures and isolated child profiles. No installed model
// server, existing user profile, model download or inference service participates.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const project=fileURLToPath(new URL('..',import.meta.url));
const prelude=String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const project=process.env.NOVA_TEST_PROJECT;
const home=process.env.NOVAPUP_HOME;
const moduleUrl=relative=>pathToFileURL(path.join(project,relative));
const config=await import(moduleUrl('src/main/config.js'));
const setup=await import(moduleUrl('src/main/setup.js'));
const install=await import(moduleUrl('src/main/install.js'));
assert.equal(config.APP_HOME,home,'the fixture must never use an installed profile');
const origins=new Set(), servers=[], unexpectedNetwork=[];
const fetchCalls=[];
const realFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(String(input));
 if(!origins.has(url.origin)){unexpectedNetwork.push(url.origin);throw Error('Fixture blocked a request outside owned loopback servers.');}
 fetchCalls.push({path:url.pathname,method:options?.method||'GET',redirect:options?.redirect,authorization:options?.headers?.authorization||''});
 return realFetch(input,options);
};
async function server(handler){
 const requests=[];
 const listener=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks).toString('utf8');
  requests.push({path:req.url,method:req.method,authorization:req.headers.authorization||'',body});
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try{await handler(req,res,json,body);}catch(error){listener.fixtureError=error;res.writeHead(500);res.end('fixture failure');}
 });
 await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+listener.address().port;
 origins.add(url);servers.push(listener);
 return{url,requests,listener};
}
async function ollama({models=['fixture-chat'],loaded=[],capabilities={}}={}){
 return server((req,res,json,body)=>{
  if(req.url==='/api/tags')return json({models:models.map(name=>({name}))});
  if(req.url==='/api/ps')return json({models:loaded.map(name=>({name,model:name}))});
  if(req.url==='/api/show')return json({capabilities:capabilities[JSON.parse(body).model]||['completion']});
  if(req.url==='/v1/chat/completions'){
   const request=JSON.parse(body);assert(!Object.hasOwn(request,'tools'));assert(!Object.hasOwn(request,'tool_choice'));
   res.writeHead(200,{'content-type':'text/event-stream'});
   const gap=String.fromCharCode(10).repeat(2);
   res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'NOVA_FIRST_LAUNCH_READY'},finish_reason:null}]})+gap+'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+gap+'data: [DONE]'+gap);return;
  }
  json({},404);
 });
}
async function compatible({models=[{id:'fixture-chat'}],native=null,legacy=null}={}){
 return server((req,res,json)=>{
  if(req.url==='/v1/models')return json({data:models});
  if(req.url==='/api/v1/models')return native?json({models:native}):json({},404);
  if(req.url==='/api/v0/models')return legacy?json({data:legacy}):json({},404);
  json({},404);
 });
}
const probe=(fixture,name='Ollama',kind='ollama',extra={})=>({name,url:fixture.url,kind,...extra});
const scan=(probes,extra={})=>setup.scanLocalModels({cfg:config.loadConfig(),environment:{},probes,timeoutMs:150,...extra});
const envPath=path.join(home,'env');
function assertNoSavedConnection(){assert.equal(fs.existsSync(envPath),false);assert.equal(config.publicState().setupDone,false);}
function assertNoBackgroundInference(){
 for(const listener of servers)assert.equal(listener.fixtureError,undefined,listener.fixtureError?.message);
 assert.equal(unexpectedNetwork.length,0,'discovery must stay inside fixture-owned loopback servers');
 for(const call of fetchCalls){
  if(call.method==='POST')assert.equal(call.path,'/api/show','discovery cannot load, pull, generate or embed');
  assert.equal(call.redirect,'error','local discovery cannot follow a redirect off the configured endpoint');
 }
}
try{
`;
const after=String.raw`
}finally{
 globalThis.fetch=realFetch;
 for(const listener of servers){listener.closeAllConnections?.();await new Promise(resolve=>listener.close(resolve));}
}
`;

function isolated(code,{seed='',environment={}}={}){
 const home=mkdtempSync(join(tmpdir(),'nova-first-launch-'));
 try{
  if(seed)writeFileSync(join(home,'env'),seed,{mode:0o600});
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(?:HNL_|OLLAMA_|NOVA_LOCAL_|LM_STUDIO|OPENAI_)/.test(key))delete env[key];
  const result=spawnSync(process.execPath,['--input-type=module','-e',prelude+code+after],{
   cwd:project,encoding:'utf8',timeout:20_000,
   env:{...env,...environment,NOVAPUP_HOME:home,NOVA_TEST_PROJECT:project,ELECTRON_RUN_AS_NODE:'1'},
  });
  assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout||'Isolated first-launch fixture failed.');
 }finally{rmSync(home,{recursive:true,force:true});}
}

test('a factory profile has no invented model and is not ready before discovery',()=>isolated(`
 const cfg=config.loadConfig();
 assert.equal(cfg.localModel,'');assert.equal(cfg.hasExplicitConnection,false);
 assert.equal(config.publicState(cfg).ready,false);
 assertNoSavedConnection();
 const report=await scan([]);
 assert.equal(install.bootstrapConnection(report).mode,'none');
 assertNoSavedConnection();assertNoBackgroundInference();
`));

test('one served Ollama chat model auto-connects and the exact choice survives restart',()=>isolated(`
 const fixture=await ollama();const report=await scan([probe(fixture)]);
 const decision=install.bootstrapConnection(report);
 assert.equal(decision.mode,'auto');assert.equal(decision.selected.model,'fixture-chat');
 assert.equal(config.loadConfig().localUrl,fixture.url+'/v1');
 assert.equal(config.loadConfig().localModel,'fixture-chat');
 assert.equal(config.publicState().ready,true);assert.equal(config.publicState().setupDone,true);
 if(process.platform!=='win32')assert.equal(fs.statSync(envPath).mode&0o777,0o600);
 const before=fs.readFileSync(envPath);
 const restarted=spawnSync(process.execPath,['--input-type=module','-e',
  'const {loadConfig,publicState}=await import('+JSON.stringify(moduleUrl('src/main/config.js').href)+');const c=loadConfig();process.stdout.write(JSON.stringify({model:c.localModel,url:c.localUrl,ready:publicState(c).ready}));'
 ],{env:process.env,cwd:project,encoding:'utf8',timeout:5000});
 assert.equal(restarted.status,0,restarted.stderr);
 assert.deepEqual(JSON.parse(restarted.stdout),{model:'fixture-chat',url:fixture.url+'/v1',ready:true});
 assert.equal(install.bootstrapConnection({found:[]}).mode,'saved');
 assert(fs.readFileSync(envPath).equals(before));assertNoBackgroundInference();
`));

test('several available chat models require a choice and leave the profile untouched',()=>isolated(`
 const fixture=await ollama({models:['fixture-first','fixture-second']});
 const report=await scan([probe(fixture)]);
 assert.deepEqual(setup.localChatCandidates(report).map(row=>row.model).sort(),['fixture-first','fixture-second']);
 assert.equal(install.bootstrapConnection(report).mode,'choose');
 assertNoSavedConnection();assertNoBackgroundInference();
`));

test('two equally eligible servers do not silently select the first server',()=>isolated(`
 const a=await ollama({models:['fixture-a']}),b=await compatible({models:[{id:'fixture-b'}]});
 const report=await scan([probe(a),probe(b,'OpenAI-compatible','openai')]);
 assert.equal(install.bootstrapConnection(report).mode,'choose');
 assertNoSavedConnection();assertNoBackgroundInference();
`));

test('a uniquely loaded Ollama chat model takes priority over idle alternatives',()=>isolated(`
 const fixture=await ollama({models:['fixture-cold','fixture-hot'],loaded:['fixture-hot']});
 const report=await scan([probe(fixture)]);
 assert.equal(report.found[0].modelDetails.find(row=>row.id==='fixture-hot').loaded,true);
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-hot');
 assertNoBackgroundInference();
`));

test('LM Studio native metadata identifies a loaded chat model and excludes an embedding alias',()=>isolated(`
 const fixture=await compatible({models:[{id:'fixture-cold'},{id:'fixture-hot'},{id:'fixture-vector'}],native:[
  {key:'fixture-cold',type:'llm',loaded_instances:[]},
  {key:'fixture-hot',type:'llm',loaded_instances:[{id:'fixture-hot'}]},
  {key:'fixture-vector',type:'embedding',loaded_instances:[{id:'fixture-vector'}]},
 ]});
 const report=await scan([probe(fixture,'LM Studio','openai')]);
 assert(!setup.localChatCandidates(report).some(row=>row.model==='fixture-vector'));
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-hot');
 assertNoBackgroundInference();
`));

test('older LM Studio metadata remains usable when the native v1 endpoint is unavailable',()=>isolated(`
 const fixture=await compatible({models:[{id:'fixture-cold'},{id:'fixture-hot'}],legacy:[
  {id:'fixture-cold',type:'llm',state:'not-loaded'},
  {id:'fixture-hot',type:'llm',state:'loaded'},
 ]});
 const report=await scan([probe(fixture,'LM Studio','openai')]);
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-hot');
 assertNoBackgroundInference();
`));

test('embedding-only inventories cannot become automatic chat selections',()=>isolated(`
 const a=await ollama({models:['fixture-vector'],capabilities:{'fixture-vector':['embedding']}});
 const b=await compatible({models:[{id:'text-embedding-nomic-embed-text-v1.5'},{id:'embeddinggemma-2'}]});
 const report=await scan([probe(a),probe(b,'OpenAI-compatible','openai')]);
 assert.equal(setup.localChatCandidates(report).length,0);
 assert.equal(install.bootstrapConnection(report).mode,'none');
 assertNoSavedConnection();assertNoBackgroundInference();
`));

test('invalid IDs and control characters from a local catalog never become saved settings',()=>isolated(`
 const fixture=await compatible({models:[{id:''},{id:7},{id:'bad'+String.fromCharCode(10)+'model'},{id:'x'.repeat(513)},{id:'fixture-chat'}]});
 const report=await scan([probe(fixture,'OpenAI-compatible','openai')]);
 assert.deepEqual(setup.localChatCandidates(report).map(row=>row.model),['fixture-chat']);
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-chat');
 assertNoBackgroundInference();
`));

test('explicit loopback URL normalization rejects credentials, redirects-to-LAN configuration and nonlocal hosts',()=>isolated(`
 assert.equal(setup.normalizeLocalUrl('http://127.0.0.1:19123'),'http://127.0.0.1:19123/v1');
 assert.equal(setup.normalizeLocalUrl('0.0.0.0:19123',{binding:true}),'http://127.0.0.1:19123/v1');
 for(const url of ['http://192.0.2.8:19123','http://10.0.0.8:19123','http://127.0.0.1.evil.example:19123',
  'http://name:secret@127.0.0.1:19123','http://127.0.0.1:19123?token=fixture','http://127.0.0.1:19123/#fragment']){
  assert.equal(setup.normalizeLocalUrl(url),'',url);
 }
 assertNoSavedConnection();
`));

test('OLLAMA_HOST discovers a custom loopback port without guessing a model name',()=>isolated(`
 const fixture=await ollama();
 const report=await scan([],{environment:{OLLAMA_HOST:fixture.url.replace('127.0.0.1','0.0.0.0')}});
 assert.equal(install.bootstrapConnection(report).mode,'auto');
 assert.equal(config.loadConfig().localUrl,fixture.url+'/v1');
 assert.equal(config.loadConfig().localModel,'fixture-chat');
 assertNoBackgroundInference();
`));

test('an explicitly configured custom endpoint is preferred over unrelated local alternatives',()=>isolated(`
 const preferred=await ollama({models:['fixture-preferred']});
 const other=await ollama({models:['fixture-other'],loaded:['fixture-other']});
 const cfg={...config.loadConfig(),localUrl:preferred.url+'/v1',localUrlExplicit:true};
 const report=await scan([probe(other)],{cfg});
 assert(report.found.some(row=>row.url===preferred.url+'/v1'&&row.preferred));
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-preferred');
 assertNoBackgroundInference();
`));

test('an unavailable preferred endpoint does not silently switch to another local provider',()=>isolated(`
 const preferred=await server((req,res,json)=>json({},404));
 const alternative=await ollama({models:['fixture-alternative'],loaded:['fixture-alternative']});
 const cfg={...config.loadConfig(),localUrl:preferred.url+'/v1',localUrlExplicit:true};
 const report=await scan([probe(alternative)],{cfg});
 assert.equal(report.hasPreferredEndpoint,true);
 assert.equal(install.bootstrapConnection(report).mode,'choose');
 assertNoSavedConnection();assertNoBackgroundInference();
`));

test('saved hosted configuration wins over environment and local discovery without rewriting credentials',()=>isolated(`
 const before=fs.readFileSync(envPath);const fixture=await ollama();
 const report=await scan([probe(fixture)]);
 const cfg=config.loadConfig();assert.equal(cfg.model,'fixture-saved-model');
 assert.equal(cfg.chatUrl,'https://saved.example/v1');
 assert.equal(install.bootstrapConnection(report).mode,'saved');
 assert(fs.readFileSync(envPath).equals(before));
 assert(fixture.requests.every(row=>!row.authorization));
 assertNoBackgroundInference();
`,{seed:['HNL_CHAT_URL=https://saved.example/v1','HNL_MODEL=fixture-saved-model','HNL_CHAT_KEY=synthetic-profile-key',''].join(String.fromCharCode(10)),environment:{HNL_MODEL:'fixture-environment-model'}}));

test('an existing local model choice is kept even if a different server becomes available',()=>isolated(`
 const unavailable=await server((req,res,json)=>json({},404));
 fs.writeFileSync(envPath,['HNL_MODEL=local-3.8','OLLAMA_URL='+unavailable.url+'/v1','OLLAMA_MODEL=fixture-saved-local',''].join(String.fromCharCode(10)));
 const before=fs.readFileSync(envPath);const fixture=await ollama({models:['fixture-new']});
 const report=await scan([probe(fixture)]);
 assert.equal(install.bootstrapConnection(report).mode,'saved');
 assert.equal(config.loadConfig().localModel,'fixture-saved-local');
 assert(fs.readFileSync(envPath).equals(before));assertNoBackgroundInference();
`));

test('an authenticated local server is surfaced for manual connection and is not falsely auto-connected',()=>isolated(`
 const fixture=await server((req,res,json)=>json({error:'fixture authorization required'},401));
 const report=await scan([probe(fixture,'OpenAI-compatible','openai')]);
 assert(report.found.some(row=>row.authRequired===true));
 assert.equal(install.bootstrapConnection(report).mode,'none');
 assertNoSavedConnection();assertNoBackgroundInference();
`));

test('a local credential is scoped to its endpoint and never borrowed from hosted credentials',()=>isolated(`
 const own=await ollama(),other=await compatible({models:[{id:'fixture-other'}]});
 config.saveLocalModel({url:own.url+'/v1',model:'fixture-chat',apiKey:'synthetic-local-only-key'});
 const cfg=config.loadConfig();assert.equal(cfg.localKey,'synthetic-local-only-key');
 assert.equal(config.chatTarget(cfg).key,'synthetic-local-only-key');
 assert.equal(cfg.chatKey,'synthetic-hosted-only-key');
 await scan([probe(own),probe(other,'OpenAI-compatible','openai')],{cfg});
 assert(own.requests.length>0&&own.requests.every(row=>row.authorization==='Bearer synthetic-local-only-key'));
 assert(other.requests.every(row=>!row.authorization));
 assertNoBackgroundInference();
`,{seed:['HNL_CHAT_URL=https://saved.example/v1','HNL_MODEL=fixture-hosted','HNL_CHAT_KEY=synthetic-hosted-only-key',''].join(String.fromCharCode(10))}));

test('local discovery refuses redirects and times out a slow server without choosing it',()=>isolated(`
 const sink=await compatible();
 const redirect=await server((req,res)=>{res.writeHead(302,{location:sink.url+'/v1/models'});res.end();});
 const slow=await server(async(req,res,json)=>{await new Promise(resolve=>setTimeout(resolve,250));json({data:[{id:'fixture-late'}]});});
 const start=Date.now();
 const report=await scan([probe(redirect,'Redirect','openai'),probe(slow,'Slow','openai')],{timeoutMs:30});
 assert.equal(sink.requests.length,0);assert.equal(setup.localChatCandidates(report).length,0);
 assert.equal(install.bootstrapConnection(report).mode,'none');
 assert(Date.now()-start<2000);assertNoSavedConnection();assertNoBackgroundInference();
`));

test('the selected first-launch model reaches the actual streaming provider using only the loopback fixture',()=>isolated(`
 const fixture=await ollama();const report=await scan([probe(fixture)]);
 assert.equal(install.bootstrapConnection(report).mode,'auto');
 assertNoBackgroundInference();
 const cfg=config.loadConfig(),target=config.chatTarget(cfg);
 const {modelMetadata}=await import(moduleUrl('src/main/model-catalog.js'));
 assert.equal(modelMetadata(cfg,target).tools,false);
 assert.equal(modelMetadata(cfg,{...target,key:'synthetic-different-account-key'}),null);
 const {complete}=await import(moduleUrl('src/main/agent.js'));
 const reply=await complete([{role:'user',content:'Reply with the synthetic readiness marker.'}],cfg,()=>{},AbortSignal.timeout(5000),{predict:128,requestKind:'helper'});
 assert.equal(reply.content,'NOVA_FIRST_LAUNCH_READY');assert.equal(reply.tool_calls.length,0);
 const request=fixture.requests.find(row=>row.path==='/v1/chat/completions');
 assert.equal(JSON.parse(request.body).model,'fixture-chat');assert.equal(request.authorization,'Bearer ollama');
 assert.equal(unexpectedNetwork.length,0);
`));
