import type { Profile } from './preflight';
export type GateEvidence={result:string;source:string};
export function requiredGates(profile:Profile) {
  const common=['Runtime posture','Connection test','Operation idempotency','Operation conflict','Cross-tenant deny before network',
    'Secret scope','Disabled management operations','Canonical audit','Rejection audit','Pagination bounds / HTTPS / issuer mismatch / redirects / SSRF / safe errors',
    'No Subject/IdentityAccount/legacy/bridge mutation','Public service results / audit secret scan','HTTP/application-log secret scan'];
  return [...common,...(profile==='OIDC'?['HTTPS exact issuer metadata','No directory enumeration']:
    ['Directory read consent','Discovery','Stable external IDs','Live pagination','Collision quarantine/rejection','Invalid credential safe failure',
      profile==='ENTRA'?'Insufficient consent safe failure':'Revoked credential safe failure'])];
}
export function completeEvidence(profile:Profile,evidence:Record<string,GateEvidence>) {
  return requiredGates(profile).every(name=>evidence[name]?.result==='PASS'&&evidence[name].source!=='NOT_EXECUTED');
}
