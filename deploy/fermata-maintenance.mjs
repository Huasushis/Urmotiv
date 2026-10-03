// Run inside Fermata via stdin. Credentials remain in the container environment.
import {readFile,writeFile} from 'node:fs/promises';
const mode=process.argv[2];
if(!['drain','resume','idle','status'].includes(mode))throw Error('INVALID_MODE');
const path='/app/data/urmotiv-maintenance.json';
async function call(route,body){
 const response=await fetch('http://127.0.0.1:8720'+route,{
  headers:{Authorization:'Bearer '+process.env.FERMATA_MANAGEMENT_TOKEN,'Content-Type':'application/json'},
  ...(body?{method:'PUT',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)
 });
 if(!response.ok)throw Error('REQUEST_FAILED');return response.json();
}
try{
 const current=await call('/api/v1/settings/public');
 let saved;
 try{saved=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(mode==='drain'){
  if(saved&&!saved.restored&&current.settings.enabled)throw Error('MAINTENANCE_STATE_CHANGED');
  if(!saved||saved.restored){
   saved={enabled:current.settings.enabled,drainedRevision:current.revision+(current.settings.enabled?1:0),restored:false};
   await writeFile(path,JSON.stringify(saved),{mode:0o600});
  }
  if(current.settings.enabled)await call('/api/v1/settings/public',{expectedRevision:current.revision,settings:{...current.settings,enabled:false}});
 }else if(mode==='resume'&&saved&&!saved.restored){
  if(saved.enabled&&!current.settings.enabled){
   if(current.revision!==saved.drainedRevision)throw Error('SETTINGS_CHANGED_DURING_MAINTENANCE');
   await call('/api/v1/settings/public',{expectedRevision:current.revision,settings:{...current.settings,enabled:true}});
  }
  await writeFile(path,JSON.stringify({...saved,restored:true}),{mode:0o600});
 }
 const health=await call('/api/v1/health');
 if(!Number.isInteger(health.activeTasks)||health.activeTasks<0)throw Error('INVALID_HEALTH');
 if(mode==='idle')process.exitCode=health.activeTasks===0?0:2;
 else console.log(JSON.stringify({fermata:health.status,activeTasks:health.activeTasks,workerRunning:health.workerRunning,maintenancePending:!!saved&&!saved.restored}));
 if(mode==='status'&&current.settings.enabled&&!health.workerRunning)process.exitCode=1;
}catch{console.error('Fermata 维护检查失败；未强制终止任务，请检查服务配置或稍后重试。');process.exitCode=1;}
