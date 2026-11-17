import {spawn} from "node:child_process";
import {isAbsolute, relative, resolve, sep} from "node:path";

const active = new Set();
export const newPathProbeCount = () => active.size;
const inside = (root, path) => { const name=relative(root,path); return name!=="" && name!==".." && !name.startsWith(".."+sep) && !isAbsolute(name); };

// Metadata only. No source file is opened/read, and no target program runs.
const WORKER = String.raw`
const fs=require("node:fs"),p=require("node:path");let input="";
const inside=(r,f)=>{const x=p.relative(r,f);return x!==""&&x!==".."&&!x.startsWith(".."+p.sep)&&!p.isAbsolute(x);};
process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk;if(input.length>8192)process.exit(0);});
process.stdin.on("end",()=>{try{
 const value=JSON.parse(input),original=p.resolve(value.cwd),full=p.resolve(value.path);
 if(!inside(original,full))throw Error();
 const root=fs.realpathSync(original),parts=p.relative(original,full).split(p.sep);let at=root;
 for(let i=0;i<parts.length;i++){
  at=p.join(at,parts[i]);let s;
  try{s=fs.lstatSync(at);}catch(error){if(error.code==="ENOENT"){
   process.stdout.write(JSON.stringify({known:true,isNew:true,root,path:p.join(at,...parts.slice(i+1))})+"\n");return;
  }throw error;}
  if(s.isSymbolicLink()||(i<parts.length-1&&!s.isDirectory()))throw Error();
 }
 process.stdout.write(JSON.stringify({known:true,isNew:false,root,path:at})+"\n");
}catch{process.stdout.write('{"known":false}\n');}});
`;

/** All filesystem metadata work stays in bounded readonly children. Unknown or
 * timed-out state disables the optional generation cap; it grants no action.
 * Unexited killed children retain one of four global slots until exit is seen.
 */
export function createNewPathProbe({cwd, initialFiles = new Map(), signal, denyPath = () => false,
  timeoutMs = 1200, spawnProbe = spawn} = {}) {
  const pending=new Set(), owned=new Set();
  function state(path) {
    if(!isAbsolute(cwd||"")||!inside(resolve(cwd),path))return undefined;
    try{if(denyPath(path))return undefined;}catch{return undefined;}
    if(initialFiles.has(path))return initialFiles.get(path);
    initialFiles.set(path,undefined);
    if(signal?.aborted||active.size>=4)return undefined;
    let child,finished=false,output="",timer,resolveDone;
    const done=new Promise(resolveValue=>{resolveDone=resolveValue;});
    const stop=()=>finish(undefined);
    const finish=value=>{
      if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener("abort",stop);
      initialFiles.set(path,value);pending.delete(done);owned.delete(finish);
      try{child?.kill("SIGKILL");}catch{}
      child?.unref?.();child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();resolveDone(value);
    };
    pending.add(done);owned.add(finish);
    signal?.addEventListener("abort",stop,{once:true});
    timer=setTimeout(()=>finish(undefined),Math.min(5000,Math.max(10,timeoutMs)));
    try{
      child=spawnProbe(process.execPath,["-e",WORKER],{env:{ELECTRON_RUN_AS_NODE:"1"},stdio:["pipe","pipe","pipe"],windowsHide:true});
      active.add(child);
      child.once("exit",()=>{active.delete(child);if(!finished)finish(undefined);});
      child.once("error",()=>{if(!child.pid)active.delete(child);finish(undefined);});
      child.stdout.setEncoding("utf8");
      child.stdout.on("data",chunk=>{
        if(finished)return;output+=chunk;if(output.length>8192)return finish(undefined);
        const at=output.indexOf("\n");if(at<0)return;
        try{
          const value=JSON.parse(output.slice(0,at));
          if(value.known!==true||typeof value.isNew!=="boolean"||typeof value.path!=="string"
            ||typeof value.root!=="string"||!isAbsolute(value.root)||!inside(value.root,value.path)
            ||relative(value.root,value.path)!==relative(resolve(cwd),path))return finish(undefined);
          try{if(denyPath(value.path)||denyPath(value.root))return finish(undefined);}catch{return finish(undefined);}
          finish(!value.isNew);
        }catch{finish(undefined);}
      });
      child.stdout.on("error",()=>finish(undefined));child.stderr.on("data",()=>{});child.stderr.on("error",()=>{});
      child.stdin.on("error",()=>finish(undefined));
      child.stdin.end(JSON.stringify({cwd,path}));
    }catch{finish(undefined);}
    return undefined;
  }
  return {state,async settle(){await Promise.all([...pending]);},close(){for(const finish of [...owned])finish(undefined);}};
}
