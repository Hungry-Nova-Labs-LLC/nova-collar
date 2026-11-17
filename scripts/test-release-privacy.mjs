import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require=createRequire(import.meta.url);
const {assertReleaseSource,textFindings}=require('./release-source-preflight.cjs');

function fixture(run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nova-release-privacy-'));
  const write=(relative,text)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
  try {return run({root,write});} finally {fs.rmSync(root,{recursive:true,force:true});}
}
test('release inspection includes hidden and ignored files rather than trusting ignore rules',()=>fixture(({root,write})=>{
  write('README.md','Nova Collar by Hungry Nova Labs LLC.\n');
  write('.gitignore','.env\nprivate/\n');
  write('.github/workflows/test.yml','name: Synthetic checks\n');
  let report=assertReleaseSource(root);
  assert.deepEqual(report.files.map(row=>row.path),['.github/workflows/test.yml','.gitignore','README.md']);
  write('.env','EXAMPLE_PRIVATE_SETTING=fixture\n');
  assert.throws(()=>assertReleaseSource(root),error=>error.code==='NOVA_RELEASE_SOURCE_PRIVACY'&&error.report.violations.some(row=>row.path==='.env'));
}));
test('packaging fails closed on cloud conflict copies, unreviewed binaries and source symlinks',()=>fixture(({root,write})=>{
  const canonical=write('src/main/example.js','export const example=true;\n');
  assertReleaseSource(root);
  const copy=write('src/renderer/index 2.html','<p>Unreviewed copied content</p>');
  assert.throws(()=>assertReleaseSource(root),/conflict copy/);fs.rmSync(copy);
  const unknown=write('src/main/unknown.bin',Buffer.from([0,255,1]));
  assert.throws(()=>assertReleaseSource(root),/unexpected binary/);fs.rmSync(unknown);
  fs.symlinkSync(canonical,path.join(root,'src/main/alias.js'));
  assert.throws(()=>assertReleaseSource(root),/source symlink/);
}));
test('source inspection rejects private narrative, operator paths and credential-shaped content',()=>{
  assert(textFindings('src/renderer/index.html','Thanks to my wife for her support.').includes('personal narrative'));
  assert(textFindings('docs/example.md','/Users/operator/secret-work').includes('operator home path'));
  assert(textFindings('data/settings.json','https://10.20.30.40/v1').includes('private infrastructure URL'));
  assert(textFindings('src/main/example.js','gh'+'p_'+'A'.repeat(36)).includes('credential-shaped content'));
  assert.deepEqual(textFindings('scripts/test-example.mjs','sk-fixtureSyntheticValue1234567890'),[]);
});
test('generated renderer dependencies are restricted to their declared public recipe',()=>fixture(({root,write})=>{
  write('src/renderer/app.js','// public app\n');
  write('src/renderer/vendor/xterm.js','// generated dependency\n');
  assertReleaseSource(root);
  write('src/renderer/vendor/session.json','{}');
  assert.throws(()=>assertReleaseSource(root),/unexpected generated renderer asset/);
}));
test('public credits retain corporate and upstream attribution without personal stories or slogans',()=>{
  const html=fs.readFileSync(new URL('../src/renderer/index.html',import.meta.url),'utf8');
  const credits=html.slice(html.indexOf('id="credits-crawl"'),html.indexOf('id="approval-dialog"'));
  assert(credits.includes('Nova Collar is developed and maintained by Hungry Nova Labs LLC.'));
  assert.deepEqual(textFindings('src/renderer/index.html',credits),[]);
  assert(!/own your data\. own your future/i.test(credits));
  for(const upstream of ['MIT','Apache 2.0','Christopher Jeffrey','Ryan Day','morluto','GPLv2']) assert(credits.includes(upstream));
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.author,'Hungry Nova Labs LLC');
  assert.equal(pkg.build.publish.owner,'Hungry-Nova-Labs-LLC');
  assert.equal(pkg.build.publish.repo,'nova-collar');
});
