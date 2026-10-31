import { describe, expect, it } from "vitest";
import { CHECKLIST_ITEM_RIGHTS, CHECKLIST_ITEMS, readChecklist, type ChecklistItem } from "../../lib/onboarding/checklist";
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

// The rule, written out apart from the table it checks, with the models each item may query.
const RULE: Array<[ChecklistItem, (held: ReadonlySet<string>) => boolean, string[]]> = [
  ["domainVerified", (held) => held.has("providers.read"), ["organizationDomain"]],
  ["secondAdministrator", (held) => held.has("assignments.read") && held.has("identity_accounts.read"), ["subject"]],
  ["recoveryCodes", (held) => held.has("assignments.manage") && held.has("identity_accounts.read"), ["identityAccount", "localRecoveryCode"]],
  ["teamInvited", (held) => held.has("subjects.read"), ["invitation"]],
  ["firstResource", (held) => held.has("resources.read"), ["resource"]],
  ["firstAccessReview", (held) => held.has("access_reviews.read_all") || (held.has("access_reviews.read") && held.has("access_reviews.manage")), ["accessReviewCampaign"]],
];
async function expectRule(held: string[]) {
  const { items, touched } = await run(held);
  const allowed = RULE.filter(([, may]) => may(new Set(held)));
  expect(Object.entries(items).filter(([, value]) => value !== null).map(([key]) => key), held.join(" ")).toEqual(allowed.map(([item]) => item));
  expect(touched, held.join(" ")).toEqual(allowed.flatMap(([, , models]) => models).sort());
}

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

  it.each([
    [["assignments.read", "identity_accounts.read"], "secondAdministrator"],
    [["assignments.manage", "identity_accounts.read"], "recoveryCodes"],
  ])("%j answers only %s", async (held, item) => {
    const { items } = await run(held);
    expect(Object.entries(items).filter(([, value]) => value !== null).map(([key]) => key)).toEqual([item]);
  });

  it("recovery codes are read only with both of their rights", async () => {
    expect((await run(["assignments.read", "identity_accounts.read"])).touched).not.toContain("localRecoveryCode");
    expect((await run(["assignments.manage", "identity_accounts.read"])).touched).toContain("localRecoveryCode");
  });

  it("every combination of the table's rights answers and queries exactly what the rule allows", async () => {
    const rights = ["subjects.read", "providers.read", "assignments.read", "assignments.manage", "identity_accounts.read", "resources.read", "access_reviews.read", "access_reviews.read_all", "access_reviews.manage"];
    for (let mask = 0; mask < 1 << rights.length; mask++) await expectRule(rights.filter((_, bit) => mask & (1 << bit)));
  });

  it("no other right of the catalog opens anything, alone or beside the gate's subjects.read", async () => {
    for (const key of ENTITLEMENT_CATALOG_V1) {
      await expectRule([key]);
      await expectRule(["subjects.read", key]);
    }
  });

  it("the table is exactly this one: changing it means changing this test", () => {
    expect(CHECKLIST_ITEM_RIGHTS).toEqual({
      domainVerified: [["providers.read"]],
      secondAdministrator: [["assignments.read", "identity_accounts.read"]],
      recoveryCodes: [["assignments.manage", "identity_accounts.read"]],
      teamInvited: [["subjects.read"]],
      firstResource: [["resources.read"]],
      firstAccessReview: [["access_reviews.read_all"], ["access_reviews.read", "access_reviews.manage"]],
    });
  });

  it("every item declares its rights, from the catalog", () => {
    expect(Object.keys(CHECKLIST_ITEM_RIGHTS).sort()).toEqual([...CHECKLIST_ITEMS].sort());
    const known = new Set<string>(ENTITLEMENT_CATALOG_V1);
    for (const key of Object.values(CHECKLIST_ITEM_RIGHTS).flat(2)) expect(known.has(key), key).toBe(true);
  });
});
