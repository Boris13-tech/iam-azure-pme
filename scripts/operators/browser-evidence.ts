// Operator transport only. Does not read cookies, issue sessions or authorize grants.
import { randomUUID } from "node:crypto";
import type { CanonicalAdminAuditEvent } from "@prisma/client";
import type { Interface } from "node:readline";
import { z } from "zod";
import { FIXED } from "./resource-owner-bootstrap";

const responseSchema = z.object({ probeId: z.uuid(), httpStatus: z.union([z.literal(200), z.literal(403)]),
  evidenceId: z.uuid() }).strict();
export type BrowserProbe = Readonly<{ probeId: string; expectedStatus: 200 | 403; requestedAt: Date; deadline: Date }>;
export function newBrowserProbe(expectedStatus: 200 | 403, now = new Date()): BrowserProbe {
  return Object.freeze({ probeId: randomUUID(), expectedStatus, requestedAt: now, deadline: new Date(now.getTime()+90_000) });
}
export function verifyBrowserEvidence(probe: BrowserProbe, line: string, evidence: CanonicalAdminAuditEvent | null,
  assignmentId: string, consumed: ReadonlySet<string>, now = new Date()): string {
  if (Buffer.byteLength(line, 'utf8') > 1024) throw new Error('BROWSER_PROOF_INVALID');
  const reply=responseSchema.parse(JSON.parse(line));
  const metadata=evidence?.metadata as {resourceId?:string;action?:string;reasonCode?:string} | undefined;
  if (now.getTime()<probe.requestedAt.getTime() || now.getTime()>probe.deadline.getTime() ||
    reply.probeId!==probe.probeId || reply.httpStatus!==probe.expectedStatus || !evidence ||
    evidence.id!==reply.evidenceId || consumed.has(evidence.id) ||
    evidence.organizationId!==FIXED.organizationId || evidence.tenantId!==FIXED.tenantId ||
    evidence.actorSubjectId!==FIXED.actorSubjectId || evidence.operation!=='RESOURCE.CAPABILITY.READ' ||
    evidence.occurredAt.getTime()<probe.requestedAt.getTime() || evidence.occurredAt.getTime()>now.getTime()+5_000 ||
    metadata?.resourceId!==FIXED.resourceId || metadata?.action!==FIXED.action ||
    evidence.result!==(probe.expectedStatus===200?'SUCCESS':'DENIED') ||
    metadata?.reasonCode!==(probe.expectedStatus===200?'ALLOW':'RESOURCE_ACCESS_DENIED') ||
    (probe.expectedStatus===200 ? evidence.assignmentIds.length!==1 || evidence.assignmentIds[0]!==assignmentId : evidence.assignmentIds.length!==0))
    throw new Error('BROWSER_CANONICAL_PROOF_DENIED');
  return evidence.id;
}
export function browserEvidenceId(line: string): string {
  if (Buffer.byteLength(line,'utf8')>1024) throw new Error('BROWSER_PROOF_INVALID');
  return responseSchema.parse(JSON.parse(line)).evidenceId;
}
export function requestBrowserProof(input: Interface, probe: BrowserProbe, route: string,
  emit: (prompt: string) => void): Promise<string> {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);input.off('line',receive);input.off('close',closed);};
    const receive=(value:string)=>{cleanup();resolve(value);};
    const closed=()=>{cleanup();reject(new Error('BROWSER_PROOF_UNAVAILABLE'));};
    const timer=setTimeout(()=>{cleanup();reject(new Error('BROWSER_PROOF_TIMEOUT'));},90_000);
    input.once('line',receive);input.once('close',closed);
    try { emit(JSON.stringify({event:'BROWSER_PROBE_REQUIRED',probeId:probe.probeId,route,
      expectedStatus:probe.expectedStatus,deadline:probe.deadline.toISOString()})); }
    catch { cleanup();reject(new Error('BROWSER_PROOF_UNAVAILABLE')); }
  });
}
