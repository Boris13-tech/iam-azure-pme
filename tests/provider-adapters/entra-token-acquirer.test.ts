import {describe,it,expect,vi} from 'vitest';
import {SecretLease,type SecretResolver} from '../../lib/provider-adapters';
import {entraTokenAcquirer} from '../../lib/provider-adapters/implementations/managed-http/entra-token-acquirer';
import type {TokenContext} from '../../lib/provider-management/token-manager';
const c:TokenContext={organizationId:'o',tenantId:'t',providerConnectionId:'p',providerType:'MICROSOFT_ENTRA',credentialVersion:'1',authStrategy:'CLIENT_CREDENTIALS'};
const resolver:SecretResolver={withSecret:async(_context,_ref,consumer)=>{
  const lease=new SecretLease(new TextEncoder().encode('FAKE_SECRET'));try{return await consumer(lease);}finally{lease.dispose();}}};
const registration=async()=>({clientId:'00000000-0000-4000-8000-000000000001',directoryId:'00000000-0000-4000-8000-000000000002'});
describe('Entra token acquisition without external IO',()=>{
  it('uses client credentials and Graph .default; returns only access token and real TTL',async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({access_token:'FAKE_TOKEN',token_type:'Bearer',expires_in:120})));
    const acquire=entraTokenAcquirer(resolver,registration,transport);
    expect(await acquire(c,'reference')).toEqual({accessToken:'FAKE_TOKEN',expiresIn:120});
    const [url,options]=transport.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toContain('/oauth2/v2.0/token');expect(options.redirect).toBe('error');
    const body=options.body as URLSearchParams;
    expect(body.get('scope')).toBe('https://graph.microsoft.com/.default');expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.has('refresh_token')).toBe(false);
  });
  it('rejects raw errors, refresh tokens, missing expiry, and unsafe strategy',async()=>{
    for(const payload of [{access_token:'FAKE_TOKEN',token_type:'Bearer'},
      {access_token:'FAKE_TOKEN',token_type:'Bearer',expires_in:120,refresh_token:'PRIVATE_REFRESH'}]){
      await expect(entraTokenAcquirer(resolver,registration,vi.fn(async()=>new Response(JSON.stringify(payload))))(c,'reference'))
        .rejects.toThrow('PROVIDER_CREDENTIAL_INVALID');
    }
    await expect(entraTokenAcquirer(resolver,registration,vi.fn(async()=>{throw new Error('FAKE_SECRET');}))(c,'reference'))
      .rejects.toThrow('PROVIDER_CREDENTIAL_INVALID');
    const network=vi.fn();await expect(entraTokenAcquirer(resolver,registration,network)({...c,authStrategy:'OAUTH_REFRESH_TOKEN'},'ref'))
      .rejects.toThrow('PROVIDER_AUTH_STRATEGY_UNSUPPORTED');expect(network).not.toHaveBeenCalled();
  });
});
