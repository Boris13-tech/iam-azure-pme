/** One explicitly scoped LUXIA-owned HTTP integration, not a core identity default. */
export const INTERNAL_RESOURCE = Object.freeze({
  organizationId: "4841428a-80b4-4f07-bb3f-c94612dfd4a2",
  tenantId: "c68ae9ee-11a8-42f9-bc9c-b19c42ec7914",
  resourceId: "ed8c9111-a930-4724-a76d-bd541538a621",
  scopeId: "3952f920-c064-46a2-9d22-d31d338c8a54",
  entitlementId: "d6605f22-64f1-467b-b4e4-de806d2c957c",
  name: "LUXIA Internal Resource Test",
  type: "API" as const,
  action: "resource.read",
  route: "/api/resources/protected-resource-demo",
});
export const INTERNAL_ENTITLEMENT_KEY = `resource-scope:${INTERNAL_RESOURCE.scopeId}:${INTERNAL_RESOURCE.action}`;
