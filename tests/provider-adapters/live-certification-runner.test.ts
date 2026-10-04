import { afterEach,describe,expect,it,vi } from 'vitest';
import { run } from '../../scripts/provider-certification/run';
describe('Live runners remain offline until prerequisites exist',()=>{
  const exit=process.exitCode;
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();process.exitCode=exit;});
  for(const profile of ['ENTRA','GOOGLE','OIDC'] as const)it(`${profile} neither opens network nor prints supplied secret when blocked`,async()=>{
    vi.stubEnv('LUXIA_CERT_DATABASE_URL',undefined);
    vi.stubEnv('LUXIA_CERT_ENTRA_CLIENT_SECRET','test-custody-never-print');
    const network=vi.fn().mockRejectedValue(new Error('network forbidden'));
    vi.stubGlobal('fetch',network);
    const output=vi.spyOn(console,'log').mockImplementation(()=>{});
    await run(profile);
    expect(network).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(JSON.stringify(output.mock.calls)).not.toContain('test-custody-never-print');
    expect(JSON.stringify(output.mock.calls)).toContain('BLOCKED');
  });
});
