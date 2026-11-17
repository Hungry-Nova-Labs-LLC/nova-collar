import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mainProfileHome } from "../src/main/profile-paths.js";

// Synthetic homes only: this suite never opens the operator's real profile.
test("installed main keeps the legacy profile despite leftover preview overrides", () => {
  const home = join(tmpdir(), "synthetic-collar-owner");
  assert.equal(mainProfileHome({ userHome: home, override: "/synthetic-preview", packaged: true }), join(home, ".novapup"));
  assert.equal(mainProfileHome({ userHome: home, override: "", packaged: false }), join(home, ".novapup"));
});

test("source and CLI tests can explicitly isolate their writable profile", () => {
  const home = join(tmpdir(), "synthetic-collar-test");
  assert.equal(mainProfileHome({ override: home, packaged: false }), home);
});

function isolated(t, source) {
  const root = mkdtempSync(join(tmpdir(), "collar-main-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 20000,
    env: { ...process.env, NOVAPUP_HOME: join(root, "profile"), NOVA_COLLAR_DEV_HOME: join(root, "ignored-dev-profile") },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "Profile fixture failed");
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
}

test("legacy chats, wire receipts, saved routes and private feature files survive normal saves", t => isolated(t, `
  import assert from 'node:assert/strict';
  import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
  import {join} from 'node:path';
  const home=process.env.NOVAPUP_HOME;
  mkdirSync(join(home,'sessions'),{recursive:true,mode:0o700});
  const id='chat-legacy12';
  const legacy={id,title:'Synthetic preserved chat',created:1,updated:2,
    messages:[{role:'user',content:'Preserve this synthetic task.'},{role:'assistant',content:'A recorded answer.'}],
    modelMessages:[{role:'user',content:'Synthetic turn.'},{role:'assistant',content:'',tool_calls:[{id:'fixture-call',type:'function',function:{name:'read_file',arguments:'{"path":"fixture.txt"}'}}]},
      {role:'tool',tool_call_id:'fixture-call',name:'read_file',content:'Synthetic receipt.'},{role:'assistant',content:'Verified fixture.'}],
    goal:'Preserve the existing task',archive:[{at:1,userGoal:'Synthetic scope',claim:'Earlier incomplete result',opposite:'',internalGoal:'Retained obligation',verdict:'held',detail:'Fixture only'}]};
  writeFileSync(join(home,'sessions',id+'.json'),JSON.stringify(legacy));
  writeFileSync(join(home,'sessions','index.json'),JSON.stringify({current:id,chats:[{id,title:legacy.title,created:1,updated:2,count:2}]}));
  writeFileSync(join(home,'env'),'HNL_CHAT_URL=https://models.example/v1\\nHNL_MODEL=nova-heavy\\nHNL_CHAT_KEY=synthetic-profile-key\\nHNL_TOOLS_URL=https://tools.example/v1\\nHNL_TOOLS_KEY=synthetic-tools-key\\n',{mode:0o600});
  for(const part of ['knowledge','private','animation']){mkdirSync(join(home,part));writeFileSync(join(home,part,'fixture.txt'),'Retain synthetic '+part);}
  const {APP_HOME,loadConfig,saveKeys,chatTarget,publicState}=await import('./src/main/config.js');
  const {readSession,saveSession,listSessions}=await import('./src/main/sessions.js');
  const {denySecretPath}=await import('./src/main/safe.js');
  assert.equal(APP_HOME,home);const cfg=loadConfig();assert.equal(cfg.model,'nova-heavy');assert.equal(chatTarget(cfg).url,'https://models.example/v1');
  assert.equal(cfg.chatKey,'synthetic-profile-key');assert.equal(cfg.fastModel,'');assert.equal(cfg.thinkModel,'');
  assert.equal(listSessions().current,id);const restored=readSession(id);
  for(const name of ['id','title','created','messages','modelMessages','goal','archive'])assert.deepEqual(restored[name],legacy[name]);
  saveSession(id,[...restored.messages,{role:'user',content:'An authorized synthetic follow-up.'}],{modelMessages:restored.modelMessages});
  const saved=readSession(id);assert.equal(saved.messages.length,3);assert.equal(saved.goal,legacy.goal);assert.deepEqual(saved.archive,legacy.archive);assert.deepEqual(saved.modelMessages,legacy.modelMessages);
  saveKeys({model:'Nova-Qwen27B'});const updated=loadConfig();assert.equal(updated.chatKey,cfg.chatKey);assert.equal(updated.toolsKey,cfg.toolsKey);assert.equal(updated.toolsUrl,cfg.toolsUrl);assert.equal(updated.model,'Nova-Qwen27B');
  assert.ok(denySecretPath(join(home,'env')));assert.ok(!JSON.stringify(publicState(updated)).includes(cfg.chatKey));
  for(const part of ['knowledge','private','animation'])assert.equal(readFileSync(join(home,part,'fixture.txt'),'utf8'),'Retain synthetic '+part);
  process.stdout.write(JSON.stringify({ok:true}));
`));

test("a new isolated profile creates private storage without copying operator data", t => isolated(t, `
  import assert from 'node:assert/strict';import {existsSync,readdirSync,statSync} from 'node:fs';import {join} from 'node:path';
  const {APP_HOME,saveKeys}=await import('./src/main/config.js');
  saveKeys({chatUrl:'https://models.example/v1',chatKey:'synthetic-new-profile-key',model:'nova-heavy'});
  assert.equal(APP_HOME,process.env.NOVAPUP_HOME);assert.ok(existsSync(join(APP_HOME,'env')));
  assert.ok(!existsSync(process.env.NOVA_COLLAR_DEV_HOME));assert.equal(readdirSync(join(APP_HOME,'sessions')).length,0);
  if(process.platform!=='win32'){assert.equal(statSync(APP_HOME).mode&0o777,0o700);assert.equal(statSync(join(APP_HOME,'env')).mode&0o777,0o600);}
  process.stdout.write(JSON.stringify({ok:true}));
`));
