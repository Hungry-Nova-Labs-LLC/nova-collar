import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIB = 1024 ** 3;
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const string = s => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
export function gguf({ template = true, context = 8192, name = 'Synthetic local chat' } = {}) {
  const pairs = [['general.architecture', 'llama'], ['general.name', name], ['llama.context_length', context], ...(template ? [['tokenizer.chat_template', '{{ messages | tojson }}']] : [])];
  const metadata = pairs.map(([key, value]) => Buffer.concat([string(key), u32(typeof value === 'number' ? 4 : 8), typeof value === 'number' ? u32(value) : string(value)]));
  const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(pairs.length), ...metadata,
    string('token_embd.weight'), u32(2), u64(1), u64(16), u32(0), u64(0)]);
  return Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), Buffer.alloc(64)]);
}
export const sha = data => createHash('sha256').update(data).digest('hex');
export async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'nova-local-chat-test-'));
  const directory = join(home, 'local-chat', 'models'); await mkdir(directory, { recursive: true });
  const data = gguf(), asset = { file: 'fixture.gguf', bytes: data.length, sha256: sha(data), url: 'https://github.com/Hungry-Nova-Labs-LLC/nova-collar/releases/download/fixture/fixture.gguf' };
  const row = { id: 'fixture', label: 'Synthetic local chat', description: 'Test data only.', asset, contextTokens: 8192, tools: true, minMemoryGB: 4 };
  const base = { home, envFile: join(home, 'env'), model: 'remote-fixture', chatUrl: 'https://remote.invalid/v1', chatKey: 'fixture-private-credential', toolsKey: '', localModel: '', localUrl: '', localKey: '', fastUrl: 'https://fast.invalid/v1', fastModel: 'fast-fixture', fastKey: 'fast-credential', thinkUrl: '', thinkModel: '', thinkKey: '', capacity: {} };
  await writeFile(base.envFile, 'HNL_CHAT_URL=https://remote.invalid/v1\nHNL_CHAT_KEY=fixture-private-credential\n', { mode: 0o600 });
  return { home, directory, data, row, base, file: join(directory, asset.file), cleanup: () => rm(home, { recursive: true, force: true }) };
}
export async function seed(f, row = f.row, data = f.data) {
  await writeFile(join(f.directory, row.asset.file), data);
  await writeFile(join(f.home, 'local-chat', 'models.json'), JSON.stringify({ schemaVersion: 1, models: [row] }));
}
export function fakeRuntime() {
  let loaded = '', busy = false;
  const stats = { stops: 0, acquires: 0, releases: 0 };
  return { stats, loadedId: () => loaded, busy: () => busy, setBusy: value => { busy = value; },
    async stop() { stats.stops++; loaded = ''; busy = false; },
    async acquire(row, { signal } = {}) { if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); stats.acquires++; loaded = row.id; busy = true;
      return { target: { kind: 'managed-chat', managedChatId: row.id, model: 'opaque-runtime-alias', url: 'http://127.0.0.1:18799/v1', key: 'ephemeral-fixture-nonce', local: true, managedMetadata: { context: row.contextTokens, tools: row.tools } }, async release() { stats.releases++; busy = false; } }; },
  };
}
export const goodComplete = async (_messages, _cfg, _emit, signal, extra) => {
  if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
  return extra.tools?.length ? { content: '', tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'nova_local_check', arguments: '{"value":"READY"}' } }] } : { content: 'READY', tool_calls: [] };
};
