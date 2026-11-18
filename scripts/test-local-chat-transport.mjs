import assert from 'node:assert/strict';
import { managedChatBody } from '../src/main/local-chat-transport.js';
const tools = ['read', 'write'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
const body = { messages: [{ role: 'user', content: 'unchanged' }], tools, tool_choice: { type: 'function', function: { name: 'write' } }, temperature: 0.2, max_tokens: 4096, stream: true };
const original = JSON.stringify(body), converted = managedChatBody(body);
assert.equal(converted.tool_choice, 'required'); assert.equal(converted.parallel_tool_calls, false); assert.deepEqual(converted.tools, [tools[1]]);
assert.equal(converted.messages, body.messages); assert.equal(converted.max_tokens, 4096); assert.equal(converted.temperature, 0.2); assert.equal(JSON.stringify(body), original);
for (const tool_choice of ['auto', 'none', 'required', undefined]) { const value = { ...body, tool_choice }; assert.equal(managedChatBody(value), value); }
for (const value of [{ ...body, tools: [] }, { ...body, tools: [tools[1], tools[1]] }, { ...body, tool_choice: {} }, { ...body, tool_choice: { type: 'function', function: { name: 'missing' } } }]) assert.throws(() => managedChatBody(value));
console.log('local-chat-transport: named forcing, fail-closed validation and payload preservation passed');
