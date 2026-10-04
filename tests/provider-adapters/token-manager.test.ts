import {describe,it,expect,vi} from 'vitest';
import {ProviderTokenManager,type TokenContext,type TokenManagerDependencies} from '../../lib/provider-management/token-manager';
import {connectionSecretReference} from '../../lib/provider-management/contracts';

const context: TokenContext = {organizationId:'org',tenantId:'tenant',providerConnectionId:'connection',
  providerType:'MICROSOFT_ENTRA',credentialVersion:'1',authStrategy:'CLIENT_CREDENTIALS'};
function fixture() {
  let clock=0;
  const deps: TokenManagerDependencies = {
    authorize:vi.fn(async c=>({credentialSecretRef:connectionSecretReference(c)})),
    acquire:vi.fn(async()=>({accessToken:'SECRET_TOKEN',expiresIn:100})),
    audit:vi.fn(async()=>{}),activateCredential:vi.fn(async()=>{}),testCredential:vi.fn(async()=>{}),
  };
  return {deps,manager:new ProviderTokenManager(deps,()=>clock,10_000),time:(v:number)=>{clock=v;}};
}
describe('Provider token custody: controlled acquisition only',()=>{
  it('reuses valid tokens, refreshes before expiry and after expiry',async()=>{
    const f=fixture(); await f.manager.getValidToken(context);
    f.time(89_999); await f.manager.getValidToken(context);expect(f.deps.acquire).toHaveBeenCalledTimes(1);
    f.time(90_000);await f.manager.getValidToken(context);expect(f.deps.acquire).toHaveBeenCalledTimes(2);
    f.time(200_000);await f.manager.getValidToken(context);expect(f.deps.acquire).toHaveBeenCalledTimes(3);
  });
  it('shares one acquisition between ten callers and releases successful flight',async()=>{
    const f=fixture();const tokens=await Promise.all(Array.from({length:10},()=>f.manager.getValidToken(context)));
    expect(f.deps.acquire).toHaveBeenCalledTimes(1);expect(new Set(tokens).size).toBe(1);
    await f.manager.acquire(context);expect(f.deps.acquire).toHaveBeenCalledTimes(2);
  });
  it('failed acquisition releases lock and strips unsafe errors',async()=>{
    const f=fixture();vi.mocked(f.deps.acquire).mockRejectedValueOnce(new Error('SECRET_TOKEN bearer raw response'));
    await expect(f.manager.acquire(context)).rejects.toThrow('PROVIDER_CREDENTIAL_INVALID');
    await expect(f.manager.acquire(context)).resolves.toHaveProperty('credentialVersion','1');
    expect(JSON.stringify(vi.mocked(f.deps.audit).mock.calls)).not.toContain('SECRET_TOKEN');
  });
  it('isolates tenant, connection, type, strategy and credential version',async()=>{
    const f=fixture();for(const c of [context,{...context,tenantId:'other'},{...context,providerConnectionId:'other'},
      {...context,credentialVersion:'2'},{...context,providerType:'GOOGLE_WORKSPACE',authStrategy:'WORKLOAD_IDENTITY' as const}])
      await f.manager.getValidToken(c);
    expect(f.deps.acquire).toHaveBeenCalledTimes(5);
  });
  it('rejects disabled/cross-tenant scope before custody and network',async()=>{
    const f=fixture();vi.mocked(f.deps.authorize).mockRejectedValue(new Error('DENY'));
    await expect(f.manager.getValidToken(context)).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    expect(f.deps.acquire).not.toHaveBeenCalled();expect(f.deps.audit).not.toHaveBeenCalled();
  });
  it('checks exact secret reference before custody',async()=>{
    const f=fixture();vi.mocked(f.deps.authorize).mockResolvedValue({credentialSecretRef:'wrong'});
    await expect(f.manager.acquire(context)).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');expect(f.deps.acquire).not.toHaveBeenCalled();
  });
  it('revalidates scope even on cached token',async()=>{
    const f=fixture();await f.manager.getValidToken(context);vi.mocked(f.deps.authorize).mockRejectedValue(new Error('disabled'));
    await expect(f.manager.getValidToken(context)).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');expect(f.deps.acquire).toHaveBeenCalledTimes(1);
  });
  it('retries 401 once and never a third time',async()=>{
    const f=fixture();const op=vi.fn(async()=>({status:401}));
    await expect(f.manager.executeWithToken(context,op)).rejects.toThrow('PROVIDER_CREDENTIAL_INVALID');
    expect(op).toHaveBeenCalledTimes(2);expect(f.deps.acquire).toHaveBeenCalledTimes(2);
  });
  it('accepts successful retry, while 403 does not reacquire',async()=>{
    const f=fixture();const op=vi.fn().mockResolvedValueOnce({status:401}).mockResolvedValueOnce({status:200});
    expect((await f.manager.executeWithToken(context,op)).status).toBe(200);
    await expect(f.manager.executeWithToken(context,async()=>({status:403}))).rejects.toThrow('PROVIDER_SCOPE_INSUFFICIENT');
    expect(f.deps.acquire).toHaveBeenCalledTimes(2);
  });
  it('successful rotation tests candidate before CAS and invalidates old cache',async()=>{
    const f=fixture();await f.manager.getValidToken(context);await f.manager.rotateCredential(context,'2');
    expect(f.deps.testCredential).toHaveBeenCalledTimes(1);expect(f.deps.activateCredential).toHaveBeenCalledTimes(1);
    await f.manager.getValidToken({...context,credentialVersion:'2'});expect(f.deps.acquire).toHaveBeenCalledTimes(3);
  });
  it('failed rotation preserves old cache/version',async()=>{
    const f=fixture();const old=await f.manager.getValidToken(context);
    vi.mocked(f.deps.testCredential).mockRejectedValue(new Error('SECRET_TOKEN'));
    await expect(f.manager.rotateCredential(context,'2')).rejects.toThrow('PROVIDER_CREDENTIAL_ROTATION_FAILED');
    expect(await f.manager.getValidToken(context)).toBe(old);expect(f.deps.activateCredential).not.toHaveBeenCalled();
  });
  it('revocation invalidates cache and emits only safe metadata',async()=>{
    const f=fixture();await f.manager.getValidToken(context);await f.manager.invalidate(context,'CREDENTIAL_REVOKED');
    await f.manager.getValidToken(context);expect(f.deps.acquire).toHaveBeenCalledTimes(2);
    const calls=vi.mocked(f.deps.audit).mock.calls;expect(JSON.stringify(calls)).not.toContain('SECRET_TOKEN');
    for(const [, , metadata] of calls) expect(Object.keys(metadata).every(k=>['providerConnectionId','providerType','credentialVersion','authStrategy','safeErrorCode','reason'].includes(k))).toBe(true);
  });
  it('invalidation fences an acquisition already in flight',async()=>{
    const f=fixture();let resolve!:(v:{accessToken:string;expiresIn:number})=>void;
    vi.mocked(f.deps.acquire).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const pending=f.manager.acquire(context);await vi.waitFor(()=>expect(resolve).toBeDefined());
    await f.manager.invalidate(context,'SECURITY_INVALIDATION');resolve({accessToken:'SECRET_TOKEN',expiresIn:100});
    await expect(pending).rejects.toThrow('PROVIDER_CREDENTIAL_INVALID');
    await f.manager.getValidToken(context);expect(f.deps.acquire).toHaveBeenCalledTimes(2);
  });
  it('rejects missing/invalid expires_in instead of inventing a duration',async()=>{
    const f=fixture();vi.mocked(f.deps.acquire).mockResolvedValue({accessToken:'SECRET_TOKEN',expiresIn:NaN});
    await expect(f.manager.acquire(context)).rejects.toThrow('PROVIDER_CREDENTIAL_INVALID');
  });
});
