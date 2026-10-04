import { describe,it,expect } from 'vitest';
import { preflight } from '../../scripts/provider-certification/preflight';
import { completeEvidence, requiredGates } from '../../scripts/provider-certification/evidence';
describe('Live certification fail-closed preflight', () => {
  for (const profile of ['ENTRA','GOOGLE','OIDC'] as const) it(`${profile} blocks without credentials before IO`, () => {
    expect(preflight(profile,{}).ready).toBe(false);
    expect(JSON.stringify(preflight(profile,{}))).not.toContain('postgresql://');
  });
  it('requires explicit OIDC approval', () => expect(preflight('OIDC',{LUXIA_CERT_OIDC_ISSUER:'https://example.test'}).missing).toContain('LUXIA_CERT_OIDC_APPROVED'));
  for(const profile of ['ENTRA','GOOGLE','OIDC'] as const) {
    it(`${profile} cannot pass with omitted gates`,()=>expect(completeEvidence(profile,{})).toBe(false));
    it(`${profile} cannot pass a blocked or unexecuted gate`,()=>{
      const gates=Object.fromEntries(requiredGates(profile).map(name=>[name,{result:'PASS',source:'LIVE'}]));
      expect(completeEvidence(profile,gates)).toBe(true);
      gates['HTTP/application-log secret scan']={result:'BLOCKED',source:'NOT_EXECUTED'};
      expect(completeEvidence(profile,gates)).toBe(false);
    });
  }
});
