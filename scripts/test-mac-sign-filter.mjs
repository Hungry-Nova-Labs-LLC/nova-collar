import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {filteredSigningOptions,createMachOFilter}=require('./sign-mac-code.cjs');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-code-filter-')),app=path.join(dir,'Nova Collar.app');
 fs.mkdirSync(path.join(app,'Contents/Resources/java/Contents'),{recursive:true});
 fs.writeFileSync(path.join(app,'Contents/Resources/java/Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>libjli.dylib</string><key>CFBundlePackageType</key><string>BNDL</string></dict></plist>');
 const native=path.join(app,'Contents/Resources/native'),gif=path.join(app,'Contents/Resources/executable.gif'),java=path.join(app,'Contents/Resources/Java.class');
 fs.writeFileSync(native,Buffer.from('cffaedfe00000000','hex'));
 fs.writeFileSync(gif,Buffer.from('GIF89a\0\0\0\0'));fs.chmodSync(gif,0o755);
 fs.writeFileSync(java,Buffer.from('cafebabe0000003d','hex'));
 fs.symlinkSync('native',path.join(app,'Contents/Resources/native-alias'));
 fs.symlinkSync('Resources',path.join(app,'Contents/linked-resources'));
 return{dir,app,native,gif,java};
}
test('native signing excludes images, Java classes and symlink aliases while retaining bundles',()=>{
 const f=fixture();try{
  let descriptions=0;
  const options=filteredSigningOptions({app:f.app},file=>{descriptions++;return file===f.java?'compiled Java class data':'Mach-O 64-bit bundle arm64';});
  assert.equal(options.ignore(f.native),false);assert.equal(options.ignore(f.gif),true);assert.equal(options.ignore(f.java),true);
  assert.equal(options.ignore(path.join(f.app,'Contents/Resources/native-alias')),true);
  assert.equal(options.ignore(path.join(f.app,'Contents/linked-resources/native')),true);
  assert.equal(options.ignore(f.app),false);
  assert(options.binaries.includes(path.join(f.app,'Contents/Resources/java')));
  assert.equal(options.ignore(path.join(f.app,'Contents/Resources/java')),false);
  assert.equal(descriptions,2,'only native magic candidates reach file identification');
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('caller exclusions and timestamp options are retained; outside targets are rejected',()=>{
 const f=fixture();try{
  const optionsForFile=()=>({timestamp:'none',hardenedRuntime:true});
  const options=filteredSigningOptions({app:f.app,ignore:file=>file===f.native,optionsForFile},()=> 'Mach-O');
  assert.equal(options.ignore(f.native),true);assert.equal(options.optionsForFile,optionsForFile);
  assert.throws(()=>options.ignore(path.join(f.dir,'outside')),/outside the application/);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('current macOS runtime is recognized as actual Mach-O',{skip:process.platform!=='darwin'},()=>{
 assert.equal(createMachOFilter()(fs.realpathSync(process.execPath)),true);
});
test('build cleanup removes only forbidden Finder metadata and preserves quarantine and other attributes',{skip:process.platform!=='darwin'},()=>{
 const f=fixture();try{
  const {execFileSync}=require('node:child_process');
  const {cleanMacBuildMetadata}=require('./clean-mac-build-metadata.cjs');
  const xattr=(args)=>execFileSync('/usr/bin/xattr',args,{encoding:'utf8'});
  xattr(['-w','-x','com.apple.FinderInfo','00'.repeat(31)+'01',f.app]);
  xattr(['-w','com.apple.ResourceFork','fixture-fork',f.gif]);
  for(const target of [f.app,f.gif]){
    xattr(['-w','com.hungrynova.fixture','preserve-other',target]);
    xattr(['-w','com.apple.quarantine','0081;00000000;Fixture;',target]);
  }
  const outside=path.join(f.dir,'outside-data');fs.writeFileSync(outside,'outside');
  xattr(['-w','com.apple.ResourceFork','outside-unchanged',outside]);
  fs.symlinkSync(outside,path.join(f.app,'Contents/Resources/outside-link'));
  const cleanup=cleanMacBuildMetadata(f.app);
  assert.equal(cleanup['com.apple.FinderInfo'],1);assert.equal(cleanup['com.apple.ResourceFork'],1);
  for(const target of [f.app,f.gif]){
    const attrs=xattr([target]).trim().split('\n');
    assert(!attrs.includes('com.apple.FinderInfo'));assert(!attrs.includes('com.apple.ResourceFork'));
    assert.equal(xattr(['-p','com.hungrynova.fixture',target]).trim(),'preserve-other');
    assert.equal(xattr(['-p','com.apple.quarantine',target]).trim(),'0081;00000000;Fixture;');
  }
  assert.equal(xattr(['-p','com.apple.ResourceFork',outside]).trim(),'outside-unchanged');
  assert.throws(()=>cleanMacBuildMetadata(f.dir),/\.app directory/);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
