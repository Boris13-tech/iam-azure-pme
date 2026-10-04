import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("Access Reviews architecture", () => {
  it("uses canonical authority and never provisions through KEEP", () => {
    const source = readFileSync("lib/resources/access-reviews.ts", "utf8");
    expect(source).toContain("withTenantDb"); expect(source).toContain("requireNative"); expect(source).toContain("evaluateSoD");
    expect(source).not.toMatch(/\.assignment\.create|\.userRole\.|\.permission\.|\.auditLog\.|from .*legacy/);
    expect(source).toContain('source: { not: "LEGACY_ROLE" }');
    expect(source).toContain('if ("error" in outcome) throw outcome.error');
    expect(source).toContain("pg_advisory_xact_lock");
  });
  it("forces RLS, composite constraints, immutable decisions, no business seeds", () => {
    const sql = readFileSync("prisma/migrations/20261004180000_access_reviews_v1/migration.sql", "utf8");
    for (const table of ["AccessReviewCampaign", "AccessReviewItem"]) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain('CHECK("reviewerSubjectId" <> "subjectId")');
    expect(sql).toContain('FOREIGN KEY("organizationId","tenantId","assignmentId")');
    expect(sql).toContain("REVIEW_IMMUTABLE");
    expect(sql).not.toMatch(/INSERT INTO|DROP TABLE|DELETE FROM|ALTER TABLE "(?:User|Role|Permission|AccessPolicy|AuditLog)"/);
  });
  it("HTTP derives actor from session and rejects extra fields", () => {
    const source = readFileSync("app/api/canonical/access-reviews/[[...path]]/route.ts", "utf8");
    expect(source).toContain("await requireAuth()"); expect(source).toContain(".strict()"); expect(source).toContain("mutationChangeId(request)");
  });
});
