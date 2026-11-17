import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Discard inherited provider settings before importing production modules.
for (const key of Object.keys(process.env)) {
  if (/^(?:HNL_|OLLAMA_|NOVA_LOCAL_|OPENAI_|NP_LAYA)/.test(key)) delete process.env[key];
}
const home = mkdtempSync(join(tmpdir(), 'collar-redirect-fixture-'));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, 'no-model');
const sourceRoot = process.env.NOVA_TEST_SOURCE_ROOT || resolve(import.meta.dirname, '..');
const moduleAt = name => import(pathToFileURL(join(sourceRoot, 'src/main', name)).href);
const [{runHnlTool}, {complete}, {generateImage}, {reviewIntuition}] = await Promise.all([
  moduleAt('hnl.js'), moduleAt('agent.js'), moduleAt('comfy.js'), moduleAt('intuition.js')
]);
const nativeFetch = globalThis.fetch;
let origin, trapOrigin, sourceRequests = [], trapRequests = [], mode, status = 307;
const readBody = req => new Promise(resolve => { let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>resolve(text)); });
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve=>{ server.closeAllConnections();server.close(resolve); });
const trap = createServer(async (req,res)=>{ trapRequests.push({method:req.method,body:await readBody(req),headers:req.headers});res.writeHead(200,{'content-type':'application/json'});res.end('{}'); });
const source = createServer(async (req,res)=>{
  sourceRequests.push({method:req.method,url:req.url,body:await readBody(req)});
  if ((mode==='hnl' && req.url.startsWith('/tools/')) || (mode==='provider' && req.url==='/v1/chat/completions') ||
      (mode==='provider-fallback' && req.url==='/v1/chat/completions' && sourceRequests.length>1) ||
      (mode==='intuition') || (mode?.startsWith('comfy:') && req.url.split('?')[0]===mode.slice(6))) {
    res.writeHead(status,{location:trapOrigin+'/must-never-receive'});res.end();return;
  }
  if(mode==='provider-fallback' && req.url==='/v1/chat/completions') {res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"message":"required tool choice unsupported"}}');return;}
  if(req.url==='/v1/chat/completions') {res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'synthetic-ok'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;}
  let value = req.url==='/system_stats' ? {} : req.url==='/prompt' ? {prompt_id:'fixture-prompt'} : req.url==='/history/fixture-prompt' ? {'fixture-prompt':{outputs:{9:{images:[{filename:'fixture.png'}]}}}} : req.url.startsWith('/tools/') ? {data:{ok:true,id:'fixture-note',content:'synthetic-only',hits:[]}} : {};
  if(req.url.startsWith('/view?')) {res.writeHead(200,{'content-type':'image/png'});res.end(Buffer.from('synthetic-image'));return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
});
before(async()=>{trapOrigin=await listen(trap);origin=await listen(source);});
after(async()=>{globalThis.fetch=nativeFetch;await close(source);await close(trap);rmSync(home,{recursive:true,force:true});});
function reset(next) {mode=next;sourceRequests=[];trapRequests=[];}
const cfg = () => ({home,toolsUrl:origin,toolsKey:'synthetic-tools-only',comfyUrl:origin,labToken:'synthetic-image-only'});
const providerOptions = () => ({target:{url:origin+'/v1',model:'synthetic-model',key:'synthetic-provider-only',local:false},tools:[],predict:512,timeoutMs:2000});
const messages = [{role:'user',content:'synthetic private fixture text'}];
for(const code of [301,302,303,307,308]) {
  for(const tool of ['memory_remember','memory_search','memory_recall']) test(`${tool} refuses HTTP ${code} without forwarding memory or credentials`,async()=>{
    status=code;reset('hnl');
    const result=await runHnlTool(tool,{q:'synthetic-query',text:'synthetic-note'},cfg());
    assert.equal(result.ok,false);assert(sourceRequests.length>=1);assert.equal(trapRequests.length,0);
  });
  test(`provider refuses HTTP ${code} without forwarding prompt`,async()=>{
    status=code;reset('provider');await assert.rejects(complete(messages,{home},null,undefined,providerOptions()));
    assert.equal(sourceRequests.length,1);assert.equal(trapRequests.length,0);
  });
  test(`provider compatibility retry refuses HTTP ${code}`,async()=>{
    status=code;reset('provider-fallback');await assert.rejects(complete(messages,{home},null,undefined,{...providerOptions(),tools:[{type:'function',function:{name:'fixture',parameters:{type:'object'}}}],toolChoice:'required'}));
    assert.equal(sourceRequests.length,2);assert.equal(trapRequests.length,0);
  });
  for(const stage of ['/system_stats','/prompt','/history/fixture-prompt','/view']) test(`image ${stage} refuses HTTP ${code}`,async()=>{
    status=code;reset('comfy:'+stage);const result=await generateImage({prompt:'synthetic-only image'},cfg());
    assert.equal(result.ok,false);assert(sourceRequests.length>=1);assert.equal(trapRequests.length,0);
  });
  test(`optional turn reviewer refuses HTTP ${code}`,async()=>{
    status=code;reset('intuition');
    writeFileSync(join(home,'env'),'HNL_CHAT_URL=https://fixture.invalid/v1\nHNL_CHAT_KEY=synthetic-review-only\n',{mode:0o600});
    globalThis.fetch=(url,init)=>{assert.equal(String(url),'https://fixture.invalid/v1/chat/completions');return nativeFetch(origin+'/v1/chat/completions',init);};
    try {await reviewIntuition(messages,{force:true});assert.equal(sourceRequests.length,1);assert.equal(trapRequests.length,0);}
    finally {globalThis.fetch=nativeFetch;}
  });
}
test('successful original HNL origin remains usable',async()=>{reset('success');const result=await runHnlTool('memory_remember',{text:'synthetic-note'},cfg());assert.equal(result.ok,true);assert.equal(trapRequests.length,0);});
test('successful original provider stream remains usable',async()=>{reset('success');const result=await complete(messages,{home},null,undefined,providerOptions());assert.equal(result.content,'synthetic-ok');assert.equal(trapRequests.length,0);});
test('successful original image workflow remains usable',async()=>{reset('success');const result=await generateImage({prompt:'synthetic-only image'},cfg());assert.equal(result.ok,true);assert.equal(readFileSync(result.path,'utf8'),'synthetic-image');assert.equal(trapRequests.length,0);});
