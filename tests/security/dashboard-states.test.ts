import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Dashboard v3: lists distinguish loading, error, refusal and empty; people choose from lists instead of typing
// identifiers; a reviewer sees who and what, never raw identifiers.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const sod = read("app/dashboard/governance/sod/sod-console.tsx");
const reviews = read("app/dashboard/governance/access-reviews/review-console.tsx");
const organization = read("app/dashboard/organization/page.tsx");
const states = read("components/ui/states.tsx");

describe("Dashboard list states and business flows", () => {
  it("the shared states announce themselves correctly to screen readers", () => {
    expect(states).toMatch(/className="lx-state" role="status"/);
    expect(states).toMatch(/lx-state--error" role="alert"/);
  });

  it("no list shows an empty message while it is still loading", () => {
    expect(sod).toContain('policies.state === "loading" && <LoadingState');
    expect(sod).toContain('conflicts.state === "loading" && <LoadingState');
    expect(sod).not.toMatch(/useState<Policy\[\]>\(\[\]\)|useState<Conflict\[\]>\(\[\]\)/);
    expect(reviews).toContain("campaigns === null ? <LoadingState");
    expect(reviews).toContain("items === null ? <LoadingState");
    expect(organization).toContain('list.state === "loading" && <LoadingState label="Chargement des domaines..." />');
    expect(organization).toContain('list.state === "loading" && <LoadingState label="Chargement des invitations..." />');
  });

  it("separation of duties: scopes and entitlements are chosen from lists, never typed as identifiers", () => {
    expect(sod).not.toMatch(/placeholder="Identifiant du/);
    expect(sod).toMatch(/<select id="sod-scope"/);
    expect(sod).toMatch(/<select id="sod-a"/);
    expect(sod).toMatch(/<select id="sod-b"/);
    expect(sod).not.toContain("JSON.stringify(c.metadata");
  });

  it("pages never fan out more than two API requests at a time (each holds a database connection)", () => {
    for (const source of [sod, reviews]) for (const call of source.matchAll(/Promise\.all\(\[([^\]]*)\]/g))
      expect((call[1].match(/read<|names\(|api\(/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it("access reviews: the reviewer sees names, not identifiers, and errors in words", () => {
    for (const raw of ["{item.subjectId}", "{item.assignmentId}", "{item.entitlementId}", 'item.resourceIds.join(", ")'])
      expect(reviews, raw).not.toContain(raw);
    expect(reviews).toContain("person(item.subjectId)");
    expect(reviews).toContain("right(item.entitlementId)");
    expect(reviews).not.toMatch(/setError\(failure instanceof Error \? failure\.message : "REQUEST_DENIED"\)/);
  });

  it("only a catalog that follows `after` is paged: another would repeat one request, and one journal event, per page", () => {
    const call = (url: string) => reviews.slice(reviews.indexOf(`names("${url}"`)).split(String.fromCharCode(10))[0];
    expect(call("/api/canonical/resource-governance/entitlements")).toMatch(/, true\);$/);
    expect(call("/api/canonical/resources")).not.toMatch(/, true\);$/);
    expect(call("/api/canonical/subjects")).not.toMatch(/, true\);$/);
    expect(read("app/api/canonical/resources/route.ts")).not.toContain("after");
  });
});
