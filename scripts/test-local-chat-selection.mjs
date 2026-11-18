import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, sha } from './local-chat-fixture.mjs';
import { applyLocalChatSelection, readLocalChatSelection, writeLocalChatSelection, clearLocalChatSelection, managedSettingsUrl } from '../src/main/local-chat-selection.js';
const f = await fixture();
try {
  const before = await readFile(f.base.envFile), selected = { id: 'fixture', label: 'Synthetic', contextTokens: 8192, tools: true };
  writeLocalChatSelection(f.home, f.base, selected);
  assert.deepEqual(await readFile(f.base.envFile), before); assert.deepEqual(readLocalChatSelection(f.home, f.base), selected);
  const overlay = applyLocalChatSelection(f.base); assert.equal(overlay.model, 'local-gguf:fixture'); assert.equal(overlay.localUrl, managedSettingsUrl('fixture')); assert.equal(overlay.localKey, ''); assert.equal(overlay.fastKey, ''); assert.equal(overlay.thinkUrl, ''); assert.equal(overlay.chatKey, f.base.chatKey);
  assert.equal(readLocalChatSelection(f.home, { ...f.base, chatKey: 'different' }), null);
  await writeFile(f.base.envFile, Buffer.concat([before, Buffer.from('# explicit settings save\n')])); assert.equal(readLocalChatSelection(f.home, f.base), null);
  clearLocalChatSelection(f.home); await symlink(f.base.envFile, join(f.home, 'local-chat-state.json')); assert.equal(readLocalChatSelection(f.home, f.base), null); assert.throws(() => writeLocalChatSelection(f.home, f.base, selected)); await unlink(join(f.home, 'local-chat-state.json'));
  process.env.NOVAPUP_HOME = f.home; process.env.HNL_CHAT_URL = f.base.chatUrl; process.env.HNL_CHAT_KEY = f.base.chatKey; process.env.HNL_MODEL = 'remote-fixture';
  const cfg = await import('../src/main/config.js'); const base = cfg.loadBaseConfig(); writeLocalChatSelection(f.home, base, selected);
  assert.equal(cfg.loadConfig().managedChat.id, 'fixture'); const target = cfg.chatTarget(cfg.loadConfig()); assert.equal(target.kind, 'managed-chat'); assert.equal(target.key, '');
  // Keep a real discovery-cache row while hiding only the synthetic legacy alias.
  await writeFile(join(f.home, 'model-catalog.json'), JSON.stringify({ scope: sha(JSON.stringify([base.chatUrl.replace(/\/+$/, ''), base.chatKey || base.toolsKey || ''])), updatedAt: Date.now(), models: [{ id: 'served-fixture-chat', description: 'Served fixture chat', tools: true }] }));
  const state = cfg.publicState(cfg.loadConfig()), friendly = state.models.filter(row => row.id === 'local-gguf:fixture');
  assert.deepEqual(friendly, [{ id: 'local-gguf:fixture', label: 'Synthetic', hint: 'on this computer', managed: true }]);
  assert.ok(!state.models.some(row => row.id === cfg.LOCAL_ID), 'managed selection must not invent an Ollama/LM Studio alias');
  assert.ok(state.models.some(row => row.id === 'served-fixture-chat'), 'actual discovered server models remain available');
  const legacyState = cfg.publicState({ ...base, model: cfg.LOCAL_ID, localModel: 'saved-ollama-fixture', managedChat: undefined });
  assert.equal(legacyState.models.find(row => row.id === cfg.LOCAL_ID).label, 'Local: saved-ollama-fixture', 'a real prior local connection retains its legacy row');
  assert.ok(legacyState.models.some(row => row.id === 'served-fixture-chat'));

  assert.equal(cfg.publicState(cfg.loadConfig()).models.find(row => row.id === state.model).label, 'Synthetic', 'friendly label survives a fresh durable selection read');
  const configUrl = new URL('../src/main/config.js', import.meta.url).href;
  const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const cfg = await import(${JSON.stringify(configUrl)}); const state = cfg.publicState(); console.log(JSON.stringify(state.models.find(row => row.id === state.model)));`], { encoding: 'utf8', env: { ...process.env, NOVAPUP_HOME: f.home } }));
  assert.deepEqual(restarted, friendly[0], 'fresh process keeps the saved friendly model choice');
  assert.equal(state.chatUrl, managedSettingsUrl('fixture')); assert.equal(state.managedLocal, true);
  const publicRows = JSON.stringify(state.models); assert.ok(!publicRows.includes(base.chatKey)); assert.ok(!publicRows.includes('runtime-auth-')); assert.ok(!/127\.0\.0\.1:\d+/.test(publicRows));
  cfg.saveKeys({ model: 'other-remote' }); const final = cfg.loadBaseConfig(); assert.equal(final.model, 'other-remote'); assert.equal(final.chatKey, base.chatKey); assert.equal(final.localKey, base.localKey); assert.equal(readLocalChatSelection(f.home, final), null);
  const text = await readFile(f.base.envFile, 'utf8'); assert.ok(!text.includes('local-gguf:')); assert.ok(!text.includes('/local-chat/')); assert.ok(!text.includes('ephemeral'));
  console.log('local-chat-selection: isolated route overlay, stale-state protection and original provider preservation passed');
} finally { await f.cleanup(); }
