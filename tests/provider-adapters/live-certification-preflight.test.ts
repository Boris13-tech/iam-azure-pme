import { describe,it,expect } from 'vitest';
import { preflight } from '../../scripts/provider-certification/preflight';
import { completeEvidence, requiredGates } from '../../scripts/provider-certification/evidence';
describe('Live certification fail-closed preflight', () => {
  it('requires the exact Entra scope names without exposing supplied values', () => {
    const result = preflight('ENTRA', { LUXIA_CERT_ENTRA_CLIENT_SECRET: 'never-print-this-value' });
    expect(result.missing).toEqual(expect.arrayContaining([
      'LUXIA_CERT_SCOPE_ORGANIZATION_ID', 'LUXIA_CERT_SCOPE_TENANT_ID',
      'LUXIA_CERT_ACTOR_SUBJECT_ID', 'LUXIA_CERT_ENTRA_PROVIDER_CONNECTION_ID',
      'LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_SECRET', 'LUXIA_CERT_ENTRA_CONSENT_CONFIRMED',
    ]));
    expect(JSON.stringify(result)).not.toContain('never-print-this-value');
  });
  const entraEnv = () => Object.fromEntries([
    'LUXIA_CERT_SCOPE_ORGANIZATION_ID', 'LUXIA_CERT_SCOPE_TENANT_ID',
    'LUXIA_CERT_ACTOR_SUBJECT_ID', 'LUXIA_CERT_ENTRA_PROVIDER_CONNECTION_ID',
    'LUXIA_CERT_ENTRA_CLIENT_ID', 'LUXIA_CERT_ENTRA_TENANT_ID',
    'LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_ID',
  ].map((name, i) => [name, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]).concat([
    ['LUXIA_CERT_DATABASE_URL', 'postgresql://app_user:fake@ep-shy-shape-ah9l8gm8-pooler.c-3.us-east-1.aws.neon.tech/luxia_provider_cert?sslmode=require'],
    ['LUXIA_CERT_DATABASE_MIGRATION_URL', 'postgresql://owner:fake@ep-shy-shape-ah9l8gm8.c-3.us-east-1.aws.neon.tech/luxia_provider_cert?sslmode=require'],
    ['LUXIA_CERT_ENTRA_CLIENT_SECRET', 'fake-main'], ['LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_SECRET', 'fake-negative'],
    ['LUXIA_CERT_ENTRA_HTTP_SESSION_TOKEN', 'fake-session'], ['LUXIA_CERT_ENTRA_FOREIGN_HTTP_SESSION_TOKEN', 'fake-foreign'],
    ['LUXIA_CERT_ENTRA_CONSENT_CONFIRMED', 'true'],
  ]));
  it('rejects the known Production app and a reused negative app', () => {
    const env = entraEnv();
    expect(preflight('ENTRA', env).ready).toBe(true);
    env.LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_ID = env.LUXIA_CERT_ENTRA_CLIENT_ID;
    expect(preflight('ENTRA', env).ready).toBe(false);
    env.LUXIA_CERT_ENTRA_CLIENT_ID = '811ded0e-7a03-4c10-9bfc-9f24efdb972b';
    expect(preflight('ENTRA', env).ready).toBe(false);
  });
  it('rejects Production DB references and non-runtime DB roles', () => {
    const env = entraEnv();
    env.LUXIA_CERT_DATABASE_URL = env.LUXIA_CERT_DATABASE_URL.replace('app_user:', 'neondb_owner:');
    expect(preflight('ENTRA', env).ready).toBe(false);
    env.LUXIA_CERT_DATABASE_URL = entraEnv().LUXIA_CERT_DATABASE_URL.replace('/luxia_provider_cert?', '/neondb?');
    expect(preflight('ENTRA', env).ready).toBe(false);
  });
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
