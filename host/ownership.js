 'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Only one process may start optional services for a project in a data profile.
// A crash leaves a PID record, which the next host can reclaim.
function projectServiceOwner(dataDir, workspace) {
 if (!workspace) return { owned:false, release() {} };
 const resolved = fs.realpathSync(workspace);
 const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
 const dir = path.join(dataDir,'service-owners'); fs.mkdirSync(dir,{recursive:true});
 const file = path.join(dir,crypto.createHash('sha256').update(key).digest('hex')+'.json');
 const nonce = crypto.randomBytes(16).toString('hex');
 for (let attempt=0; attempt<3; attempt++) {
  try { const fd=fs.openSync(file,'wx'); try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce})); } finally { fs.closeSync(fd); }
   return { owned:true, release() { try { if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===nonce) fs.unlinkSync(file); } catch {} } };
  } catch(error) {
   if(error.code!=='EEXIST') throw error;
   let owner; try { owner=JSON.parse(fs.readFileSync(file,'utf8')); } catch { return {owned:false,release(){}}; }
   try { process.kill(owner.pid,0); return {owned:false,release(){}}; } catch(error) { if(error.code!=='ESRCH') return {owned:false,release(){}}; }
   // Re-read before deletion so a newly installed owner is never removed.
   try { if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===owner.nonce) fs.unlinkSync(file); } catch {}
  }
 }
 return {owned:false,release(){}};
}
module.exports={projectServiceOwner};
