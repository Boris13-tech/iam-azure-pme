import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { diagnosticStep, pendingDiagnosticSteps } from './diagnostic-step';
import { createDiagnosticObserver } from './diagnostic-observer';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('test-only timeout instrumentation', () => {
  it('is inert unless explicitly enabled', async () => {
    vi.stubEnv('LUXIA_RESOURCE_DIAGNOSTICS','false');
    const output=vi.spyOn(console,'log').mockImplementation(()=>{});
    expect(await diagnosticStep('opaque-step',async()=>42)).toBe(42);
    expect(output).not.toHaveBeenCalled();expect(pendingDiagnosticSteps()).toEqual([]);
  });
  it('clears pending work and heartbeat after success and failure without logging payloads', async () => {
    vi.stubEnv('LUXIA_RESOURCE_DIAGNOSTICS','true');vi.useFakeTimers();
    const output=vi.spyOn(console,'log').mockImplementation(()=>{});
    expect(await diagnosticStep('opaque-step',async()=>({privateInput:'not-for-output'}))).toEqual({privateInput:'not-for-output'});
    await expect(diagnosticStep('opaque-failure',async()=>{throw Object.assign(new Error('private-error-content'),{code:'SAFE_FAILURE'});})).rejects.toThrow('private-error-content');
    expect(pendingDiagnosticSteps()).toEqual([]);expect(vi.getTimerCount()).toBe(0);
    const logs=JSON.stringify(output.mock.calls);expect(logs).toContain('SAFE_FAILURE');
    expect(logs).not.toMatch(/not-for-output|private-error-content|privateInput/);
  });
  it('rejects Production, unknown endpoints, owner/runtime mismatch and copied business database before connecting', () => {
    const runtime='postgresql://app_user@ep-solitary-wildflower-ahcqqg5r-pooler.c-3.us-east-1.aws.neon.tech/luxia_resources_diag_global01?sslmode=require';
    const owner=runtime.replace('app_user','neondb_owner').replace('-pooler.','.');
    for(const bad of [runtime.replace('ep-solitary-wildflower-ahcqqg5r','ep-restless-thunder-ah18c37v'),runtime.replace('ep-solitary-wildflower-ahcqqg5r','unknown'),runtime.replace('/luxia_resources_diag_global01','/neondb'),runtime.replace('app_user','neondb_owner')])
      expect(()=>createDiagnosticObserver(owner,bad)).toThrow('DIAGNOSTIC_CLONE_ONLY');
    expect(()=>createDiagnosticObserver(owner.replace('/luxia_resources_diag_global01','/other'),runtime)).toThrow('DIAGNOSTIC_CLONE_ONLY');
  });
  it('enforces fresh fixtures before tests and never emits invalid credential input', () => {
    const harness=readFileSync('scripts/certification/run-resources-diagnostic.ps1','utf8');
    expect(harness).toContain('assert-fresh-resources-diagnostic.cjs');
    expect(harness).toContain("'ci' { $arguments+=@('tests/security','tests/resources','tests/provider-adapters','tests/identity','tests/operations') }");
    for(const script of ['assert-fresh-resources-diagnostic','prepare-resources-diagnostic','check-resources-diagnostic-cleanup']) {
      const result=spawnSync(process.execPath,[`scripts/certification/${script}.cjs`],{
        env:{...process.env,DATABASE_MIGRATION_URL:'confidential-invalid-input'},encoding:'utf8',windowsHide:true,timeout:5000});
      expect(result.status).toBe(1);expect(result.stderr).toContain('DIAGNOSTIC_ENDPOINT_DENIED');
      expect(result.stdout+result.stderr).not.toContain('confidential-invalid-input');
    }
  });
});
