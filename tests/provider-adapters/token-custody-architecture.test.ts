import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

describe('Token custody architecture boundaries',()=>{
  it('ephemeral manager has no persistence, SDK, environment or logging dependency',()=>{
    const source=readFileSync('lib/provider-management/token-manager.ts','utf8');
    expect(source).not.toMatch(/(@prisma|\.\/db|node:fs|console\.|logger\.|process\.env|@azure|googleapis)/);
    expect(source).toContain('credentialVersion');expect(source).toContain('safetyMarginMs');
  });
  it('credential migration stores only versions and revocation metadata, retaining existing RLS',()=>{
    const source=readFileSync('prisma/migrations/20261004090000_provider_credential_versions/migration.sql','utf8');
    expect(source).not.toMatch(/CREATE TABLE|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|accessToken|refreshToken|clientSecret|PASSWORD/i);
    expect(source).toContain('activeCredentialVersion');expect(source).toContain('candidateCredentialVersion');
  });
  it('OIDC metadata still uses the credential-free path',()=>{
    const source=readFileSync('lib/provider-adapters/implementations/managed-http/driver.ts','utf8');
    const metadata=source.slice(source.indexOf('if (input.type !== "OIDC_GENERIC")'),source.indexOf('async *discover()'));
    expect(metadata).toContain('oidcMetadataRequest');expect(metadata).not.toContain('acquire(');
  });
});
