import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { FIXED, PROFILES, VERCEL_PROJECT_ID, ABANDONED, hash, validate, type Execution } from "../../scripts/operators/resource-owner-bootstrap";

const now = Date.now();
const deploymentSha = "5704558f5c343ae653c8984917b90a760caeabf1";
const m = { manifestVersion: 1, environment: "CERTIFICATION_ONLY", ...FIXED, branch: PROFILES.CERTIFICATION_ONLY.branch,
  productionDeploymentSha: deploymentSha,
  scopeType: "RESOURCE", purpose: "INITIAL_BOUNDED_RESOURCE_OWNER", source: "DIRECT", assignmentId: randomUUID(), operationId: randomUUID(),
  validFrom: new Date(now - 1000).toISOString(), validUntil: new Date(now + 3_500_000).toISOString(),
  approvedAt: "PENDING_EXPLICIT_HUMAN_APPROVAL", approvedBy: "PENDING_EXPLICIT_HUMAN_APPROVAL", approvalReference: "PENDING_EXPLICIT_HUMAN_APPROVAL",
  requiredResourceBinding: "EXACT_ACTIVE_RESOURCE_SCOPE_ENTITLEMENT" };
const bytes = JSON.stringify(m);
const release = { releaseVersion: 1, environment: "CERTIFICATION_ONLY", projectId: FIXED.projectId,
  branch: PROFILES.CERTIFICATION_ONLY.branch, database: FIXED.database, vercelProjectId: VERCEL_PROJECT_ID,
  deployedSha: deploymentSha, deploymentId: "certification-local", manifestBinding: hash(bytes) };
const releaseBytes = JSON.stringify(release), approval = { manifestBinding: hash(bytes), releaseBinding: hash(releaseBytes), approvedAt: new Date(now - 500).toISOString(),
  approvedBy: "operator-authorized-certification-only", approvalReference: "2026-10-08 dedicated runner certification instruction" };
const ex: Execution = { mode: "CERTIFICATION_ONLY", url: `postgresql://app_user@${PROFILES.CERTIFICATION_ONLY.host}/neondb?sslmode=require`,
  origin: PROFILES.CERTIFICATION_ONLY.origin, deployedSha: deploymentSha, deploymentId: release.deploymentId,
  verifiedProject: FIXED.projectId, verifiedBranch: PROFILES.CERTIFICATION_ONLY.branch, registrations: [{ bytes, releaseBytes, approval }] };

describe("independent operator runner hard guards", () => {
  it("pins a separately registered release to exact manifest, approval, deployment ID and SHA", () => {
    for (const field of Object.keys(release)) {
      const modifiedRelease = JSON.stringify({ ...release, [field]: 'modified' });
      expect(() => validate(bytes, approval, { ...ex, registrations: [{ bytes, releaseBytes: modifiedRelease, approval }] })).toThrow();
    }
    expect(() => validate(bytes, { ...approval, releaseBinding: 'wrong' }, ex)).toThrow();
    expect(() => validate(bytes, approval, { ...ex, deploymentId: 'another-deployment' })).toThrow();
    expect(() => validate(bytes, approval, { ...ex, registrations: [{ bytes, releaseBytes: releaseBytes+' ', approval }] })).toThrow();
    // New releases require NEW exact manifest bytes AND fresh detached approval, never an env override.
    const sha = '1234567890123456789012345678901234567890';
    const newBytes = JSON.stringify({ ...m, productionDeploymentSha: sha });
    const newReleaseBytes = JSON.stringify({ ...release, deployedSha: sha, manifestBinding: hash(newBytes) });
    const newApproval = { ...approval, manifestBinding: hash(newBytes), releaseBinding: hash(newReleaseBytes) };
    const next = { ...ex, deployedSha: sha, registrations: [{ bytes: newBytes, releaseBytes: newReleaseBytes, approval: newApproval }] };
    expect(validate(newBytes, newApproval, next).productionDeploymentSha).toBe(sha);
    expect(() => validate(newBytes, approval, next)).toThrow();
    expect(() => validate(newBytes, newApproval, { ...next, deployedSha: deploymentSha })).toThrow();
    expect(readFileSync('scripts/operators/run-production-resource-bootstrap.ts','utf8')).toContain('id !== expected.deploymentId');
    expect(readFileSync('scripts/operators/production-bootstrap-registry.ts','utf8')).toContain('Object.freeze([])');
  });
  it("accepts only exact registered bytes and detached approval", () => {
    expect(validate(bytes, approval, ex).assignmentId).toBe(m.assignmentId);
    for (const field of Object.keys(m)) expect(() => validate(JSON.stringify({ ...m, [field]: "modified" }), approval, ex)).toThrow();
    expect(() => validate(bytes + "\n", approval, ex)).toThrow();
    expect(() => validate(bytes, undefined, ex)).toThrow("OPERATOR_APPROVAL_DENIED");
    expect(() => validate(bytes, { ...approval, manifestBinding: "wrong" }, ex)).toThrow();
    expect(() => validate(bytes, approval, { ...ex, registrations: [] })).toThrow();
    expect(() => validate(bytes, approval, ex, now - 10_000)).toThrow();
    expect(() => validate(bytes, approval, ex, now + 4_000_000)).toThrow();
  });
  it("cannot resolve certification to Production or trust an environment label", () => {
    for (const change of [{ mode: "PRODUCTION" }, { url: `postgresql://app_user@${PROFILES.PRODUCTION.host}/neondb?sslmode=require` },
      { verifiedBranch: PROFILES.PRODUCTION.branch }, { verifiedProject: "wrong" }, { deployedSha: "wrong" },
      { origin: PROFILES.PRODUCTION.origin }, { url: ex.url.replace('/neondb', '/other') }, { url: ex.url.replace('app_user', 'neondb_owner') }]) {
      expect(() => validate(bytes, approval, { ...ex, ...change } as Execution)).toThrow();
    }
    expect(ABANDONED).toBe("95e9b80de3e28890faf01eb41fb70002d6ef1efb6986815da8b8868799376232");
  });
  it("operator modules are unreachable from application modules and clone runner is not imported", () => {
    for (const file of ['app/api/canonical/resource-onboarding/route.ts','app/api/resources/protected-resource-demo/route.ts','lib/resources/onboarding.ts'])
      expect(readFileSync(file,'utf8')).not.toMatch(/operators|resource-owner-bootstrap|createSession|session\.(create|upsert)/);
    expect(readFileSync('scripts/operators/resource-owner-bootstrap.ts','utf8')).not.toMatch(/certification\/resource-bootstrap|APPROVED_BYTES/);
    expect(hash(readFileSync('docs/certification/PR14-SESSION-DELTA-ATTRIBUTION-2026-10-08.md','utf8')))
      .toBe('801333ca13e4f6bd935449540314193be38c4715479d640771925f7baf2a7490');
    expect(readFileSync('.gitattributes','utf8')).toContain('docs/certification/PR14-SESSION-DELTA-ATTRIBUTION-2026-10-08.md -text');
    const preflight=readFileSync('scripts/operators/production-resource-preflight.ts','utf8');
    expect(preflight).toContain('SET TRANSACTION READ ONLY');
    expect(preflight).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/);
    expect(preflight.indexOf('SET TRANSACTION READ ONLY')).toBeLessThan(preflight.indexOf("set_config('app.organization_id'"));
  });
});
