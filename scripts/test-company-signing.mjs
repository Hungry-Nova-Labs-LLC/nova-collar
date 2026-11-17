import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const notary=require('./notary.cjs');
const {releaseMac}=require('./release-mac.cjs');
const darwin=process.platform==='darwin';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nova-company-policy-'));
const team='SYNTHETIC1';
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
function certificate(label,organization,commonName){
 const key=path.join(temporary,label+'.key'),file=path.join(temporary,label+'.pem');
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',file,'-days','1',
  '-subj',`/C=US/O=${organization}/OU=${team}/CN=${commonName}`],{stdio:'pipe'});
 fs.chmodSync(key,0o600);
 const pem=fs.readFileSync(file,'utf8'),parsed=new X509Certificate(pem);
 fs.rmSync(key);
 return {pem,parsed,...notary.certificateFields(parsed)};
}
let fixtures;
function policyFixture(){
 if(!fixtures){
  const company=certificate('company','Hungry Nova Labs LLC',`Developer ID Application: Hungry Nova Labs LLC (${team})`);
  const individual=certificate('individual','Fixture Individual',`Developer ID Application: Fixture Individual (${team})`);
  const misleading=certificate('misleading','Fixture Individual',`Developer ID Application: Hungry Nova Labs LLC (${team})`);
  fixtures={company,individual,misleading};
 }
 const {company,individual,misleading}=fixtures;
 const env={HNL_APPLE_SIGNING_SHA1:company.fingerprint,HNL_APPLE_TEAM_ID:team,APPLE_KEYCHAIN_PROFILE:'company-fixture'};
 const exec=(command,args)=>{
  assert.equal(command,'/usr/bin/security');
  if(args[0]==='find-identity') return [individual,misleading,company].map((row,index)=>`${index+1}) ${row.fingerprint} "${row.commonName}"`).join('\n');
  assert.equal(args[0],'find-certificate');return individual.pem+misleading.pem+company.pem;
 };
 return {company,individual,misleading,env,exec};
}
test('release credentials require a complete supported local route and never synthesize credentials',()=>{
 assert.equal(notary.authArgs({}),null);
 assert.equal(notary.authArgs({APPLE_API_KEY:'/fixture/key.p8',APPLE_API_KEY_ID:'FIXTURE'}),null);
 assert.equal(notary.authArgs({APPLE_ID:'sentinel-person@example.invalid',APPLE_APP_SPECIFIC_PASSWORD:'sentinel-password',APPLE_TEAM_ID:team}),null);
 assert.deepEqual(notary.authArgs({APPLE_KEYCHAIN_PROFILE:'company-fixture'}),['--keychain-profile','company-fixture']);
 assert.deepEqual(notary.authArgs({APPLE_API_KEY:'/fixture/key.p8',APPLE_API_KEY_ID:'FIXTURE',APPLE_API_KEY_INDIVIDUAL:'1'}),['--key','/fixture/key.p8','--key-id','FIXTURE']);
 assert.throws(()=>notary.releasePreflight({env:{},platform:'darwin'}),/notarization credentials/);
});
test('notarization captures a failing child and never exposes its sensitive output or Error',()=>{
 const modulePath=path.resolve('scripts/notary.cjs');
 const sensitive=['sentinel-password-123','sentinel-person@example.invalid','/private/sentinel-key-path/AuthKey_SENTINEL.p8'];
 const childScript=`
 const notary=require(${JSON.stringify(modulePath)});
 const {execFileSync}=require('node:child_process');
 const sensitive=${JSON.stringify(sensitive)};
 const env={APPLE_API_KEY:sensitive[2],APPLE_API_KEY_ID:'SENTINEL',APPLE_API_KEY_INDIVIDUAL:'1'};
 try {
  notary.notarize('/synthetic/app.zip',notary.authArgs(env),{env,preflight:()=>{},exec:(_command,_args,options)=>
   execFileSync(process.execPath,['-e','process.stdout.write('+JSON.stringify(sensitive.join(' '))+');process.stderr.write('+JSON.stringify(sensitive.join(' '))+');process.exit(7)'],options)});
  process.exitCode=1;
 } catch(error) {
  process.stdout.write(JSON.stringify({message:error.message,stack:error.stack,hasCause:'cause' in error,hasStdout:'stdout' in error,hasStderr:'stderr' in error,hasCmd:'cmd' in error}));
 }
 `;
 const output=execFileSync(process.execPath,['-e',childScript],{encoding:'utf8',stdio:'pipe'});
 for(const value of sensitive)assert(!output.includes(value),'sensitive child data escaped the boundary');
 const result=JSON.parse(output);
 assert.match(result.message,/failed or was not accepted/);
 for(const field of ['hasCause','hasStdout','hasStderr','hasCmd'])assert.equal(result[field],false);
});
test('notarization requires explicit Accepted JSON and returns only a safe receipt',()=>{
 const env={APPLE_KEYCHAIN_PROFILE:'company-fixture'},auth=notary.authArgs(env);
 const id='12345678-1234-1234-1234-123456789abc';
 const sensitive='sentinel-person@example.invalid /private/sentinel-key-path';
 for(const response of [JSON.stringify({status:'Invalid',id,message:sensitive}),JSON.stringify({status:'In Progress',id}),
  'not-json '+sensitive,JSON.stringify({status:'Accepted',id:sensitive})]){
  assert.throws(()=>notary.notarize('/synthetic/app.zip',auth,{env,preflight:()=>{},exec:()=>response}),error=>{
   assert.match(error.message,/failed or was not accepted/);assert(!String(error.stack).includes(sensitive));return true;
  });
 }
 const receipt=notary.notarize('/synthetic/app.zip',auth,{env,preflight:()=>{},exec:(command,args,options)=>{
  assert.equal(command,'xcrun');assert.equal(options.stdio,'pipe');assert.equal(options.encoding,'utf8');
  assert.deepEqual(args.slice(-3),['--wait','--output-format','json']);
  return JSON.stringify({status:'Accepted',id,message:sensitive,privatePath:sensitive});
 }});
 assert.deepEqual(receipt,{status:'Accepted',id});
 let invoked=false;
 assert.throws(()=>notary.notarize('/synthetic/app.zip',['--password','sentinel-password'],{env,preflight:()=>{invoked=true;},exec:()=>{invoked=true;}}),/Keychain or App Store Connect API/);
 assert.equal(invoked,false);
});
test('missing pins fail before a Keychain read; local development options stay unaffected',()=>{
 assert.throws(()=>notary.companySigningIdentity({env:{},exec:()=>{throw Error('should not read');}}),/HNL_APPLE_SIGNING_SHA1/);
 const local={identity:'local-development-only'};
 assert.equal(notary.companySigningOptions(local,{env:{}}),local);
 assert.equal(notary.companySigningRequired({APPLE_KEYCHAIN_PROFILE:'fixture',CSC_IDENTITY_AUTO_DISCOVERY:'false'}),false);
 assert.equal(notary.companySigningRequired({APPLE_KEYCHAIN_PROFILE:'fixture',CSC_IDENTITY_AUTO_DISCOVERY:'false',HNL_MAC_PUBLIC_RELEASE:'1'}),true);
 assert.throws(()=>notary.releasePreflight({env:{APPLE_KEYCHAIN_PROFILE:'fixture',CSC_IDENTITY_AUTO_DISCOVERY:'false'},platform:'darwin'}),/requires pinned code signing/);
});
test('an explicit company certificate wins over the first available individual identity',{skip:!darwin},()=>{
 const f=policyFixture();
 const identity=notary.companySigningIdentity(f);
 assert.equal(identity.fingerprint,f.company.fingerprint);
 assert.equal(identity.organization,'Hungry Nova Labs LLC');
 assert.equal(notary.developerIdApplication(f),f.company.fingerprint);
 assert.equal(notary.releasePreflight({...f,platform:'darwin'}).fingerprint,f.company.fingerprint);
});
test('personal, misleading, missing and wrong-team certificate selections are rejected',{skip:!darwin},()=>{
 const f=policyFixture();
 for(const bad of [f.individual,f.misleading]){
  assert.throws(()=>notary.companySigningIdentity({...f,env:{...f.env,HNL_APPLE_SIGNING_SHA1:bad.fingerprint}}),/must belong/);
 }
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...f.env,HNL_APPLE_SIGNING_SHA1:'0'.repeat(40)}}),/not a valid local/);
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...f.env,HNL_APPLE_TEAM_ID:'OTHERTEAM1'}}),/must belong/);
 assert.throws(()=>notary.releasePreflight({...f,env:{...f.env,APPLE_TEAM_ID:'OTHERTEAM1'},platform:'darwin'}),/different team/);
});
test('associated-owner signing requires an explicit policy, legal entity, fingerprint and team',{skip:!darwin},()=>{
 const f=policyFixture();
 const ownerEnv={...f.env,HNL_APPLE_SIGNING_POLICY:'associated-owner',HNL_APPLE_SIGNING_ENTITY:'Fixture Individual',HNL_APPLE_SIGNING_SHA1:f.individual.fingerprint};
 const identity=notary.companySigningIdentity({...f,env:ownerEnv});
 assert.equal(identity.policy,'associated-owner');assert.equal(identity.signingEntity,'Fixture Individual');
 assert.equal(identity.fingerprint,f.individual.fingerprint);
 assert.equal(notary.releasePreflight({...f,env:ownerEnv,platform:'darwin'}).fingerprint,f.individual.fingerprint);
 const options=notary.companySigningOptions({identity:f.individual.fingerprint},{...f,env:ownerEnv});
 assert.equal(options.identity,f.individual.fingerprint);
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...ownerEnv,HNL_APPLE_SIGNING_POLICY:'company'}}),/default company signing policy/);
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...ownerEnv,HNL_APPLE_SIGNING_POLICY:undefined}}),/default company signing policy/);
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...ownerEnv,HNL_APPLE_SIGNING_ENTITY:undefined}}),/explicitly approved legal entity/);
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...ownerEnv,HNL_APPLE_SIGNING_ENTITY:'Different Fixture'}}),/must belong/);
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...ownerEnv,HNL_APPLE_SIGNING_SHA1:f.company.fingerprint}}),/must belong/);
 assert.throws(()=>notary.companySigningIdentity({...f,env:{...ownerEnv,HNL_APPLE_TEAM_ID:'OTHERTEAM1'}}),/must belong/);
 assert.throws(()=>notary.signingEntityPolicy({HNL_APPLE_SIGNING_POLICY:'unexpected'}),/Unsupported/);
});
test('app signing requires the pinned company identity and preserves remaining signer options',{skip:!darwin},()=>{
 const f=policyFixture(),optionsForFile=()=>({hardenedRuntime:true});
 const options=notary.companySigningOptions({identity:f.company.commonName,optionsForFile},f);
 assert.equal(options.identity,f.company.fingerprint);assert.equal(options.optionsForFile,optionsForFile);
 assert.throws(()=>notary.companySigningOptions({identity:f.individual.fingerprint},f),/differs from/);
});
test('final artifact verification checks the actual leaf certificate after strict verification',{skip:!darwin},()=>{
 const f=policyFixture();
 let verifyCalls=0,extractCalls=0;
 const exec=(command,args,options)=>{
  if(command==='/usr/bin/security')return f.exec(command,args,options);
  assert.equal(command,'/usr/bin/codesign');
  if(args[0]==='--verify'){assert(args.includes('--deep'));assert(args.includes('--strict'));verifyCalls++;}
  else {
   assert.equal(args[0],'-d');assert.equal(args.length,3);
   assert(args[1].startsWith('--extract-certificates='),'optional codesign arguments must use the equals form');
   fs.writeFileSync(args[1].slice('--extract-certificates='.length)+'0',f.company.parsed.raw);extractCalls++;
  }
  return '';
 };
 assert.equal(notary.verifyCompanySignature('/synthetic/Nova Collar.app',{env:f.env,exec}).fingerprint,f.company.fingerprint);
 assert.equal(verifyCalls,1);assert.equal(extractCalls,1);
 const wrongLeaf=(command,args,options)=>{
  if(command==='/usr/bin/security')return f.exec(command,args,options);
  if(args[0]==='-d')fs.writeFileSync(args[1].slice('--extract-certificates='.length)+'0',f.individual.parsed.raw);
  return '';
 };
 assert.throws(()=>notary.verifyCompanySignature('/synthetic/Nova Collar.app',{env:f.env,exec:wrongLeaf}),/does not have a valid signature/);
});
test('the release entry point pins builder selection and leaves publishing disabled',{skip:!darwin},()=>{
 const f=policyFixture(),calls=[];
 releaseMac({env:f.env,preflight:()=>notary.companySigningIdentity(f),exec:(...args)=>calls.push(args)});
 assert.equal(calls.length,4);
 const selector=f.company.commonName.replace(/^Developer ID Application: /,'');
 for(const [command,args,options]of calls){
  assert.equal(options.env.CSC_NAME,selector);assert.equal(options.env.HNL_MAC_PUBLIC_RELEASE,'1');
 }
 const builder=calls.find(([command])=>command.endsWith('electron-builder'));
 assert(builder);assert(builder[1].includes(`-c.mac.identity=${selector}`));
 assert(!builder[1].some(value=>value.includes('Developer ID Application:')));
 assert.deepEqual(builder[1].slice(builder[1].indexOf('--publish'),builder[1].indexOf('--publish')+2),['--publish','never']);
 assert.equal(f.env.HNL_MAC_PUBLIC_RELEASE,undefined);
});
test('legacy signature metadata is removed only from non-code build resources',{skip:!darwin},()=>{
 const {cleanMacBuildMetadata}=require('./clean-mac-build-metadata.cjs');
 const app=path.join(temporary,'Metadata Fixture.app'),resources=path.join(app,'Contents/Resources');
 fs.mkdirSync(resources,{recursive:true});
 const image=path.join(resources,'image.gif'),native=path.join(resources,'native'),outside=path.join(temporary,'outside.gif');
 fs.writeFileSync(image,'GIF89a\0fixture');fs.copyFileSync('/usr/bin/true',native);fs.writeFileSync(outside,'GIF89a\0outside');
 fs.symlinkSync(outside,path.join(resources,'outside-link'));
 const xattr=args=>execFileSync('/usr/bin/xattr',args,{encoding:'utf8'});
 for(const file of [image,native,outside]){
  xattr(['-w','com.apple.cs.CodeDirectory','synthetic-old-signer',file]);
  xattr(['-w','com.apple.cs.CodeSignature','synthetic-old-signature',file]);
  xattr(['-w','com.apple.quarantine','0081;00000000;Fixture;',file]);
 }
 const result=cleanMacBuildMetadata(app,{legacyResourceSignatures:true});
 assert.equal(result.legacyResourceSignatureAttributes,2);
 assert(!xattr([image]).includes('com.apple.cs.Code'));
 assert.equal(xattr(['-p','com.apple.cs.CodeDirectory',native]).trim(),'synthetic-old-signer');
 assert.equal(xattr(['-p','com.apple.cs.CodeSignature',outside]).trim(),'synthetic-old-signature');
 for(const file of [image,native,outside])assert.equal(xattr(['-p','com.apple.quarantine',file]).trim(),'0081;00000000;Fixture;');
});
