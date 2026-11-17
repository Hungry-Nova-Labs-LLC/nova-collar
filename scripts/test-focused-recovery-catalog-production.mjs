import assert from "node:assert/strict";
import {test,after,afterEach} from "node:test";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-focused-catalog-")));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("No native inference/network allowed");};
const {complete,runTurn}=await import("../src/main/agent.js");
const {ensureHome,chatTarget,loadConfig}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();const target=chatTarget(loadConfig());writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
setApprovalNotifier(event=>{if(event.type==="approval")resolveApproval(event.request.id,true);});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected native request");};});
after(()=>{globalThis.fetch=originalFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,search:false,remote:false}).filter(tool=>["host_run","host_file_read","host_file_write","host_file_edit"].includes(tool.function.name));
const frame=data=>`data: ${JSON.stringify(data)}\n\n`;
const call=(name,args,id,index=0)=>({index,id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const stream=(calls=[],content="")=>new Response((content?frame({choices:[{delta:{content}}]}):"")+frame({choices:[{delta:{...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
function project(name){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,"src"));writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');writeFileSync(join(cwd,"README.md"),"Local fixture context.\n");writeFileSync(join(cwd,"src/a.mjs"),"export const value = 1;\n");writeFileSync(join(cwd,"src/b.mjs"),"export const value = 2;\n");setWorkdir(cwd);return cwd;}
const ask="Do not inspect hidden references or private profiles. Fix the implementation. Scope: change only src/a.mjs, src/b.mjs. Do not modify README.md. Verify locally.";
const wrapped=(messages,cfg,delta,signal,options)=>options.requestKind==="contract_review"?Promise.resolve({content:'{"findings":[],"limitations":[]}',tool_calls:[]}):complete(messages,cfg,delta,signal,options);
const options=()=>({sessionId:createSession().id,tools,sourcePreload:false,complete:wrapped});

test("actual SSE selected-only existing-edit schema defeats a catalog-dependent wrong-read mock and ordinary catalog restores",async()=>{
  const cwd=project("two-targets"),events=[],bodies=[];let n=0,selectedOnly=false;
  globalThis.fetch=async(_url,opts)=>{
    const body=JSON.parse(opts.body);bodies.push(body);n++;assert.equal(body.max_tokens,8192);assert.equal(body.options.num_ctx,131072);
    if(n===1)return stream([call("host_file_read",{path:"src/a.mjs"},"read-a"),call("host_file_read",{path:"src/b.mjs"},"read-b",1)]);
    if(n===2)return stream([call("host_file_read",{path:"README.md"},"context")]);
    if(n===3){assert.equal(body.tool_choice?.function?.name,"host_file_edit");selectedOnly=body.tools.length===1&&body.tools[0].function.name==="host_file_edit";if(!selectedOnly)return stream([call("host_file_read",{path:"README.md"},"wrong-read")]);return stream([call("host_file_edit",{path:"src/a.mjs",edits:[{oldText:"value = 1",newText:"value = 4"}]},"edit-a")]);}
    if(n>3&&!selectedOnly)return stream([],"No requested source change was made after the mismatched response.");
    if(n===4){assert.deepEqual(body.tools,bodies[0].tools);return stream([call("host_file_edit",{path:"src/b.mjs",edits:[{oldText:"value = 2",newText:"value = 5"}]},"edit-b")]);}
    if(n===5)return stream([call("host_run",{command:`node --input-type=module -e 'import assert from "node:assert/strict"; import {value as a} from "./src/a.mjs"; import {value as b} from "./src/b.mjs"; assert.equal(a,4); assert.equal(b,5); console.log("BOTH_OBSERVED")'`},"check")]);
    assert.equal(n,6);return stream([],"Saved both requested changes and observed BOTH_OBSERVED from executed assertions. No declared project suite was available.");
  };
  const result=await runTurn([],ask,event=>events.push(event),AbortSignal.timeout(15000),options());
  assert.deepEqual(bodies[2].tools,bodies[0].tools.filter(tool=>tool.function.name==="host_file_edit"));assert.equal(n,6);
  assert.equal(readFileSync(join(cwd,"src/a.mjs"),"utf8"),"export const value = 4;\n");assert.equal(readFileSync(join(cwd,"src/b.mjs"),"utf8"),"export const value = 5;\n");
  assert(events.some(event=>event.type==="tool_result"&&event.name==="host_run"&&event.ok&&event.detail.includes("BOTH_OBSERVED")));assert.match(result.assistant,/BOTH_OBSERVED/);
});

for(const bad of ["read","prose","wrong-path","multi"])test(`actual SSE ${bad} response is still atomically rejected and ordinary catalog restored`,async()=>{
  const cwd=project(bad),events=[],bodies=[];let n=0;
  globalThis.fetch=async(_url,opts)=>{
    const body=JSON.parse(opts.body);bodies.push(body);n++;
    if(n===1)return stream([call("host_file_read",{path:"src/a.mjs"},"read")]);
    if(n===2)return stream([call("host_file_read",{path:"README.md"},"context")]);
    if(n===3){assert.equal(body.tool_choice?.function?.name,"host_file_edit");assert.deepEqual(body.tools.map(tool=>tool.function.name),["host_file_edit"]);
      if(bad==="read")return stream([call("host_file_read",{path:"src/b.mjs"},"rejected-read")]);
      if(bad==="prose")return stream([],"The edit would change the value, but no operation was submitted.");
      const calls=[call("host_file_edit",{path:bad==="wrong-path"?"src/b.mjs":"src/a.mjs",edits:[{oldText:"value = 1",newText:"value = 9"}]},"rejected-edit")];
      if(bad==="multi")calls.push(call("host_file_write",{path:"extra.mjs",content:"bad"},"rejected-write",1));return stream(calls);
    }
    assert.deepEqual(body.tools,bodies[0].tools);return stream([],"No implementation was performed after the rejected response; the requested task remains incomplete.");
  };
  const result=await runTurn([],ask,event=>events.push(event),AbortSignal.timeout(15000),options());
  assert(n>3&&n<=9);assert.match(result.assistant,/Incomplete|FAIL/);assert.equal(readFileSync(join(cwd,"src/a.mjs"),"utf8"),"export const value = 1;\n");assert(!existsSync(join(cwd,"extra.mjs")));
  assert(!events.some(event=>event.type==="tool"&&["host_file_edit","host_file_write"].includes(event.name)));
  assert(!events.some(event=>event.type==="tool"&&event.name==="host_file_read"&&JSON.parse(event.args).path==="src/b.mjs"));
});

test("current review steering invalidates selected-only recovery and never restores forbidden editors",async()=>{
  const cwd=project("review"),events=[];let n=0,batch=null;
  globalThis.fetch=async(_url,opts)=>{
    const body=JSON.parse(opts.body);n++;
    if(n===1)return stream([call("host_file_read",{path:"src/a.mjs"},"read")]);
    if(n===2)return stream([call("host_file_read",{path:"README.md"},"context")]);
    if(n===3){assert.deepEqual(body.tools.map(tool=>tool.function.name),["host_file_edit"]);batch={messages:[{content:"Stop editing; review only. Do not run any programs."}]};return stream([call("host_file_edit",{path:"src/a.mjs",edits:[{oldText:"value = 1",newText:"value = 9"}]},"discarded")]);}
    assert(!body.tools.some(tool=>tool.function.name==="host_file_edit"));return stream([],"Reviewed only. No source was edited after the request changed.");
  };
  await runTurn([],ask,event=>events.push(event),AbortSignal.timeout(15000),{...options(),takeInput:()=>batch,ackInput:()=>{batch=null;}});
  assert.equal(readFileSync(join(cwd,"src/a.mjs"),"utf8"),"export const value = 1;\n");assert(!events.some(event=>event.type==="tool"&&event.name==="host_file_edit"));
});
