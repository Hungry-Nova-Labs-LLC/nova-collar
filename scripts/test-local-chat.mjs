import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, seed, fakeRuntime, goodComplete, GIB } from './local-chat-fixture.mjs';
import { createLocalChatManager, localChatMemory } from '../src/main/local-chat.js';
import { readLocalChatSelection, writeLocalChatSelection } from '../src/main/local-chat-selection.js';

// Cached/reclaimable memory must not be mistaken for genuine scarcity.
const physical = 64 * GIB, lowFree = 0.9 * GIB;
const memoryFrom = available => () => localChatMemory({ total: () => physical, free: () => lowFree, available });
assert.deepEqual(memoryFrom(() => 19 * GIB)(), { total: physical, free: 19 * GIB });
assert.equal(memoryFrom(() => 100 * GIB)().free, physical);
assert.equal(memoryFrom(() => 0)().free, 0, 'zero available memory is genuine scarcity, not a missing API');
for (const available of [() => undefined, () => NaN, () => Infinity, () => -1, () => { throw new Error('unavailable'); }]) assert.equal(memoryFrom(available)().free, lowFree);

async function scenario(test, options = {}) {
  const f = await fixture(), runtime = fakeRuntime(); let allowed = true;
  const events = [], config = { home: f.home, catalog: { schemaVersion: 1, platforms: ['fixture'], models: [f.row] }, platform: 'fixture', runtime,
    readBaseConfig: () => f.base, canChange: () => allowed, memory: () => ({ total: 64 * GIB, free: 48 * GIB }), completeImpl: goodComplete,
    fetchImpl: async () => new Response(f.data, { status: 200, headers: { 'content-length': String(f.data.length) } }), ...options };
  const manager = createLocalChatManager(config); manager.subscribe(event => events.push(event));
  try { await test({ f, runtime, manager, config, events, allow: value => { allowed = value; } }); }
  finally { await manager.shutdown(); await f.cleanup(); }
}
await scenario(async ({ f, manager, runtime, events }) => {
  const before = await readFile(f.base.envFile); const result = await manager.install('fixture'); assert.equal(result.ok, true); assert.equal(runtime.stats.acquires, 1); assert.equal(readLocalChatSelection(f.home, f.base).id, 'fixture');
  assert.deepEqual(await readFile(f.base.envFile), before); assert.equal(result.status.models[0].tools, true); assert.equal(result.status.models[0].loaded, true);
  const held = await manager.remove('fixture'); assert.equal(held.errorCode, 'model-active'); assert.equal(runtime.loadedId(), 'fixture');
  await manager.stop(); assert.equal((await manager.status()).activeModelId, 'fixture'); assert.equal((await manager.status()).models[0].loaded, false);
  assert.equal((await manager.remove('fixture')).ok, true); assert.equal((await manager.status()).activeModelId, ''); assert.equal((await manager.status()).previousConnectionAvailable, true);
  const serialized = JSON.stringify(events); assert.ok(!serialized.includes(f.home)); assert.ok(!serialized.includes(f.base.chatKey)); assert.ok(!serialized.includes('ephemeral-fixture-nonce'));
});
await scenario(async ({ f, manager, runtime }) => { await seed(f); const before = runtime.stats.stops; assert.equal((await manager.use('missing')).errorCode, 'model-missing'); assert.equal(runtime.stats.stops, before); });
await scenario(async ({ manager, runtime, allow }) => { allow(false); const result = await manager.install('fixture'); assert.equal(result.errorCode, 'active-turn'); assert.equal(runtime.stats.stops, 0); assert.equal((await manager.status()).models[0].installed, true); });
// A changed provider during download leaves the verified model available without selecting it.
await scenario(async ({ f, runtime, config }) => {
  config.fetchImpl = async () => { await writeFile(f.base.envFile, 'changed provider\n'); return new Response(f.data, { headers: { 'content-length': String(f.data.length) } }); };
  const manager = createLocalChatManager(config); try { assert.equal((await manager.install('fixture')).errorCode, 'config-changed'); assert.equal(runtime.stats.stops, 0); assert.equal((await manager.status()).models[0].installed, true); } finally { await manager.shutdown(); }
});
await scenario(async ({ manager }) => { assert.equal((await manager.install('fixture')).errorCode, 'insufficient-memory'); }, { memory: () => ({ total: 2 * GIB, free: GIB }) });
await scenario(async ({ f, manager }) => { await seed(f); assert.equal((await manager.use('fixture')).errorCode, 'insufficient-free-memory'); }, { memory: () => ({ total: 64 * GIB, free: 0 }) });
await scenario(async ({ manager }) => { const result = await manager.install('fixture'); assert.equal(result.ok, true); assert.equal(result.status.freeMemoryGB, 19); }, { memory: memoryFrom(() => 19 * GIB) });
await scenario(async ({ f, manager }) => { await seed(f); assert.equal((await manager.use('fixture')).errorCode, 'insufficient-free-memory'); }, { memory: memoryFrom(() => 0) });
await scenario(async ({ f, manager }) => { await seed(f); assert.equal((await manager.use('fixture')).errorCode, 'insufficient-free-memory'); }, { memory: memoryFrom(() => undefined) });
await scenario(async ({ manager }) => { assert.equal((await manager.install('fixture')).errorCode, 'tool-check-failed'); }, { completeImpl: async (...args) => args[4].tools.length ? { content: 'no tools', tool_calls: [] } : goodComplete(...args) });
for (const toolWorks of [true, false]) await scenario(async ({ f, config }) => {
  const source = join(f.home, 'original.gguf'); await writeFile(source, f.data);
  config.completeImpl = async (...args) => args[4].tools.length && !toolWorks ? { content: 'chat only', tool_calls: [] } : goodComplete(...args);
  const manager = createLocalChatManager(config); try { const result = await manager.import(source); assert.equal(result.ok, true); assert.equal(result.status.models.find(row => row.imported).tools, toolWorks); assert.deepEqual(await readFile(source), f.data); } finally { await manager.shutdown(); }
});
await scenario(async ({ f, config, runtime }) => {
  const previous = { id: 'previous', label: 'Previous local', contextTokens: 8192, tools: true }; writeLocalChatSelection(f.home, f.base, previous);
  let release; config.fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => { release = () => resolve(new Response(f.data)); signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })), { once: true }); });
  const manager = createLocalChatManager(config); try { const running = manager.install('fixture'); while (!release) await new Promise(resolve => setTimeout(resolve, 1)); assert.equal((await manager.use('fixture')).errorCode, 'busy'); await manager.cancel(); assert.equal((await running).errorCode, 'cancelled'); assert.equal(runtime.stats.stops, 0); assert.equal(readLocalChatSelection(f.home, f.base).id, 'previous'); } finally { await manager.shutdown(); }
});
await scenario(async ({ f, manager }) => {
  const previous = { id: 'previous', label: 'Previous local', contextTokens: 8192, tools: true }; writeLocalChatSelection(f.home, f.base, previous); let cancelled = false;
  manager.subscribe(event => { if (!cancelled && event.stage === 'running' && event.activeModelId === 'fixture') { cancelled = true; void manager.cancel(); } });
  assert.equal((await manager.install('fixture')).errorCode, 'cancelled'); assert.equal(readLocalChatSelection(f.home, f.base).id, 'previous');
});
await scenario(async ({ manager, config }) => {
  let started; const reached = new Promise(resolve => { started = resolve; });
  config.completeImpl = async (...args) => { if (!args[4].tools.length) return goodComplete(...args); started(); return new Promise((_resolve, reject) => args[3].addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })), { once: true })); };
  const isolated = createLocalChatManager(config); try { const running = isolated.install('fixture'); await reached; await isolated.cancel(); assert.equal((await running).errorCode, 'cancelled'); assert.equal((await isolated.status()).activeModelId, ''); } finally { await isolated.shutdown(); }
});
console.log('local-chat: verified selection, probes, memory, cancellation, provider changes and explicit removal passed');
