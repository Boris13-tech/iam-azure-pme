import { describe, expect, it } from "vitest";
import { CHECKLIST_ITEM_RIGHTS, CHECKLIST_ITEMS, readChecklist } from "../../lib/onboarding/checklist";
import { ENTITLEMENT_CATALOG_V1 } from "../../lib/auth/entitlements-catalog";

// Without the read right, an item's query does not run: every model the checklist touches is recorded.
function recordingTx() {
  const touched = new Set<string>();
  const model = (name: string) => new Proxy({}, { get: (_t, method: string) => async () => {
    touched.add(name);
    return method === "count" ? 1 : method === "findMany" ? [{ id: "a" }] : method === "groupBy" ? [] : null;
  } });
  const tx = new Proxy({}, { get: (_t, name: string) => model(name) }) as never;
  return { tx, touched };
}
const scope = { organizationId: "o", tenantId: "t" };
const run = async (held: string[]) => {
  const { tx, touched } = recordingTx();
  const items = await readChecklist(tx, scope, new Set(held), new Date());
  return { items, touched: [...touched].sort() };
};

describe("Onboarding checklist: per-item read rights", () => {
  it("no right, no query, no answer", async () => {
    const { items, touched } = await run([]);
    expect(touched).toEqual([]);
    expect(Object.values(items).every((value) => value === null)).toBe(true);
  });

  it.each([
    [["subjects.read"], ["invitation"], "teamInvited"],
    [["providers.read"], ["organizationDomain"], "domainVerified"],
    [["resources.read"], ["resource"], "firstResource"],
    [["access_reviews.read_all"], ["accessReviewCampaign"], "firstAccessReview"],
    [["access_reviews.read", "access_reviews.manage"], ["accessReviewCampaign"], "firstAccessReview"],
  ])("%j reads only %j and answers only %s", async (held, models, item) => {
    const { items, touched } = await run(held);
    expect(touched).toEqual(models);
    expect(Object.entries(items).filter(([, value]) => value !== null).map(([key]) => key)).toEqual([item]);
  });

  it.each([
    [["access_reviews.read"]], [["access_reviews.manage"]], [["assignments.read"]], [["assignments.manage"]], [["identity_accounts.read"]],
  ])("%j alone reads nothing", async (held) => {
    const { items, touched } = await run(held);
    expect(touched).toEqual([]);
    expect(Object.values(items).every((value) => value === null)).toBe(true);
  });

  it("recovery codes are read only with both of their rights", async () => {
    expect((await run(["assignments.read", "identity_accounts.read"])).touched).not.toContain("localRecoveryCode");
    expect((await run(["assignments.manage", "identity_accounts.read"])).touched).toContain("localRecoveryCode");
  });

  it("every item declares its rights, from the catalog (read_all arrives with its own change)", () => {
    expect(Object.keys(CHECKLIST_ITEM_RIGHTS).sort()).toEqual([...CHECKLIST_ITEMS].sort());
    const known = new Set<string>([...ENTITLEMENT_CATALOG_V1, "access_reviews.read_all"]);
    for (const key of Object.values(CHECKLIST_ITEM_RIGHTS).flat(2)) expect(known.has(key), key).toBe(true);
  });
});
