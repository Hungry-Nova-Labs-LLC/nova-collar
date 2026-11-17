// Adversarial install/recovery contracts: actual loopback HTTP, synthetic keys,
// disposable profiles, and a network guard. Never uses an installed app profile.
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
const home=process.env.NOVAPUP_HOME,project=process.env.NOVA_ABUSE_PROJECT;
const moduleUrl=relative=>pathToFileURL(path.join(project,relative)).href;
const config=await import(moduleUrl('src/main/config.js'));
const setup=await import(moduleUrl('src/main/setup.js'));
const install=await import(moduleUrl('src/main/install.js'));
assert.equal(config.APP_HOME,home);
const owned=new Set(),servers=[],outbound=[],calls=[];
const realFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(String(input));
 if(!owned.has(url.origin)){outbound.push(url.origin);throw Error('Fixture prevented an unowned network request');}
 calls.push({path:url.pathname,method:options?.method||'GET',redirect:options?.redirect});
 return realFetch(input,options);
};
async function server(handler,{host='127.0.0.1'}={}){
 const requests=[];
 const listener=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks).toString('utf8');
  requests.push({path:req.url,method:req.method,authorization:req.headers.authorization||'',body});
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try{await handler(req,res,json,body);}catch(error){listener.fixtureError=error;res.writeHead(500);res.end('synthetic fixture error');}
 });
 await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,host,resolve);});
 const url='http://'+(host.includes(':')?'['+host+']':host)+':'+listener.address().port;owned.add(url);servers.push(listener);
 return {url,requests,listener};
}
async function stop(fixture){fixture.listener.closeAllConnections?.();await new Promise(resolve=>fixture.listener.close(resolve));}
const probe=(fixture,name='Fixture',kind='openai')=>({url:fixture.url,name,kind});
const scan=(probes,extra={})=>setup.scanLocalModels({cfg:config.loadConfig(),environment:{},probes,timeoutMs:100,...extra});
const envFile=path.join(home,'env');
function untouched(){assert.equal(fs.existsSync(envFile),false);assert.equal(config.publicState().setupDone,false);}
function safeDiscovery(){
 assert.equal(outbound.length,0,'no outside request may be attempted');
 for(const fixture of servers)assert.equal(fixture.fixtureError,undefined,fixture.fixtureError?.message);
 for(const call of calls){assert.equal(call.redirect,'error');if(call.method==='POST')assert.equal(call.path,'/api/show','discovery cannot infer or download');}
}
function noKey(value,key){assert(!JSON.stringify(value).includes(key),'a synthetic credential leaked into a public result');}
function stream(res,marker='NOVA_ABUSE_RECOVERED'){
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.end('data: '+JSON.stringify({choices:[{delta:{content:marker},finish_reason:null}]})+'\n\n'+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n'+'data: [DONE]\n\n');
}
try{
`;
const after=String.raw`
}finally{
 globalThis.fetch=realFetch;
 for(const fixture of servers){fixture.closeAllConnections?.();if(fixture.listening)await new Promise(resolve=>fixture.close(resolve));}
}
`;
function isolated(code,{seed='',files={}}={}){
 const home=mkdtempSync(join(tmpdir(),'nova-abuse-'));
 try{
  if(seed)writeFileSync(join(home,'env'),seed,{mode:0o600});
  for(const [file,value]of Object.entries(files))writeFileSync(join(home,file),value,{mode:0o600});
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(?:HNL_|OLLAMA_|NOVA_LOCAL_|LM_STUDIO|OPENAI_|NP_LAYA)/.test(key))delete env[key];
  const result=spawnSync(process.execPath,['--input-type=module','-e',prelude+code+after],{
   cwd:project,encoding:'utf8',timeout:15_000,
   env:{...env,NOVAPUP_HOME:home,NOVA_ABUSE_PROJECT:project,ELECTRON_RUN_AS_NODE:'1'},
  });
  assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout||'Isolated abuse fixture failed');
 }finally{rmSync(home,{recursive:true,force:true});}
}

test('a missing server can be started later and rescanned without restarting the app',()=>isolated(`
 const fixture=await server((req,res,json)=>json({data:[{id:'fixture-retry'}]}));
 const url=fixture.url;await stop(fixture);
 const first=await scan([{url,name:'Stopped server',kind:'openai'}]);
 assert.equal(install.bootstrapConnection(first).mode,'none');untouched();
 await new Promise(resolve=>fixture.listener.listen(Number(new URL(url).port),'127.0.0.1',resolve));
 const next=await scan([probe(fixture)]);assert.equal(install.bootstrapConnection(next).mode,'auto');
 assert.equal(config.loadConfig().localModel,'fixture-retry');safeDiscovery();
`));

test('a non-model web server occupying the selected port leaves setup recoverable',()=>isolated(`
 let valid=false;
 const fixture=await server((req,res,json)=>{if(valid)return json({data:[{id:'fixture-recovered-port'}]});res.writeHead(200,{'content-type':'text/html'});res.end('<html>Another application</html>');});
 assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'none');untouched();
 valid=true;assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'auto');safeDiscovery();
`));

for(const [label,body]of [
 ['empty list',{data:[]}],['empty object',{}],['null body',null],['wrong list type',{data:'models'}],['unexpected array',[]],
])test('an unusable catalog ('+label+') cannot create a false connection',()=>isolated(`
 const fixture=await server((req,res,json)=>json(${JSON.stringify(body)}));
 const report=await scan([probe(fixture)]);assert.equal(install.bootstrapConnection(report).mode,'none');untouched();safeDiscovery();
`));

test('truncated JSON does not poison a later successful scan',()=>isolated(`
 let valid=false;const fixture=await server((req,res,json)=>{if(valid)return json({data:[{id:'fixture-repaired-json'}]});res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[');});
 assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'none');untouched();
 valid=true;assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'auto');safeDiscovery();
`));

test('one broken server does not hide a healthy server during parallel discovery',()=>isolated(`
 const broken=await server((req,res,json)=>json({data:[null,7,{},'bad']}));
 const good=await server((req,res,json)=>json({data:[{id:'fixture-healthy'}]}));
 const report=await scan([probe(broken),probe(good)]);
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-healthy');safeDiscovery();
`));

test('malformed Ollama inventory rows and running metadata cannot crash discovery',()=>isolated(`
 const fixture=await server((req,res,json)=>{
  if(req.url==='/api/tags')return json({models:[null,7,{},'bad',{name:'fixture-chat'}]});
  if(req.url==='/api/ps')return json({models:{invalid:true}});
  if(req.url==='/api/show')return json({capabilities:['completion']});json({},404);
 });
 const report=await scan([probe(fixture,'Ollama','ollama')]);
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-chat');safeDiscovery();
`));

test('malformed LM Studio metadata does not discard a valid served chat inventory',()=>isolated(`
 const fixture=await server((req,res,json)=>{
  if(req.url==='/v1/models')return json({data:[{id:'fixture-chat'}]});
  if(req.url==='/api/v1/models')return json({models:[null,{key:'fixture-chat',type:'llm',loaded_instances:{invalid:true}}]});json({},404);
 });
 const report=await scan([probe(fixture,'LM Studio')]);
 assert.equal(install.bootstrapConnection(report).selected.model,'fixture-chat');safeDiscovery();
`));

test('repeated scans keep all distinct models without selecting an arbitrary first entry',()=>isolated(`
 const fixture=await server((req,res,json)=>json({data:[{id:'fixture-a'},{id:'fixture-a'},{id:'fixture-b'},{id:'embeddinggemma-2'}]}));
 for(let i=0;i<4;i++){
  const report=await scan([probe(fixture),probe(fixture,'Duplicate endpoint')]);
  assert.deepEqual(setup.localChatCandidates(report).map(row=>row.model).sort(),['fixture-a','fixture-b']);
  assert.equal(install.bootstrapConnection(report).mode,'choose');untouched();
 }safeDiscovery();
`));

test('embedding-only metadata and mixed catalogs never select an embedding alias for chat',()=>isolated(`
 let mixed=false;const fixture=await server((req,res,json)=>json({data:[{id:'fixture-vector',type:'embedding'},...(mixed?[{id:'fixture-chat',type:'llm'}]:[])]}));
 assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'none');untouched();
 mixed=true;assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).selected.model,'fixture-chat');safeDiscovery();
`));

test('invalid custom addresses are rejected before any outbound request or profile write',()=>isolated(`
 const urls=['https://127.0.0.1:12345','http://127.0.0.1:65536',
  'http://synthetic-user:synthetic-key@127.0.0.1:12345','http://127.0.0.1:12345?key=synthetic-key',
  'http://127.0.0.1:12345/#secret','http://[::1','http://[::ffff:192.0.2.1]:12345',
  'http://192.0.2.1:12345','file:///tmp/models','javascript:alert(1)'];
 for(const url of urls){assert.equal(setup.normalizeLocalUrl(url),'',url);const r=await scan([],{environment:{OLLAMA_URL:url}});assert.equal(install.bootstrapConnection(r).mode,'none');}
 untouched();assert.equal(calls.length,0);safeDiscovery();
`));

test('a mistyped explicit port never silently switches to a different available model server',()=>isolated(`
 const absent=await server((req,res,json)=>json({}));await stop(absent);
 const good=await server((req,res,json)=>json({data:[{id:'fixture-unrelated'}]}));
 const report=await scan([probe(good)],{environment:{OLLAMA_URL:absent.url}});
 assert.equal(install.bootstrapConnection(report).mode,'choose');untouched();safeDiscovery();
`));

test('an IPv6 loopback custom endpoint is discovered, saved and does not fall back to IPv4',()=>isolated(`
 const fixture=await server((req,res,json)=>json({data:[{id:'fixture-ipv6'}]}),{host:'::1'});
 const report=await scan([],{environment:{OLLAMA_URL:fixture.url}});
 assert.equal(install.bootstrapConnection(report).mode,'auto');assert.equal(config.loadConfig().localUrl,fixture.url+'/v1');
 assert.equal(config.loadConfig().localModel,'fixture-ipv6');assert(fixture.requests.length);safeDiscovery();
`));

test('missing and wrong credentials recover with the correct key and the first real reply',()=>isolated(`
 const key='synthetic-abuse-correct-key',wrong='synthetic-abuse-wrong-key';
 const fixture=await server((req,res,json,body)=>{
  if(req.headers.authorization!=='Bearer '+key)return json({error:'denied'},401);
  if(req.url==='/v1/models')return json({data:[{id:'fixture-auth-chat',tool_call:false}]});
  if(req.url==='/v1/chat/completions'){const p=JSON.parse(body);assert.equal(p.model,'fixture-auth-chat');assert(!p.tools);assert(!p.tool_choice);return stream(res);}
  json({},404);
 });
 for(const candidate of ['',wrong]){
  const report=await scan([probe(fixture)],{cfg:{...config.loadConfig(),localUrl:fixture.url+'/v1',localKey:candidate}});
  assert(report.found.some(row=>row.authRequired));assert.equal(install.bootstrapConnection(report).mode,'none');noKey(report,key);noKey(report,wrong);untouched();
 }
 const report=await scan([probe(fixture)],{cfg:{...config.loadConfig(),localUrl:fixture.url+'/v1',localKey:key}});
 assert.deepEqual(setup.localChatCandidates(report).map(row=>row.model),['fixture-auth-chat']);
 assert(install.applyEndpoint({url:fixture.url+'/v1',model:'fixture-auth-chat',chatKey:key}).ok);
 noKey(report,key);noKey(config.publicState(),key);
 safeDiscovery();const {complete}=await import(moduleUrl('src/main/agent.js'));
 const reply=await complete([{role:'user',content:'Return the fixture marker'}],config.loadConfig(),()=>{},AbortSignal.timeout(3000),{predict:64,requestKind:'helper'});
 assert.equal(reply.content,'NOVA_ABUSE_RECOVERED');assert.equal(outbound.length,0);
`));

test('switching local endpoints clears the old endpoint credential and keeps public outputs secret-free',()=>isolated(`
 const key='synthetic-abuse-account-a';
 const a=await server((req,res,json)=>json({data:[{id:'fixture-a'}]}));
 const b=await server((req,res,json)=>json({data:[{id:'fixture-b'}]}));
 const first=install.applyEndpoint({url:a.url+'/v1',model:'fixture-a',chatKey:key});assert(first.ok);noKey(first,key);
 const report=await scan([probe(a),probe(b)]);noKey(report,key);
 assert(a.requests.every(row=>row.authorization==='Bearer '+key));assert(b.requests.every(row=>!row.authorization));
 assert(install.applyEndpoint({url:b.url+'/v1',model:'fixture-b'}).ok);assert.equal(config.loadConfig().localKey,'');
 noKey(config.publicState(),key);safeDiscovery();
`));

for(const transport of ['http-error','stream-error'])test('a provider echoing a local credential in a '+transport+' cannot leak it in an error',()=>isolated(`
 for(const key of ['synthetic-arbitrary-local-password','synthetic-long-private-prefix-'+ 'x'.repeat(900)]){
 const fixture=await server((req,res,json)=>{
  const error={message:'The provided secret "'+key+'" is invalid',type:'invalid_request_error',code:key};
  if(${JSON.stringify(transport)}==='http-error')return json({error},401);
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({error})+String.fromCharCode(10).repeat(2));
 });
 assert(install.applyEndpoint({url:fixture.url+'/v1',model:'fixture-errors',chatKey:key}).ok);
 const {complete}=await import(moduleUrl('src/main/agent.js'));let caught;const events=[];
 try{await complete([{role:'user',content:'Return a marker'}],config.loadConfig(),()=>{},AbortSignal.timeout(2000),{predict:64,requestKind:'helper',onProviderProgress:event=>events.push(event)});}catch(error){caught=error;}
 assert(caught,'an invalid credential must surface an error');noKey({message:caught.message,code:caught.code,stack:caught.stack,events},key.slice(0,80));assert.equal(outbound.length,0);
 }
`));

test('local redirects cannot contact another server or an off-loopback destination',()=>isolated(`
 const sink=await server((req,res,json)=>json({data:[{id:'fixture-never-contact'}]}));
 for(const location of [sink.url+'/v1/models','https://example.invalid/v1/models','http://192.0.2.1/models']){
  const redirect=await server((req,res)=>{res.writeHead(302,{location});res.end();});
  assert.equal(install.bootstrapConnection(await scan([probe(redirect)])).mode,'none');
 }
 assert.equal(sink.requests.length,0);untouched();safeDiscovery();
`));

test('a server that stalls before headers or inside a JSON body times out and can recover',()=>isolated(`
 let mode='headers';const fixture=await server((req,res,json)=>{
  if(mode==='headers')return;
  if(mode==='body'){res.writeHead(200,{'content-type':'application/json'});res.write('{"data":[');return;}
  json({data:[{id:'fixture-after-timeout'}]});
 });
 for(mode of ['headers','body']){const start=Date.now();assert.equal(install.bootstrapConnection(await scan([probe(fixture)],{timeoutMs:35})).mode,'none');assert(Date.now()-start<1500);untouched();}
 mode='ready';assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'auto');safeDiscovery();
`));

test('transient server errors and oversized responses do not poison retry',()=>isolated(`
 let mode='error';const fixture=await server((req,res,json)=>{
  if(mode==='error')return json({error:'synthetic unavailable'},503);
  if(mode==='large'){res.writeHead(200,{'content-type':'application/json','content-length':2000001});res.end('x');return;}
  json({data:[{id:'fixture-after-error'}]});
 });
 for(mode of ['error','large']){assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'none');untouched();}
 mode='ready';assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'auto');safeDiscovery();
`));

test('concurrent scan results and repeated connect clicks produce one valid durable profile',()=>isolated(`
 const fixture=await server((req,res,json)=>json({data:[{id:'fixture-repeated'}]}));
 const reports=await Promise.all(Array.from({length:8},()=>scan([probe(fixture)])));
 const choices=reports.map(report=>install.bootstrapConnection(report));
 assert.equal(choices.filter(row=>row.mode==='auto').length,1);assert(choices.slice(1).every(row=>row.mode==='saved'));
 for(let i=0;i<8;i++)assert(install.applyEndpoint({url:fixture.url+'/v1',model:'fixture-repeated'}).ok);
 const expected=fs.readFileSync(envFile,'utf8');assert.equal(expected.match(/^OLLAMA_MODEL=/gm).length,1);
 const child=spawnSync(process.execPath,['--input-type=module','-e','const c=await import('+JSON.stringify(moduleUrl('src/main/config.js'))+');process.stdout.write(JSON.stringify({model:c.loadConfig().localModel,ready:c.publicState().ready}));'],{env:process.env,encoding:'utf8',timeout:3000});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{model:'fixture-repeated',ready:true});assert.equal(fs.readFileSync(envFile,'utf8'),expected);safeDiscovery();
`));

test('damaged private cache and irrelevant env garbage do not prevent manual recovery',()=>isolated(`
 assert.equal(config.publicState().ready,false);
 const fixture=await server((req,res,json)=>json({data:[{id:'fixture-cache-recovery'}]}));
 const report=await scan([probe(fixture)]);assert.equal(install.bootstrapConnection(report).mode,'auto');
 assert.equal(config.loadConfig().localModel,'fixture-cache-recovery');safeDiscovery();
`,{seed:'# synthetic damaged file\nnot an assignment\nGARBAGE=\u0000\u0001\n',files:{'model-catalog.json':'{"scope":','setup.json':'{'}}));

test('an explicit saved connection survives failed scans, damaged caches and new competing servers byte-for-byte',()=>isolated(`
 const stale=await server((req,res,json)=>json({},503));
 fs.writeFileSync(envFile,['HNL_MODEL=local-3.8','OLLAMA_URL='+stale.url+'/v1','OLLAMA_MODEL=fixture-stale-choice','NOVA_LOCAL_API_KEY=synthetic-preserved-secret',''].join(String.fromCharCode(10)),{mode:0o600});
 const before=fs.readFileSync(envFile);const fixture=await server((req,res,json)=>json({data:[{id:'fixture-new'}]}));
 for(const report of [await scan([]),await scan([probe(fixture)])]){assert.equal(install.bootstrapConnection(report).mode,'saved');assert(fs.readFileSync(envFile).equals(before));}
 assert.equal(config.loadConfig().localModel,'fixture-stale-choice');assert.equal(config.loadConfig().localKey,'synthetic-preserved-secret');
 noKey(config.publicState(),'synthetic-preserved-secret');safeDiscovery();
`,{files:{'model-catalog.json':'invalid json'}}));

test('a rejected model or URL cannot inject extra private environment settings',()=>isolated(`
 const bad=['fixture\\nHNL_CHAT_KEY=injected','fixture'+String.fromCharCode(10)+'HNL_CHAT_KEY=injected','fixture'+String.fromCharCode(0)+'bad','embeddinggemma-2','x'.repeat(513),''];
 for(const model of bad.slice(1)){const result=install.applyEndpoint({url:'http://127.0.0.1:19999/v1',model});assert.equal(result.ok,false);}
 for(const url of ['http://synthetic:secret@127.0.0.1:19999/v1','http://127.0.0.1:19999/v1?key=secret'])assert.equal(install.applyEndpoint({url,model:'fixture-safe'}).ok,false);
 untouched();safeDiscovery();
`));

test('a pasted API key containing an internal newline cannot inject another environment setting',()=>isolated(`
 const payload='synthetic-pasted-key'+String.fromCharCode(10)+'HNL_CHAT_KEY=synthetic-injected-hosted-key';
 const result=install.applyEndpoint({url:'http://127.0.0.1:19999/v1',model:'fixture-newline-key',chatKey:payload});
 if(result.ok){
  const cfg=config.loadConfig(),saved=fs.readFileSync(envFile,'utf8');assert.equal(cfg.chatKey,'');
  assert.equal(saved.match(/^HNL_CHAT_KEY=/gm).length,1);assert.equal(saved.match(/^NOVA_LOCAL_API_KEY=/gm).length,1);
  assert(!saved.split(String.fromCharCode(10)).includes('HNL_CHAT_KEY=synthetic-injected-hosted-key'));
  assert(!/[\\r\\n\\0]/.test(cfg.localKey));noKey(config.publicState(),'synthetic-pasted-key');
 }else untouched();safeDiscovery();
`));

test('an interrupted disk-full config save preserves the previous profile bytes',()=>isolated(`
 config.loadConfig();const before=fs.readFileSync(envFile),old=config.loadConfig();
 const {syncBuiltinESMExports}=await import('node:module');const savedWrite=fs.writeFileSync;let injected=false;
 fs.writeFileSync=(target,...args)=>{
  if(!injected){
   if(typeof target!=='number')assert(path.resolve(String(target)).startsWith(home+path.sep),'fault injection must stay in the disposable profile');
   injected=true;savedWrite(target,'synthetic partial write',{mode:0o600});const error=Error('synthetic disk full');error.code='ENOSPC';throw error;
  }
  return savedWrite(target,...args);
 };syncBuiltinESMExports();let result,caught;
 try{result=install.applyEndpoint({url:'http://127.0.0.1:19998/v1',model:'fixture-never-durable',chatKey:'synthetic-replacement-key'});}catch(error){caught=error;}
 finally{fs.writeFileSync=savedWrite;syncBuiltinESMExports();}
 assert(injected,'the real save must cross the injected filesystem failure');assert(caught||result?.ok===false,'failed durability must not report success');
 assert(fs.readFileSync(envFile).equals(before),'a partial failed save destroyed the previous connection profile');
 assert.equal(config.loadConfig().localModel,old.localModel);assert.equal(config.loadConfig().localKey,old.localKey);safeDiscovery();
`,{seed:'HNL_MODEL=local-3.8\nOLLAMA_URL=http://127.0.0.1:19999/v1\nOLLAMA_MODEL=fixture-before-disk-full\nNOVA_LOCAL_API_KEY=synthetic-before-disk-full-key\n'}));

test('a read-only private profile refuses saves and leaves its previous connection unchanged',()=>isolated(`
 config.loadConfig();const before=fs.readFileSync(envFile);fs.chmodSync(envFile,0o400);fs.chmodSync(home,0o500);
 try{let result,caught;try{result=install.applyEndpoint({url:'http://127.0.0.1:19998/v1',model:'fixture-replacement'});}catch(error){caught=error;}
  assert(caught&&['EACCES','EPERM'].includes(caught.code)||result?.ok===false,'a save into a read-only private profile must fail');
  assert(fs.readFileSync(envFile).equals(before));if(result?.error)assert(!result.error.includes(home));}
 finally{fs.chmodSync(home,0o700);fs.chmodSync(envFile,0o600);}
 assert.equal(config.loadConfig().localModel,'fixture-old');safeDiscovery();
`,{seed:'HNL_MODEL=local-3.8\nOLLAMA_URL=http://127.0.0.1:19999/v1\nOLLAMA_MODEL=fixture-old\n'}));

test('a Mac without Ollama or Homebrew directs the user to the official installer',()=>isolated(`
 const state={spawned:[]};globalThis.__novaInstallFaultState=state;
 const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
 const childStub=data('import {EventEmitter} from "node:events";export function execFileSync(){throw Error("fixture missing binary");}export function spawn(command,args){globalThis.__novaInstallFaultState.spawned.push({command,args});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit("exit",1));return child;}');
 const osStub=data('export const platform=()=>"darwin",arch=()=>"arm64",freemem=()=>16*1024**3,totalmem=()=>32*1024**3;');
 const original=fs.readFileSync(path.join(project,'src/main/setup.js'),'utf8');
 const source=original.replace('"node:child_process"',JSON.stringify(childStub)).replace('"node:os"',JSON.stringify(osStub))
  .replace('"./safe.js"',JSON.stringify(moduleUrl('src/main/safe.js'))).replace('"./model-catalog.js"',JSON.stringify(moduleUrl('src/main/model-catalog.js')));
 globalThis.fetch=async()=>new Response('{}',{status:404});
 const fixtureSetup=await import(data(source));const lines=[];const result=await fixtureSetup.ensureOllama(line=>lines.push(line));
 assert.equal(result.ok,false);assert.equal(state.spawned.length,0,'a Mac without Homebrew must not run a Linux curl installer');
 assert(/ollama.com\\/download\\/mac|ollama.com\\/download|Ollama.*macOS/i.test(result.error),'missing Ollama must offer a clear macOS installer recovery path');
 untouched();assert.equal(calls.length,0);
`));

test('onboarding writes stay in the writable private profile with the application directory treated as read-only',()=>isolated(`
 const {syncBuiltinESMExports}=await import('node:module');
 const savedWrite=fs.writeFileSync,savedMkdir=fs.mkdirSync,savedRename=fs.renameSync,writes=[],renames=[];
 const permitted=target=>{const resolved=path.resolve(String(target));assert(resolved===home||resolved.startsWith(home+path.sep),'onboarding attempted to write into its read-only app bundle');writes.push(resolved);};
 fs.writeFileSync=(target,...args)=>{permitted(target);return savedWrite(target,...args);};
 fs.mkdirSync=(target,...args)=>{permitted(target);return savedMkdir(target,...args);};
 fs.renameSync=(source,destination)=>{permitted(source);permitted(destination);renames.push({source,destination});return savedRename(source,destination);};syncBuiltinESMExports();
 try{
  const fixture=await server((req,res,json)=>json({data:[{id:'fixture-writable-profile'}]}));
  assert.equal(install.bootstrapConnection(await scan([probe(fixture)])).mode,'auto');
  assert(config.publicState().ready);assert(renames.some(row=>row.destination===envFile),'the durable private profile must be committed atomically');
  if(process.platform!=='win32')assert.equal(fs.statSync(envFile).mode&0o777,0o600);assert(writes.length);safeDiscovery();
 }finally{fs.writeFileSync=savedWrite;fs.mkdirSync=savedMkdir;fs.renameSync=savedRename;syncBuiltinESMExports();}
`));
