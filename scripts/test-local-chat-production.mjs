import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './local-chat-fixture.mjs';
const f = await fixture(); process.env.NOVAPUP_HOME = f.home; process.env.NP_LAYA_MODEL = join(f.home, 'absent-model'); process.env.HNL_MODEL = 'local-3.8'; process.env.OLLAMA_MODEL = 'fixture-local-chat';
for (const name of ['HNL_FAST_URL','HNL_FAST_MODEL','HNL_FAST_KEY','HNL_THINK_URL','HNL_THINK_MODEL','HNL_THINK_KEY']) process.env[name] = '';
const nativeFetch = globalThis.fetch;
const { complete, runTurn } = await import('../src/main/agent.js');
const { ensureHome, loadBaseConfig } = await import('../src/main/config.js');
const { managedSettingsUrl, writeLocalChatSelection } = await import('../src/main/local-chat-selection.js');
const target = { kind: 'managed-chat', managedLease: true, managedChatId: 'fixture', url: 'http://127.0.0.1:18797/v1', model: 'opaque-owned-alias', key: 'ephemeral-fixture-nonce', local: true, profileUrl: managedSettingsUrl('fixture'), profileModel: 'fixture', managedMetadata: { context: 8192, tools: true } };
const cfg = { ...f.base, home: f.home }, wires = [];
const sse = value => new Response(`data: ${JSON.stringify({ choices: [{ delta: value, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
try {
  await writeFile(join(f.home, 'model-settings.json'), JSON.stringify({ version: 1, profiles: [{ url: target.profileUrl, model: 'fixture', contextTokens: 131072, outputTokens: 4096, temperature: 0.2, reasoning: false }] }));
  globalThis.fetch = async (url, options) => { assert.equal(url, target.url + '/chat/completions'); assert.equal(options.headers.Authorization || options.headers.authorization, 'Bearer ' + target.key); const body = JSON.parse(options.body); wires.push(body); return sse({ tool_calls: [call('synthetic_check', { value: 'READY' }, 'call-1')] }); };
  const tools = ['unrelated', 'synthetic_check'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
  const answer = await complete([{ role: 'user', content: 'Check tools.' }], cfg, null, undefined, { target, tools, toolChoice: { type: 'function', function: { name: 'synthetic_check' } } });
  assert.equal(answer.tool_calls[0].function.name, 'synthetic_check'); assert.equal(wires[0].tool_choice, 'required'); assert.equal(wires[0].parallel_tool_calls, false); assert.deepEqual(wires[0].tools, [tools[1]]); assert.equal(wires[0].model, target.model); assert.equal(wires[0].options.num_ctx, 8192); assert.ok(wires[0].max_tokens <= 2048); assert.equal(wires[0].temperature, 0.2); assert.equal(wires[0].chat_template_kwargs.enable_thinking, false); assert.ok(!JSON.stringify(wires).includes(f.base.chatKey));
  let failures = 0; globalThis.fetch = async () => { failures++; return new Response('{"error":{"message":"unsupported choice"}}', { status: 400 }); };
  await assert.rejects(complete([], cfg, null, undefined, { target, tools, toolChoice: { type: 'function', function: { name: 'synthetic_check' } } })); assert.equal(failures, 1, 'managed named tool rejection must never fall back to auto');
  let cancelled = false; globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { cancelled = true; reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })); }, { once: true }));
  const stopped = new AbortController(), pending = complete([], cfg, null, stopped.signal, { target, tools: [] }); setTimeout(() => stopped.abort(), 5); await assert.rejects(pending); assert.equal(cancelled, true);
  // Genuine runTurn tools and verification use the same production SSE decoder.
  ensureHome(); const project = join(f.home, 'project'); await mkdir(project); await writeFile(join(project, 'feature.mjs'), 'export const value = 1;\n'); await writeFile(join(project, 'verify.mjs'), 'import assert from "node:assert/strict"; import {value} from "./feature.mjs"; assert.equal(value,2); console.log("LOCAL_GGUF_REPAIR_OK");\n');
  const { setWorkdir } = await import('../src/main/workdir.js'); const { createSession } = await import('../src/main/sessions.js'); const { windowToolDefs } = await import('../src/main/tools.js'); const { setApprovalNotifier, resolveApproval } = await import('../src/main/approvals.js'); const { VerificationLedger } = await import('../src/main/verification-ledger.js');
  setWorkdir(project); setApprovalNotifier(event => { if (event.type === 'approval') resolveApproval(event.request.id, true); });
  const session = createSession(), events = []; let requests = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); assert.equal(body.model, target.model); const source = ++requests;
    if (source === 1) return sse({ tool_calls: [call('host_file_read', { path: 'feature.mjs' }, 'read')] });
    if (source === 2) return sse({ tool_calls: [call('host_run', { command: 'node verify.mjs', cwd: project }, 'fail')] });
    if (source === 3) { assert.ok(new VerificationLedger(session.id, project).debt().length); return sse({ tool_calls: [call('host_file_write', { path: 'feature.mjs', content: 'export const value = 2;\n' }, 'repair')] }); }
    if (source === 4) return sse({ tool_calls: [call('host_run', { command: 'node verify.mjs', cwd: project }, 'pass')] });
    assert.equal(source, 5); return sse({ content: 'Repaired feature.mjs and ran unchanged verify.mjs. LOCAL_GGUF_REPAIR_OK was observed. No declared project suite was available.' });
  };
  try {
    const result = await runTurn([], 'Fix feature.mjs and verify it using the existing verify.mjs. Keep verification assertions unchanged.', event => events.push(event), AbortSignal.timeout(20000), { sessionId: session.id, tools: windowToolDefs({ local: true, remote: false, search: false }).filter(tool => ['host_file_read', 'host_file_write', 'host_run'].includes(tool.function.name)), complete: (messages, config, delta, signal, extra) => extra.requestKind === 'contract_review' ? { content: '{"findings":[],"limitations":[]}', tool_calls: [] } : complete(messages, config, delta, signal, { ...extra, target: { ...target, managedMetadata: { ...target.managedMetadata, context: 32768 } } }) });
    assert.equal(await readFile(join(project, 'feature.mjs'), 'utf8'), 'export const value = 2;\n'); assert.deepEqual(new VerificationLedger(session.id, project).debt(), []); assert.match(result.assistant, /LOCAL_GGUF_REPAIR_OK/); assert.equal(events.filter(event => event.type === 'tool_result' && event.name === 'host_run').length, 2);
  } finally { setApprovalNotifier(null); }
  // Match the normal main entry point: no extra.tools override, a genuine
  // session and ask_user callback, full standing policy and native disclosure.
  // The earlier protocol smoke check deliberately has a much smaller prompt.
  await unlink(join(f.home, 'model-settings.json'));
  await writeFile(join(project, 'QA.txt'), 'SYNTHETIC_CONTEXT_NONCE');
  const { readLocalChatCatalog } = await import('../src/main/local-model-assets.js');
  const { estimatedTokens } = await import('../src/main/context.js');
  const { requestBudget } = await import('../src/main/request-budget.js');
  const curated = (await readLocalChatCatalog()).models;
  for (const id of ['qwen35-2b-q4', 'qwen35-4b-q4', 'qwen35-9b-q4']) assert.equal(curated.find(row => row.id === id).contextTokens, 32768, id + ' needs the full harness window');
  const admission = [];
  for (const context of [8192, ...new Set(curated.map(row => row.contextTokens))]) {
    writeLocalChatSelection(f.home, loadBaseConfig(), { id: 'fixture', label: 'Synthetic context', contextTokens: context, tools: true });
    const selectedTarget = { ...target, managedMetadata: { context, output: 4096, tools: true } };
    let requests = 0, composition; const observed = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(url, target.url + '/chat/completions'); const body = JSON.parse(options.body); requests++;
      assert.equal(body.options.num_ctx, context); assert.equal(body.max_tokens, 4096);
      assert.match(body.messages.find(row => row.role === 'system').content, /Risky actions pause for Allow once/);
      if (requests === 1) {
        for (const name of ['host_file_read', 'context_info', 'context_recall', 'ask_user', 'discover_tools']) assert.ok(body.tools.some(tool => tool.function.name === name), name + ' is retained');
        return sse({ tool_calls: [call('host_file_read', { path: 'QA.txt' }, 'full-catalog-read')] });
      }
      assert.equal(requests, 2); assert.match(body.messages.find(row => row.role === 'tool' && row.tool_call_id === 'full-catalog-read').content, /SYNTHETIC_CONTEXT_NONCE/);
      return sse({ content: 'QA.txt contains SYNTHETIC_CONTEXT_NONCE.' });
    };
    const normalTurn = () => runTurn([], 'Read only QA.txt in the current workspace and report its exact short text. Do not run commands or modify files.', event => observed.push(event), AbortSignal.timeout(10000), {
      sessionId: createSession().id, goal: '', askUser: async () => { throw new Error('Unexpected question'); },
      complete(messages, config, delta, signal, extra) {
        composition ||= { messageTokens: estimatedTokens(messages), schemaTokens: estimatedTokens(extra.tools || []), ...requestBudget(config, selectedTarget, extra) };
        return complete(messages, config, delta, signal, { ...extra, target: selectedTarget });
      },
    });
    if (context === 8192) { await assert.rejects(normalTurn(), /current request, tool evidence and tool catalog exceed/); assert.equal(requests, 0); assert.ok(composition.messageTokens + composition.schemaTokens + composition.outputTokens + 512 > context); }
    else { assert.match((await normalTurn()).assistant, /SYNTHETIC_CONTEXT_NONCE/); assert.equal(requests, 2); assert.equal(observed.filter(event => event.type === 'tool_result' && event.name === 'host_file_read').length, 1); }
    admission.push({ context, requests, ...composition });
  }
  assert.equal(await readFile(join(project, 'QA.txt'), 'utf8'), 'SYNTHETIC_CONTEXT_NONCE');
  console.log('local-chat-production: actual SSE/tool transport, stable context profiles, no forced-call fallback, Stop, repair verification and full main-style context admission passed');
} finally { globalThis.fetch = nativeFetch; await f.cleanup(); }
