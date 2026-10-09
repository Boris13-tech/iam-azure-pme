// Local operator entrypoint only. No application/API import or automatic invocation.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { FIXED, PROFILES, VERCEL_PROJECT_ID, registeredRelease, validate, ceremony, hash, type Approval, type Execution } from "./resource-owner-bootstrap";
import { PRODUCTION_REGISTRATIONS } from "./production-bootstrap-registry";
import { withTenantDb } from "../../lib/db/scoped-client";

function controlPlaneDeployment(expected: { deployedSha: string; deploymentId: string }) {
  const cli = resolve(process.env.APPDATA ?? "", "npm/node_modules/vercel/dist/vc.js");
  const read = (path: string) => JSON.parse(execFileSync(process.execPath,[cli,'api',path,'--scope','legrandborisohandjaedimo-4025s-projects','--raw'],
    {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));
  const project = read(`/v9/projects/${VERCEL_PROJECT_ID}`);
  const id = project.targets?.production?.id;
  if (typeof id !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(id)) throw new Error('DEPLOYMENT_UNVERIFIED');
  const deployment = read(`/v13/deployments/${id}`);
  if (id !== expected.deploymentId || deployment.projectId !== VERCEL_PROJECT_ID || deployment.target !== 'production' ||
    deployment.readyState !== 'READY' || deployment.meta?.githubCommitSha !== expected.deployedSha) throw new Error('DEPLOYMENT_UNVERIFIED');
}
async function main() {
  // Separate Production command. Certification is performed through the same engine
  // with its independent literal clone profile, never by relabeling this command.
  const [manifestPath, approvalPath] = process.argv.slice(2);
  if (!manifestPath || !approvalPath) throw new Error('DETACHED_ARTIFACTS_REQUIRED');
  const bytes = readFileSync(manifestPath,'utf8'), approval = JSON.parse(readFileSync(approvalPath,'utf8')) as Approval;
  const url = process.env.DATABASE_URL ?? '';
  const release = registeredRelease(bytes, PRODUCTION_REGISTRATIONS);
  const execution: Execution = { mode:'PRODUCTION',url,origin:PROFILES.PRODUCTION.origin,
    verifiedProject:FIXED.projectId,verifiedBranch:PROFILES.PRODUCTION.branch,deployedSha:release.deployedSha,deploymentId:release.deploymentId,
    registrations:PRODUCTION_REGISTRATIONS };
  // Unknown/abandoned artifacts are rejected BEFORE any control-plane/provider/DB call.
  const manifest=validate(bytes,approval,execution);
  const sessionDisposition=readFileSync(resolve('docs/certification/PR14-SESSION-DELTA-ATTRIBUTION-2026-10-08.md'),'utf8');
  if(hash(sessionDisposition)!=='801333ca13e4f6bd935449540314193be38c4715479d640771925f7baf2a7490')
    throw new Error('SESSION_DELTA_DISPOSITION_UNVERIFIED');
  controlPlaneDeployment(release);
  const neonArgs = ['--offline','neon','branches','get',PROFILES.PRODUCTION.branch,'--project-id',FIXED.projectId,'--output','json'];
  const neonRaw = process.platform === 'win32'
    ? execFileSync('cmd.exe',['/d','/s','/c',`npx ${neonArgs.join(' ')}`],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']})
    : execFileSync('npx',neonArgs,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const neon=JSON.parse(neonRaw), branch=neon.branch ?? neon;
  if(branch.id!==PROFILES.PRODUCTION.branch || branch.project_id!==FIXED.projectId)throw new Error('NEON_BRANCH_UNVERIFIED');
  // Credential must be sourced directly by the operator from the pinned trusted Neon
  // branch. The exact endpoint + SQL database/role/RLS posture are independently enforced.
  const session = process.env.LUXIA_OPERATOR_SESSION_TOKEN;
  if (!session) throw new Error('ESTABLISHED_OPERATOR_SESSION_REQUIRED');
  const route = `${execution.origin}/api/resources/protected-resource-demo`;
  const exercise = async (expected:number) => {
    const response = await fetch(route,{headers:{cookie:`luxia_session=${session}`},redirect:'error',signal:AbortSignal.timeout(20_000)});
    if (response.status !== expected) throw new Error('PROTECTED_HTTP_GATE_FAILED');
    const body=await response.json();if(typeof body.evidenceId!=='string')throw new Error('HTTP_EVIDENCE_MISSING');
    const evidence=await withTenantDb(FIXED,tx=>tx.canonicalAdminAuditEvent.findFirst({where:{id:body.evidenceId}}));
    if(!evidence || evidence.actorSubjectId!==FIXED.actorSubjectId || evidence.operation!=='RESOURCE.CAPABILITY.READ' ||
      evidence.result!==(expected===200?'SUCCESS':'DENIED') || (expected===200 &&
      (evidence.assignmentIds.length!==1 || evidence.assignmentIds[0]!==manifest.assignmentId)))throw new Error('HTTP_CANONICAL_EVIDENCE_INVALID');
    return body.evidenceId as string;
  };
  const before=await exercise(403);
  let grantAttempted=false;
  try {
    grantAttempted=true; const grant=await ceremony(bytes,approval,execution);
    if(grant.outcome!=='CREATED')throw new Error('EXACT_INITIAL_GRANT_REQUIRED');
    const allowed=await exercise(200);
    if((await ceremony(bytes,approval,execution)).outcome!=='ALREADY_APPLIED')throw new Error('REPLAY_GATE_FAILED');
    // Mutated bytes must be rejected without widening scope or reaching SQL writes.
    try{validate(bytes+'\n',approval,execution);throw new Error('MODIFIED_REPLAY_ACCEPTED');}catch(error){
      if(error instanceof Error&&error.message==='MODIFIED_REPLAY_ACCEPTED')throw error;
    }
    const revoke=await ceremony(bytes,approval,execution,true);if(revoke.outcome!=='REVOKED')throw new Error('REVOKE_FAILED');
    const denied=await exercise(403);
    const crossTenant=await withTenantDb({...FIXED,tenantId:'00000000-0000-4000-8000-000000000001'},tx=>tx.assignment.count({where:{id:manifest.assignmentId}}));
    if(crossTenant!==0)throw new Error('CROSS_TENANT_GATE_FAILED');
    if((await ceremony(bytes,approval,execution)).outcome!=='DENIED')throw new Error('REVOKED_REPLAY_ACCEPTED');
    console.log(JSON.stringify({manifestBinding:hash(bytes),before,allowed,denied,grant:'REVOKED',result:'PASS'}));
  } finally {
    // Cleanup remains available after expiry, but only for the exact approved receipt.
    if(grantAttempted){const cleanup=await ceremony(bytes,approval,execution,true);if(cleanup.outcome!=='REVOKED')throw new Error('OPERATOR_CLEANUP_REQUIRED');}
  }
}
main().catch(()=>{console.error('PRODUCTION_BOOTSTRAP_STOP — no raw diagnostics');process.exitCode=1;});
