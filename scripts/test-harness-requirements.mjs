import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root = mkdtempSync(join(tmpdir(), 'nova-requirements-'));
mkdirSync(join(root, 'profile'));
process.env.NOVAPUP_HOME = join(root, 'profile');
const {coverAsk, createHarness, extractAsks, namedCode, protectedCode, proofAsks} = await import('../src/main/harness.js');
const {setWorkdir} = await import('../src/main/workdir.js');
const exec = promisify(execFile);
after(() => rmSync(root, {recursive: true, force: true}));

async function localExec(command, options = {}) {
  try {
    const result = await exec(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
      {cwd: options.cwd || root, timeout: options.timeoutMs || 10000, maxBuffer: 128 * 1024, env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
    return {ok: true, exitCode: 0, ...result};
  } catch (error) {
    return {ok: false, exitCode: error.code, stdout: error.stdout || '', stderr: error.stderr || '', error: error.message};
  }
}

function fixture(name) {
  const path = join(root, name);
  mkdirSync(path);
  setWorkdir(path);
  return path;
}

const apiAsk = 'Add worker/queue.py exporting Dispatcher with send(fn, *args, **kwargs)';
const source = '__all__ = ["Dispatcher"]\nclass Dispatcher:\n    def send(self, fn, *args, **kwargs):\n        return fn(*args, **kwargs)\n';

test('positive file obligations exclude local negative, protected and read-only references', () => {
  const ask = 'Add src/worker.js. Do not change src/config.js. Keep package.json, test-contract.mjs unchanged. Read helper.py then update src/parser.py.';
  assert.deepEqual(namedCode(ask), ['src/worker.js', 'src/parser.py']);
  assert.deepEqual(protectedCode(ask), ['src/config.js', 'package.json', 'test-contract.mjs']);
  assert.deepEqual(namedCode('Do not edit old.py, but fix new.py and keep stable.py unchanged.'), ['new.py']);
  assert.deepEqual(namedCode('Fix main.py without editing library.py.'), ['main.py']);
  assert.deepEqual(namedCode('Create but.py. What does existing.py do?'), ['but.py']);
  assert.deepEqual(extractAsks('- Do not edit config.js\n- Keep README.md unchanged'), []);
  assert.deepEqual(namedCode('What does parser.py do?'), []);
  assert.deepEqual(namedCode('What does add.py do?'), []);
  assert.deepEqual(namedCode('Update main.js except config.js'), ['main.js']);
  assert.deepEqual(extractAsks('- No edits to config.js\n- Leave README.md as-is\n- package.json must remain unchanged'), []);
  assert.deepEqual(protectedCode('Protected files: config.js, package.json'), ['config.js', 'package.json']);
  assert.deepEqual(protectedCode('Do not change /tmp/project/config.js'), ['/tmp/project/config.js']);
  const longApi = 'Add modules/long_module_name.py exporting ServiceCoordinator with dispatch(callback, *arguments, **keyword_arguments)';
  assert.ok(extractAsks(longApi).includes(longApi), 'standalone and long API contracts remain required');
});

test('module contract requires file-scoped runtime API evidence, not prose or source tokens', () => {
  const evidence = {paths: ['/tmp/project/worker/queue.py'], texts: [source]};
  assert.equal(coverAsk(apiAsk, evidence), false, 'source alone is not observed callable API proof');
  const checked = {symbol: 'Dispatcher', method: 'send', variadicPositional: true, variadicKeyword: true};
  const apiByPath = new Map([[evidence.paths[0], [checked]]]);
  assert.equal(coverAsk(apiAsk, {...evidence, apiByPath}), true);
  assert.equal(coverAsk(apiAsk, {...evidence, apiByPath, paths: ['/tmp/project/other/queue.py']}), false);
  if (process.platform !== 'win32') {
    const wrongCase = '/tmp/nonexistent-nova-case-proof/worker/Queue.py';
    assert.equal(coverAsk(apiAsk, {paths: [wrongCase], apiByPath: new Map([[wrongCase, [checked]]])}), false, 'case folding alone cannot prove a POSIX target');
  }
  assert.equal(coverAsk(apiAsk, {...evidence, apiByPath: new Map([[evidence.paths[0], [{...checked, method: 'receive'}]]])}), false);
  assert.equal(coverAsk(apiAsk, {...evidence, apiByPath: new Map([[evidence.paths[0], [{...checked, variadicKeyword: false}]]])}), false);
});

test('literal output obligations require observed output, not source containing the token', () => {
  assert.equal(coverAsk('check.js prints CHECK_OK', {paths: ['check.js'], texts: ['console.log("CHECK_OK")']}), false);
  assert.equal(coverAsk('check.js prints CHECK_OK', {paths: ['check.js'], runOut: 'CHECK_OK\n'}), true);
  assert.equal(coverAsk('check.js prints CHECK_OK', {paths: ['other.js'], runOut: 'CHECK_OK\n'}), false);
  assert.equal(coverAsk('check.js prints CHECK_OK', {paths: ['check.js', 'other.js'], runByPath: new Map([['check.js', ''], ['other.js', 'CHECK_OK\n']])}), false);
});

test('production harness accepts verified API implementation and keeps protected files intact', async () => {
  const dir = fixture('api-pass');
  mkdirSync(join(dir, 'worker'));
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(join(dir, 'config.js'), 'export const stable = true;\n');
  const path = join(dir, 'worker/queue.py');
  const gate = createHarness({ask: `- ${apiAsk}\n- Keep package.json unchanged\n- Do not change config.js`, localExec});
  assert.deepEqual(gate.debt(), ['write and run worker/queue.py', `ask:${apiAsk}`]);
  const denied = gate.before('host_file_write', {path: join(dir, 'config.js'), content: 'changed'});
  assert.equal(denied.ok, false);
  assert.match(denied.detail, /unchanged/);
  assert.equal(gate.before('host_file_write', {path, content: source}), null);
  writeFileSync(path, source);
  const result = await gate.after('host_file_write', {path, content: source}, {ok: true, path});
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(gate.debt(), []);
  assert.equal(readFileSync(join(dir, 'config.js'), 'utf8'), 'export const stable = true;\n');
  assert.equal(gate.progressState()[0].initialHash, null);
  const before = gate.progressState();
  gate.note('host_file_read', {path}, {ok: true, path, text: source});
  assert.deepEqual(gate.progressState(), before, 'a read is not progress');
});

test('production harness keeps missing API, wrong directory and real runtime failures open', async () => {
  const dir = fixture('api-fail');
  mkdirSync(join(dir, 'worker'));
  mkdirSync(join(dir, 'other'));
  const wrong = join(dir, 'other/queue.py');
  const gate = createHarness({ask: `- ${apiAsk}`, localExec});
  writeFileSync(wrong, source);
  assert.equal((await gate.after('host_file_write', {path: wrong, content: source}, {ok: true, path: wrong})).ok, false);
  assert.ok(gate.debt().includes('write and run worker/queue.py'));
  const path = join(dir, 'worker/queue.py');
  const missing = source.replace('def send', 'def receive');
  writeFileSync(path, missing);
  assert.equal((await gate.after('host_file_write', {path, content: missing}, {ok: true, path})).ok, false);
  assert.ok(gate.debt().includes(`ask:${apiAsk}`));
  writeFileSync(path, source);
  assert.equal((await gate.after('host_file_write', {path, content: source}, {ok: true, path})).ok, true);
  writeFileSync(path, missing);
  assert.equal((await gate.after('host_file_write', {path, content: missing}, {ok: true, path})).ok, false, 'removing an API invalidates previous coverage');
  const crash = join(dir, 'crash.py'), broken = 'raise RuntimeError("actual failure")\n';
  const runtime = createHarness({ask: 'Write crash.py', localExec});
  writeFileSync(crash, broken);
  assert.equal((await runtime.after('host_file_write', {path: crash, content: broken}, {ok: true, path: crash})).ok, false);
  assert.ok(runtime.debt().some((entry) => entry.includes('crash.py')));
});

test('protected shell/external changes remain explicit debt until original bytes are restored', () => {
  const dir = fixture('protected-change'), file = join(dir, 'stable.json');
  writeFileSync(file, '{"original":true}\n');
  const gate = createHarness({ask: 'Create worker.js. Keep stable.json unchanged.'});
  writeFileSync(file, '{"changed":true}\n');
  assert.ok(gate.debt().includes('protected file changed: stable.json'));
  assert.equal(gate.before('host_file_write', {path: file, content: '{"original":true}\n'}), null, 'exact restoration is allowed');
  writeFileSync(file, '{"original":true}\n');
  assert.ok(!gate.debt().some((item) => item.includes('stable.json')));
});

test('production API evidence accepts inherited and re-exported implementations', async () => {
  const dir = fixture('reexport-api');
  mkdirSync(join(dir, 'worker'));
  writeFileSync(join(dir, 'worker/__init__.py'), '');
  writeFileSync(join(dir, 'worker/base.py'), 'class Base:\n    def send(self, fn, *args, **kwargs):\n        return fn(*args, **kwargs)\nclass Dispatcher(Base):\n    pass\n');
  const path = join(dir, 'worker/queue.py'), imported = 'from .base import Dispatcher\n';
  const gate = createHarness({ask: `- ${apiAsk}`, localExec});
  writeFileSync(path, imported);
  const result = await gate.after('host_file_write', {path, content: imported}, {ok: true, path});
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(gate.debt(), []);
});

test('review intent adds no edit obligations but still verifies any actual writes', async () => {
  const dir = fixture('review-intent'), path = join(dir, 'helper.js');
  const gate = createHarness({ask: 'Explain how to fix helper.js without editing it.', requireEdits: false, localExec});
  assert.deepEqual(gate.debt(), []);
  const broken = 'throw Error("actual failure");\n';
  writeFileSync(path, broken);
  assert.equal((await gate.after('host_file_write', {path, content: broken}, {ok: true, path})).ok, false);
  assert.ok(gate.debt().length);
});

test('production ES API checks require a callable export and record its actual probe', async () => {
  const dir = fixture('es-api'), path = join(dir, 'api.mjs');
  const ask = 'Add api.mjs exporting async execute(input)';
  const gate = createHarness({ask, localExec, sessionId: 'es-api-chat'});
  const source = 'export async function execute(input) { return input; }\n';
  writeFileSync(path, source);
  const pass = await gate.after('host_file_write', {path, content: source}, {ok: true, path});
  assert.equal(pass.ok, true, pass.detail);
  assert.equal(pass.verification.phase, 'runtime');
  assert.match(pass.verification.command, /execute/);
  assert.deepEqual(gate.debt(), []);
  const missing = 'export const execute = 1;\n';
  writeFileSync(path, missing);
  const failed = await gate.after('host_file_write', {path, content: missing}, {ok: true, path});
  assert.equal(failed.ok, false);
  assert.equal(failed.verification.status, 'failed');
  assert.ok(gate.debt().includes(`ask:${ask}`));
});

test('review-only steering suspends inferred edit debt without clearing real failures or protection', async () => {
  const dir = fixture('stage-steering'), stable = join(dir, 'stable.json'), path = join(dir, 'broken.js');
  writeFileSync(stable, '{}\n');
  const gate = createHarness({ask: 'Write wanted.py. Keep stable.json unchanged.', localExec, sessionId: 'stage-steering-chat'});
  assert.ok(gate.debt().includes('write and run wanted.py'));
  gate.setRequireEdits(false);
  assert.deepEqual(gate.debt(), []);
  assert.equal(gate.before('host_file_write', {path: stable, content: 'changed'}).ok, false);
  const source = 'throw Error("actual failing check");\n';
  writeFileSync(path, source);
  assert.equal((await gate.after('host_file_write', {path, content: source}, {ok: true, path})).ok, false);
  gate.setRequireEdits(true);
  assert.ok(gate.debt().includes('write and run wanted.py'));
  gate.setRequireEdits(false);
  assert.ok(gate.debt().some((item) => item.includes('broken.js')), 'actual runtime failure survives both steering changes');
  assert.ok(!gate.debt().includes('write and run wanted.py'));
});

test('cached plain-text progress proves changed bytes without inventing verification or no-op progress', async () => {
  const {createTurnProgress} = await import('../src/main/turn-policy.js');
  const dir = fixture('text-progress'), path = join(dir, 'notes.txt');
  writeFileSync(path, 'before\n');
  const gate = createHarness({ask: 'Fix notes.txt.', sessionId: 'text-progress-chat'});
  gate.note('host_file_read', {path}, {ok: true, path, text: 'before\n'});
  assert.deepEqual(gate.progressState(), []);
  assert.equal(gate.before('host_file_write', {path, content: 'after\n'}), null);
  const progress = createTurnProgress(gate.progressState());
  writeFileSync(path, 'after\n');
  await gate.after('host_file_write', {path, content: 'after\n'}, {ok: true, path});
  const rows = gate.progressState();
  assert.equal(rows[0].status, 'unverified');
  assert.equal(rows[0].phase, undefined);
  assert.notEqual(rows[0].hash, rows[0].initialHash);
  progress.observe(rows, 1);
  assert.equal(progress.changed, true);
  const revision = progress.revision;
  assert.equal(gate.before('host_file_write', {path, content: 'after\n'}), null);
  writeFileSync(path, 'after\n');
  await gate.after('host_file_write', {path, content: 'after\n'}, {ok: true, path});
  progress.observe(gate.progressState(), 2);
  assert.equal(progress.revision, revision, 'an identical rewrite earns no new revision');
});

test('canonical ledger paths retain before-write hashes for syntax-only new files and no-op rewrites', async () => {
  const {createTurnProgress} = await import('../src/main/turn-policy.js');
  for (const existing of [false, true]) {
    const dir = fixture('canonical-progress-' + existing), path = join(dir, 'utility.mjs'), source = 'export const value = 1;\n';
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname="fixture"\n');
    if (existing) writeFileSync(path, source);
    const gate = createHarness({ask: 'Implement utility.mjs.', localExec, trackProjects: true, sessionId: 'canonical-progress-' + existing});
    if (existing) gate.note('host_file_read', {path}, {ok: true, path, text: source});
    assert.equal(gate.before('host_file_write', {path, content: source}), null);
    const progress = createTurnProgress(gate.progressState());
    writeFileSync(path, source);
    const proof = await gate.after('host_file_write', {path, content: source}, {ok: true, path});
    assert.equal(proof.verification.phase, 'syntax', 'the project module was not launched');
    const rows = gate.progressState(), file = rows.find(row => row.kind === 'file');
    assert.equal(Object.hasOwn(file, 'initialHash'), true, 'canonical path aliases retain the before-write hash');
    assert.equal(file.initialHash === file.hash, existing);
    progress.observe(rows, 1);
    assert.equal(progress.changed, !existing, 'only an actual absent-to-present change counts');
  }
});

test('ordinary prose stays explicitly unverified without lexical pass or fabricated failure', async () => {
  const dir = fixture('advisory-prose'), path = join(dir, 'feature.mjs');
  const requirement = 'Provide a welcoming experience with clear visual feedback';
  const source = 'export const feature = true;\n';
  assert.equal(coverAsk(requirement, {paths: [path], texts: [requirement]}), false, 'copying prose into source is not proof');
  const gate = createHarness({ask: `Write feature.mjs.\n- ${requirement}`, localExec});
  writeFileSync(path, source);
  const result = await gate.after('host_file_write', {path, content: source}, {ok: true, path});
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(gate.debt(), []);
  assert.deepEqual(result.advisories, [{requirement, status: 'unverified', blocking: false, reason: 'Requires task-specific evidence or review; this harness has not automatically verified it.'}]);
  assert.match(result.detail, /remain unverified/);
  assert.match(gate.context(), /not automatically passed or failed/);
  assert.equal(coverAsk('Use Python for this implementation', {paths: ['feature.js']}), false);
  assert.equal(coverAsk('Use Python for this implementation', {paths: ['feature.py']}), true);
});

test('output inference honors negative and protected clauses while preserving positive path-scoped proof', () => {
  for (const ask of [
    'Do not run old.js that prints OLD_OK.',
    'Do not change legacy/check.js; legacy/check.js is protected.',
    'Keep legacy/check.js unchanged; it prints OLD_OK.',
    'Protected files: legacy/check.js that prints OLD_OK.',
    'Never execute old.py which prints OLD_OK.',
  ]) assert.deepEqual(proofAsks(ask), [], ask);
  assert.deepEqual(proofAsks('Do not run old.js that prints OLD_OK. Add checks/new.js that prints exactly NEW_OK.'), ['checks/new.js prints NEW_OK']);
});

test('run-only execution proves output without inventing edits and preserves genuine failures', async () => {
  const dir = fixture('run-only-output'), path = join(dir, 'check.js'), command = 'node check.js';
  writeFileSync(path, 'console.log("SCRIPT_OK");\n');
  const gate = createHarness({ask: 'Run check.js and confirm it prints SCRIPT_OK.', requireEdits: false, requireExecution: true, localExec, sessionId: 'run-only-output-chat'});
  assert.deepEqual(gate.debt(), ['ask:check.js prints SCRIPT_OK']);
  assert.ok(!gate.debt().some((item) => item.includes('write and run')));
  const args = {command, cwd: dir};
  gate.before('host_run', args);
  const raw = await localExec(command, {cwd: dir});
  const passed = await gate.after('host_run', args, raw);
  assert.equal(passed.ok, true, passed.detail);
  assert.equal(passed.verification.phase, 'runtime');
  assert.match(passed.stdout, /SCRIPT_OK/);
  assert.deepEqual(gate.debt(), []);
  writeFileSync(path, 'console.log("WRONG_OUTPUT");\n');
  gate.before('host_run', args);
  const failed = await gate.after('host_run', args, await localExec(command, {cwd: dir}));
  assert.equal(failed.ok, false);
  assert.equal(failed.verification.status, 'failed');
  assert.match(failed.detail, /Expected output missing/);
  writeFileSync(join(dir, 'log.txt'), 'SCRIPT_OK\n');
  const logArgs = {command: 'cat log.txt', cwd: dir};
  gate.before('host_run', logArgs);
  assert.equal(await gate.after('host_run', logArgs, await localExec(logArgs.command, {cwd: dir})), null, 'reading an old token is not program execution proof');
  assert.ok(gate.debt().some((item) => item.startsWith('failed ')));
  gate.setRequireEdits(false);
  assert.ok(gate.debt().some((item) => item.startsWith('failed ')), 'review narrowing preserves the actual failed runtime check');
  assert.ok(!gate.debt().some((item) => item.startsWith('ask:')));
});

test('execute-only authorization stays bound to positively requested existing scripts or declared checks', () => {
  const dir = fixture('execute-only-scope');
  for (const name of ['check.js', 'other.js', 'test.js', 'build.js']) writeFileSync(join(dir, name), 'console.log("okay");\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({scripts: {test: 'node test.js', build: 'node build.js'}}));
  const gate = createHarness({ask: 'Run check.js without editing.', requireEdits: false, requireExecution: true});
  assert.equal(gate.allowsRequestedExecution('node check.js', dir), true);
  for (const command of ['node other.js', 'node missing.js', 'node -e "console.log(1)"', 'node check.js; touch changed', 'hostname changed']) assert.equal(gate.allowsRequestedExecution(command, dir), false, command);
  gate.setRequireExecution(true, 'Run tests without editing.');
  assert.equal(gate.allowsRequestedExecution('npm test', dir), true);
  assert.equal(gate.allowsRequestedExecution('npm run test', dir), true);
  assert.equal(gate.allowsRequestedExecution('npm run build', dir), false);
  assert.equal(gate.allowsRequestedExecution('npm test -- --updateSnapshots', dir), false);
  const outside = fixture('execute-only-other-project');
  writeFileSync(join(outside, 'package.json'), JSON.stringify({scripts: {test: 'node test.js'}}));
  assert.equal(gate.allowsRequestedExecution('npm test', outside), false);
  setWorkdir(dir);
  gate.setRequireExecution(false);
  assert.equal(gate.allowsRequestedExecution('npm test', dir), false);
  gate.setRequireExecution(true, 'Do not run check.js. Review only.');
  assert.equal(gate.allowsRequestedExecution('node check.js', dir), false);
});

test('a prior library runtime failure receives a real package-aware recheck instead of remaining syntax-only', async () => {
  const {VerificationLedger} = await import('../src/main/verification-ledger.js');
  const dir = fixture('resumed-package-runtime'), pkg = join(dir, 'src', 'package');
  mkdirSync(pkg, {recursive: true});
  writeFileSync(join(dir, 'requirements.txt'), '');
  writeFileSync(join(pkg, '__init__.py'), '');
  writeFileSync(join(pkg, 'helper.py'), 'value = 42\n');
  const path = join(pkg, 'module.py'), source = 'from .helper import value\n';
  writeFileSync(path, source);
  const sessionId = 'resumed-package-runtime';
  const old = new VerificationLedger(sessionId, dir);
  old.checked(path, {ok: false, phase: 'runtime', command: 'python3 module.py', diagnostic: 'old standalone package invocation failed'});
  const gate = createHarness({ask: 'Fix the package behavior.', sessionId, localExec, trackProjects: true});
  gate.note('host_file_read', {path}, {ok: true, path, text: source});
  assert.equal(gate.before('host_file_write', {path, content: source}), null);
  writeFileSync(path, source);
  const result = await gate.after('host_file_write', {path, content: source}, {ok: true, path});
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.verification.phase, 'runtime');
  assert.equal(result.verification.status, 'passed');
  assert.deepEqual(gate.debt(), []);
});
