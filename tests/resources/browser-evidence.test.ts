import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CanonicalAdminAuditEvent } from '@prisma/client';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe,it,expect,vi } from 'vitest';
import { FIXED } from '../../scripts/operators/resource-owner-bootstrap';
import { newBrowserProbe, verifyBrowserEvidence, browserEvidenceId, requestBrowserProof } from '../../scripts/operators/browser-evidence';

describe('operator browser transport, no session export or approval path',()=>{
  const start=new Date('2026-10-09T10:00:00Z'), now=new Date(start.getTime()+1000), assignmentId=randomUUID();
  function fixture(status:200|403){
    const probe=newBrowserProbe(status,start), id=randomUUID();
    const line=JSON.stringify({probeId:probe.probeId,httpStatus:status,evidenceId:id});
    const evidence={id,organizationId:FIXED.organizationId,tenantId:FIXED.tenantId,actorSubjectId:FIXED.actorSubjectId,
      targetSubjectId:null,roleKey:null,roleVersion:null,changeId:`capability:${randomUUID()}`,
      operation:'RESOURCE.CAPABILITY.READ',occurredAt:now,result:status===200?'SUCCESS':'DENIED',assignmentIds:status===200?[assignmentId]:[],
      metadata:{resourceId:FIXED.resourceId,action:FIXED.action,reasonCode:status===200?'ALLOW':'RESOURCE_ACCESS_DENIED'}} as CanonicalAdminAuditEvent;
    return {probe,line,evidence};
  }
  it('accepts fresh exact persisted denial and exact-grant allow proofs',()=>{
    for(const status of [200,403] as const){const f=fixture(status);expect(verifyBrowserEvidence(f.probe,f.line,f.evidence,assignmentId,new Set(),now)).toBe(f.evidence.id);}
  });
  it('rejects absent evidence, stale/future proofs, reused evidence and expired probe',()=>{
    const f=fixture(403);
    expect(()=>verifyBrowserEvidence(f.probe,f.line,null,assignmentId,new Set(),now)).toThrow();
    for(const occurredAt of [new Date(start.getTime()-1),new Date(now.getTime()+5001)])
      expect(()=>verifyBrowserEvidence(f.probe,f.line,{...f.evidence,occurredAt},assignmentId,new Set(),now)).toThrow();
    expect(()=>verifyBrowserEvidence(f.probe,f.line,f.evidence,assignmentId,new Set([f.evidence.id]),now)).toThrow();
    expect(()=>verifyBrowserEvidence(f.probe,f.line,f.evidence,assignmentId,new Set(),new Date(start.getTime()+90001))).toThrow();
  });
  it('rejects wrong actor, tenant, organization, resource, action, result, operation or grant',()=>{
    const f=fixture(200);
    for(const patch of [{actorSubjectId:randomUUID()},{tenantId:randomUUID()},{organizationId:randomUUID()},
      {operation:'OTHER'},{result:'DENIED'},{assignmentIds:[]},{assignmentIds:[randomUUID()]},
      {assignmentIds:[assignmentId,randomUUID()]},{metadata:{...f.evidence.metadata as object,resourceId:randomUUID()}},
      {metadata:{...f.evidence.metadata as object,action:'*'}},{metadata:{...f.evidence.metadata as object,reasonCode:'DENY'}}])
      expect(()=>verifyBrowserEvidence(f.probe,f.line,{...f.evidence,...patch} as CanonicalAdminAuditEvent,assignmentId,new Set(),now)).toThrow();
  });
  it('does not trust a browser status, approval boolean, unsolicited challenge or oversized input',()=>{
    const f=fixture(403), reply=JSON.parse(f.line);
    for(const patch of [{httpStatus:200},{probeId:randomUUID()},{evidenceId:randomUUID()},{approved:true}])
      expect(()=>verifyBrowserEvidence(f.probe,JSON.stringify({...reply,...patch}),f.evidence,assignmentId,new Set(),now)).toThrow();
    expect(()=>browserEvidenceId('x'.repeat(1025))).toThrow();
    expect(()=>browserEvidenceId(JSON.stringify({...reply,secret:'unaccepted'}))).toThrow();
  });
  it('remains outside runtime application and never performs approval or session issuance',()=>{
    const source=readFileSync('scripts/operators/browser-evidence.ts','utf8');
    expect(source).not.toMatch(/createSession|cookies\(|session\.(create|upsert)|ceremony\(/);
    const entry=readFileSync('scripts/operators/run-production-resource-bootstrap.ts','utf8');
    expect(entry.indexOf('validate(bytes,approval,execution)')).toBeLessThan(entry.indexOf("createInterface({input:process.stdin"));
    expect(entry).toContain('browserInput?.close()');
    expect(entry).toContain("process.off('SIGINT',stop)");
    expect(entry).toContain("process.off('SIGTERM',stop)");
    expect(entry).toContain('rawPrisma.$disconnect()');
    for(const file of ['app/api/resources/protected-resource-demo/route.ts','app/api/canonical/resource-onboarding/route.ts'])
      expect(readFileSync(file,'utf8')).not.toContain('browser-evidence');
  });
  it('clears readline listeners and timer after real stdin reply, EOF or timeout',async()=>{
    vi.useFakeTimers();
    try {
      for(const outcome of ['reply','eof','timeout']){
        const stream=new PassThrough(),input=createInterface({input:stream}),probe=newBrowserProbe(403,start);
        const baselineLine=input.listenerCount('line'),baselineClose=input.listenerCount('close');
        const pending=requestBrowserProof(input,probe,'https://iam-azure-pme.vercel.app/api/resources/protected-resource-demo',prompt=>{
          expect(JSON.parse(prompt)).toMatchObject({probeId:probe.probeId,expectedStatus:403});
          expect(prompt).not.toMatch(/cookie|token|secret|approved/);
        });
        if(outcome==='reply'){stream.write('proof-line\n');expect(await pending).toBe('proof-line');}
        else if(outcome==='eof'){const rejection=expect(pending).rejects.toThrow('BROWSER_PROOF_UNAVAILABLE');input.close();await rejection;}
        else{const rejection=expect(pending).rejects.toThrow('BROWSER_PROOF_TIMEOUT');await vi.advanceTimersByTimeAsync(90_000);await rejection;}
        expect(input.listenerCount('line')).toBe(baselineLine);expect(input.listenerCount('close')).toBe(outcome==='eof'?0:baselineClose);expect(vi.getTimerCount()).toBe(0);
        input.close();stream.destroy();
      }
    } finally {vi.useRealTimers();}
  });
});
