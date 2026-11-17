import assert from 'node:assert/strict';
import {test} from 'node:test';
import {missingFileRecovery, recoveryCallMatches} from '../src/main/implementation-recovery.js';

const setup = () => ({limited:true, local:true, editTask:true, sourceRead:true, cwd:'/workspace', missingFiles:['/workspace/src/new-module.mjs'],
  offered:[{type:'function',function:{name:'host_file_write',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}}], permittedNames:new Set(['host_file_write'])});

test('a missing positively requested new file can select one offered write attempt', async () => {
  assert.deepEqual(await missingFileRecovery(setup()), {tool:'host_file_write',path:'/workspace/src/new-module.mjs',cwd:'/workspace'});
  assert.equal(await missingFileRecovery({...setup(),attempted:true}), null);
});

test('discussion, suspended work, absent source reads and unavailable writers cannot force a mutation', async () => {
  for (const change of [{local:false},{limited:false},{editTask:false},{suspended:true},{sourceRead:false},{offered:[]},{permittedNames:new Set()}]) {
    assert.equal(await missingFileRecovery({...setup(),...change}), null);
  }
});

test('outside, relative and root-directory targets are not candidates', async () => {
  for (const path of ['/outside/file.mjs','../file.mjs','/workspace']) assert.equal(await missingFileRecovery({...setup(),missingFiles:[path]}), null);
  assert.equal(await missingFileRecovery({...setup(),missingFiles:[]}), null);
});

test('the recovery request contains no executable mutation or completion proof', async () => {
  const chosen = await missingFileRecovery(setup());
  assert.equal(Object.hasOwn(chosen,'content'), false); assert.equal(Object.hasOwn(chosen,'edits'), false);
  assert.equal(Object.hasOwn(chosen,'verification'), false); assert.equal(Object.hasOwn(chosen,'passed'), false);
});


test('a forced tool name cannot authorize a different file or a multi-call batch', async () => {
  const choice = await missingFileRecovery(setup());
  const call = path => ({function:{name:'host_file_write',arguments:JSON.stringify({path,content:'saved code'})}});
  assert.equal(recoveryCallMatches(choice,[call('src/new-module.mjs')],'/workspace'),true);
  assert.equal(recoveryCallMatches(choice,[call('src/new-module.mjs')],'/changed-workspace'),false);
  assert.equal(recoveryCallMatches(choice,[call('/outside/unrequested.mjs')],'/workspace'),false);
  assert.equal(recoveryCallMatches(choice,[call('src/new-module.mjs'),call('src/extra.mjs')],'/workspace'),false);
  assert.equal(recoveryCallMatches(choice,[], '/workspace'),false);
  assert.equal(recoveryCallMatches(choice,[{function:{name:'host_run',arguments:'{}'}}],'/workspace'),false);
  assert.equal(recoveryCallMatches(choice,[{function:{name:'host_file_write',arguments:'{bad json'}}],'/workspace'),false);
});


const writerSchema = () => structuredClone(setup().offered[0]);
const constrained = change => {
  const tool=writerSchema();change(tool.function.parameters);return [tool];
};

test('unknown or constrained writer schemas and roles do not even inspect candidate metadata', async () => {
  const changes = [{local:false},{offered:[]},{permittedNames:null},{permittedNames:new Set()},
    {offered:[{function:{name:'host_file_write'}}]},
    {offered:constrained(s=>{s.properties.path.enum=['other.mjs'];})},
    {offered:constrained(s=>{s.properties.path.const='other.mjs';})},
    {offered:constrained(s=>{s.properties.path.pattern='^other/';})},
    {offered:constrained(s=>{s.properties.content.maxLength=20;})},
    {offered:constrained(s=>{s.required.push('approval');})},
    {offered:constrained(s=>{s.additionalProperties=false;})},
    {offered:constrained(s=>{s.allOf=[];})},
    {offered:[writerSchema(),writerSchema()]},
    {offered:[{...writerSchema(),type:'custom'}]},
    {cwd:'relative/workspace'}, {sourceRead:'yes'},
  ];
  for (const change of changes) {
    let probes=0;
    const options={...setup(),...change};
    Object.defineProperty(options,'missingFiles',{get(){probes++;throw Error('must stay lazy');}});
    assert.equal(await missingFileRecovery(options),null);assert.equal(probes,0,JSON.stringify(change));
  }
});

test('a permitted callback runs once only after capability checks, and errors stay unavailable',async()=>{
  let probes=0;
  const result=await missingFileRecovery({...setup(),missingFiles:()=>{probes++;return ['/workspace/src/new-module.mjs'];}});
  assert.equal(result.path,'/workspace/src/new-module.mjs');assert.equal(probes,1);
  assert.equal(await missingFileRecovery({...setup(),missingFiles:()=>{throw Error('unavailable');}}),null);
  const options=setup();Object.defineProperty(options,'missingFiles',{get(){throw Error('unavailable');}});
  assert.equal(await missingFileRecovery(options),null);
});

test('an arbitrary has method is not permission authority and is never executed',async()=>{
  let invoked=0;
  assert.equal(await missingFileRecovery({...setup(),permittedNames:{has(){invoked++;return true;}},missingFiles:()=>{throw Error('must stay lazy');}}),null);
  assert.equal(invoked,0);
});

test('a completed named response still requires exactly ordinary path/content arguments',async()=>{
  const choice=await missingFileRecovery(setup());
  for (const args of [{path:'src/new-module.mjs'}, {path:'src/new-module.mjs',content:42},
    {path:'src/new-module.mjs',content:'code',command:'do more'}, ['src/new-module.mjs'], null]) {
    assert.equal(recoveryCallMatches(choice,[{function:{name:'host_file_write',arguments:JSON.stringify(args)}}],'/workspace'),false);
  }
  assert.equal(recoveryCallMatches(choice,[],undefined),false);
});
