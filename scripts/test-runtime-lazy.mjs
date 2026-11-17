import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const analysis = new URL('../src/main/analysis-runtime.js', import.meta.url).href;
const network = new URL('../src/main/network-runtime.js', import.meta.url).href;
const agent = new URL('../src/main/agent.js', import.meta.url).href;

function isolated(source, { stub = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'collar-runtime-lazy-'));
  try {
    const client = `export class Client {
      constructor(){globalThis.__clients=(globalThis.__clients||0)+1;this.connected=false;}
      async connect(transport){this.transport=transport;globalThis.__connections=(globalThis.__connections||0)+1;
        await new Promise(resolve=>setTimeout(resolve,15));
        if(globalThis.__failNextConnect){globalThis.__failNextConnect=false;throw Error('Fixture connection failure');}this.connected=true;}
      async listTools(){return {tools:['network_capture','analyze_javascript_application','export_evidence_bundle','close_binary'].map(name=>({name}))};}
      async callTool(){return {structuredContent:{ok:true}};}
      getServerVersion(){return this.connected?{name:'fixture',version:'1'}:undefined;}
      async close(){this.connected=false;await this.transport?.close();this.onclose?.();}
    }`;
    const transport = `export class StdioClientTransport {
      constructor(){globalThis.__transports=(globalThis.__transports||0)+1;this.stderr={on(){}};this.pid=123;}
      async close(){globalThis.__closed=(globalThis.__closed||0)+1;}
    }`;
    const loader = join(home, 'loader.mjs');
    writeFileSync(loader, `const stubs=${JSON.stringify({
      '@modelcontextprotocol/sdk/client/index.js': client,
      '@modelcontextprotocol/sdk/client/stdio.js': transport,
    })};export async function resolve(specifier,context,nextResolve){
      if(specifier.startsWith('@modelcontextprotocol/sdk/')){
        if(!${stub})throw Error('SDK was resolved before a feature connection: '+specifier);
        if(!stubs[specifier])throw Error('Unexpected SDK path: '+specifier);
        return {url:'data:text/javascript,'+encodeURIComponent(stubs[specifier]),shortCircuit:true};
      }return nextResolve(specifier,context);
    }`);
    const result = spawnSync(process.execPath,
      ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 10_000, env: { ...process.env, NOVAPUP_HOME: home } });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('ordinary runtime and agent imports never resolve the optional MCP SDK', () => {
  isolated(`import assert from 'node:assert/strict';
    const {AnalysisManager}=await import(${JSON.stringify(analysis)});
    const {NetworkRuntime}=await import(${JSON.stringify(network)});
    const {complete}=await import(${JSON.stringify(agent)});
    assert.equal(typeof complete,'function');
    const manager=new AnalysisManager({bundle:()=>({ok:false,error:'Fixture unavailable'})});
    assert.equal(manager.status().ok,false);
    await manager.closeAll();await new NetworkRuntime().close();
  `);
});

test('lazy network imports preserve shared connection, close and retry behavior', () => {
  isolated(`import assert from 'node:assert/strict';
    const {NetworkRuntime}=await import(${JSON.stringify(network)});
    const runtime=new NetworkRuntime();
    const clients=await Promise.all([runtime.connect(),runtime.connect(),runtime.connect()]);
    assert(clients.every(client=>client===clients[0]));assert.equal(globalThis.__connections,1);
    assert.equal((await runtime.call('network_status')).ok,true);
    await runtime.close();assert.equal(runtime.client,null);assert.equal(globalThis.__closed,1);
    globalThis.__failNextConnect=true;
    await assert.rejects(runtime.connect(),/Fixture connection failure/);
    assert.equal(runtime.connecting,null);assert.equal(globalThis.__closed,2);
    await runtime.connect();assert.equal(globalThis.__connections,3);await runtime.close();
  `, { stub: true });
});

test('lazy analysis imports preserve independent sessions and do not reopen after shutdown', () => {
  isolated(`import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    const {AnalysisManager}=await import(${JSON.stringify(analysis)});
    const home=process.env.NOVAPUP_HOME,target=join(home,'fixture.js');writeFileSync(target,'export const value=1;');
    const options={home:join(home,'analysis'),bundle:()=>({ok:true,root:home,manifest:{node:'node',entry:'entry',java_home:'java',ghidra:'ghidra',versions:{fixture:'1'}}})};
    const manager=new AnalysisManager(options);
    const opened=await Promise.all([manager.open(target,{kind:'javascript'}),manager.open(target,{kind:'javascript'})]);
    assert(opened.every(result=>result.ok));assert.notEqual(opened[0].session_id,opened[1].session_id);
    assert.equal(globalThis.__connections,2);assert.equal(manager.sessions.size,2);
    await manager.closeAll();assert.equal(manager.sessions.size,0);
    const other=new AnalysisManager(options),before=globalThis.__connections;
    const opening=other.open(target,{kind:'javascript'});await other.closeAll();
    await assert.rejects(opening,/shutting down/);assert.equal(globalThis.__connections,before);
  `, { stub: true });
});
