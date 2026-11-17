// Remove only metadata Apple forbids in a code-signed build. This does not clear
// quarantine, provenance, FileProvider metadata, or other security attributes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function cleanMacBuildMetadata(appPath, { legacyResourceSignatures = false } = {}) {
  const resolved = path.resolve(appPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.extname(resolved) !== '.app') {
    throw new Error('Build metadata cleanup requires an existing, non-symlink .app directory.');
  }
  const root = fs.realpathSync(resolved);
  const script = `import os,sys,json,ctypes,errno,subprocess
root=sys.argv[1]
legacy=sys.argv[2]=='1'
resources=os.path.join(root,'Contents','Resources')
allowed=('com.apple.FinderInfo','com.apple.ResourceFork')
removed={name:0 for name in allowed}
removed['legacyResourceSignatureAttributes']=0
magic={bytes.fromhex(x) for x in ('feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca')}
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
lib.listxattr.argtypes=(ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int)
lib.listxattr.restype=ctypes.c_ssize_t
lib.removexattr.argtypes=(ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int)
lib.removexattr.restype=ctypes.c_int
visited=set()
for directory,dirs,files in os.walk(root,followlinks=False):
    for target in [directory]+[os.path.join(directory,name) for name in dirs+files]:
        if target in visited: continue
        visited.add(target)
        encoded=os.fsencode(target)
        size=lib.listxattr(encoded,None,0,1)
        if size<0: raise OSError(ctypes.get_errno(),'Cannot inspect build metadata')
        if not size: continue
        buffer=ctypes.create_string_buffer(size)
        size=lib.listxattr(encoded,buffer,len(buffer),1)
        if size<0: raise OSError(ctypes.get_errno(),'Cannot inspect build metadata')
        attrs=buffer.raw[:size].split(bytes([0]))
        selected=list(allowed)
        if legacy and not os.path.islink(target) and os.path.isfile(target) and os.path.commonpath([resources,target])==resources:
            with open(target,'rb') as stream: header=stream.read(4)
            native=header in magic and 'Mach-O' in subprocess.check_output(['/usr/bin/file','-b',target],text=True)
            if not native:
                selected.extend(name.decode('utf-8') for name in attrs if name.startswith(b'com.apple.cs.Code'))
        for name in selected:
            if name.encode() in attrs:
                if lib.removexattr(encoded,name.encode(),1)!=0:
                    code=ctypes.get_errno()
                    if code!=93: raise OSError(code,'Cannot remove forbidden build metadata')
                else: removed[name if name in allowed else 'legacyResourceSignatureAttributes']+=1
print(json.dumps(removed))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, root, legacyResourceSignatures ? '1' : '0'], { encoding: 'utf8' }));
}
module.exports = { cleanMacBuildMetadata };
