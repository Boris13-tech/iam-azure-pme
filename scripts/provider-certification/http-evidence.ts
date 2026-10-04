import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Own loopback server only, never a Production URL. Raw logs stay in memory. */
export async function httpEvidence(input:{ id:string; session:string; foreignSession:string; secretRef:string; clean:(value:unknown)=>void }) {
  const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:process.env.LUXIA_CERT_DATABASE_URL,AUTHZ_MODE:'native',NODE_ENV:'development'};
  for(const name of Object.keys(env)) if(name.startsWith('LUXIA_CERT_')||name==='DATABASE_MIGRATION_URL') delete env[name];
  const server=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3191'],{env,stdio:['ignore','pipe','pipe']});
  const base='http://127.0.0.1:3191'; let logs='';let overflow=false;
  const capture=(chunk:Buffer) => { logs+=chunk.toString();if(logs.length>1_000_000){overflow=true;server.kill();} };
  server.stdout.on('data',capture);server.stderr.on('data',capture);
  try {
    let started=false;
    for(let attempts=0;attempts<60;attempts++) {
      if(server.exitCode!==null || overflow)throw new Error('CERT_SERVER_FAILED');
      try { if(!/Ready in/i.test(logs))throw new Error('NOT_READY');const r=await fetch(base+'/login',{redirect:'manual',signal:AbortSignal.timeout(2000)});await r.text();started=true;break; }catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!started)throw new Error('CERT_SERVER_TIMEOUT');
    const path=`/api/canonical/provider-management/${encodeURIComponent(input.id)}`;
    const request=async(session:string,operation?:string) => {
      const response=await fetch(base+path+(operation?'/operations':''),{redirect:'error',signal:AbortSignal.timeout(60000),
        method:operation?'POST':'GET',headers:{Cookie:`luxia_session=${session}`,'Content-Type':'application/json','x-luxia-change-id':randomUUID()},
        ...(operation?{body:JSON.stringify({operation})}:{})});
      const body=await response.text();input.clean(body);input.clean([...response.headers]);
      // Reject token-shaped response material even when the particular bearer was minted in the child.
      if(/(?:access_token|refresh_token|client_secret|private_key)\s*["']?\s*[:=]|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(body))throw new Error('HTTP_TOKEN_EXPOSURE');
      return {status:response.status,body};
    };
    const foreign=await request(input.foreignSession);
    if(foreign.status!==404)throw new Error('HTTP_CROSS_TENANT_NOT_DENIED');
    const detail=await request(input.session);if(detail.status!==200)throw new Error('HTTP_AUTHORIZATION');
    const result=await request(input.session,'CONNECTION_TEST');
    if(result.status!==200||JSON.parse(result.body).status!=='DRY_RUN_COMPLETE')throw new Error('HTTP_CONNECTION_FAILED');
    input.clean(logs);
    if(overflow||/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:access_token|refresh_token|client_secret|private_key)\s*["']?\s*[:=]/.test(logs))throw new Error('LOG_TOKEN_EXPOSURE');
  } finally { server.kill();await new Promise<void>(resolve=>{if(server.exitCode!==null)resolve();else {server.once('exit',()=>resolve());setTimeout(resolve,5000).unref();}});input.clean(logs); }
}
