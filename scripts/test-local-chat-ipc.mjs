import assert from 'node:assert/strict';
import { registerLocalChatIpc } from '../src/main/local-chat-ipc.js';
const handlers = new Map(), calls = [], events = []; let allowed = true, pickerCount = 0, finishInstall, installPromise;
const status = { supported: true, models: [], activeModelId: '', stage: 'ready' };
const api = { setLocalChatGuard(fn) { this.guard = fn; }, onLocalChatStatus(fn) { this.listener = fn; return () => {}; },
  localChatStatus: async () => status, localChatLicense: async () => ({ title: 'License', text: 'Apache 2.0' }),
  localChatInstall(id) { calls.push(['install', id]); installPromise = new Promise(resolve => { finishInstall = resolve; }); return installPromise; },
  async localChatCancel() { calls.push(['cancel']); finishInstall?.({ ok: false, errorCode: 'cancelled', status }); await installPromise; return { ok: true, status }; },
  async localChatImport(path) { calls.push(['import', path]); return { ok: true, status }; },
  async localChatUse(id) { calls.push(['use', id]); return { ok: true, status }; },
  async localChatStop() { calls.push(['stop']); return { ok: true, status }; }, async localChatRemove(id) { calls.push(['remove', id]); return { ok: true, status }; }, async localChatRestorePrevious() { calls.push(['restore']); return { ok: true, status }; },
};
registerLocalChatIpc({ ipcMain: { handle(name, fn) { handlers.set(name, fn); } }, fromWindow: event => event === 'owner', api, snapshot: () => ({ ready: true }), send: event => events.push(event), canChange: () => allowed, pickFile: async () => { pickerCount++; return '/trusted/native-picker.gguf'; }, markSetupDone: () => calls.push(['setup']) });
const invoke = (name, value, event = 'owner') => handlers.get('local-chat:' + name)(event, value);
assert.equal(handlers.size, 9);
for (const name of ['status', 'install', 'import', 'use', 'stop', 'cancel', 'remove', 'restore', 'license']) assert.equal((await invoke(name, 'fixture', 'untrusted')).errorCode, 'denied');
assert.equal(calls.length, 0); assert.equal(pickerCount, 0);
await invoke('import', '/renderer/supplied.gguf'); assert.deepEqual(calls.find(call => call[0] === 'import'), ['import', '/trusted/native-picker.gguf']);
allowed = false; for (const name of ['import', 'use', 'stop', 'remove', 'restore']) assert.equal((await invoke(name, 'fixture')).errorCode, 'active-turn'); assert.equal(pickerCount, 1); allowed = true;
assert.equal((await invoke('install', 'fixture')).ok, true); await invoke('install', 'fixture'); assert.equal(calls.filter(call => call[0] === 'install').length, 1); await invoke('cancel'); await invoke('install', 'fixture'); assert.equal(calls.filter(call => call[0] === 'install').length, 2); finishInstall({ ok: true, status }); await installPromise; await new Promise(resolve => setImmediate(resolve));
api.listener({ type: 'local-chat', ...status }); assert.equal(events.at(-1).state.ready, true); assert.deepEqual(await invoke('license'), { title: 'License', text: 'Apache 2.0' });
console.log('local-chat-ipc: sender/turn guards, native picker, install dedupe/cancel barrier and state events passed');
