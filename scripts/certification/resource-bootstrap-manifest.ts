// Exact UTF-8 bytes approved by the human operator. No trailing newline in payload.
export const APPROVED_BYTES = '{"manifestVersion":1,"environment":"CERTIFICATION_ONLY","branch":"br-flat-dream-ahgvk9x6","database":"neondb","organizationId":"4841428a-80b4-4f07-bb3f-c94612dfd4a2","tenantId":"c68ae9ee-11a8-42f9-bc9c-b19c42ec7914","actorSubjectId":"30a15eda-24d3-40ef-8705-11c2e6e1b929","targetSubjectId":"30a15eda-24d3-40ef-8705-11c2e6e1b929","resourceId":"ed8c9111-a930-4724-a76d-bd541538a621","scopeId":"3952f920-c064-46a2-9d22-d31d338c8a54","entitlementId":"d6605f22-64f1-467b-b4e4-de806d2c957c","action":"resource.read","entitlementKey":"resource-scope:3952f920-c064-46a2-9d22-d31d338c8a54:resource.read","purpose":"INITIAL_BOUNDED_RESOURCE_OWNER","assignmentId":"b30809f2-d852-4c9b-99d7-bb480dfdb1f9","operationId":"c39b6091-7f07-4856-833d-c5a973084b28","validFrom":"2026-10-08T03:00:00Z","validUntil":"2026-10-08T04:00:00Z","approvedAt":"PENDING_EXPLICIT_HUMAN_APPROVAL","approvedBy":"PENDING_EXPLICIT_HUMAN_APPROVAL","approvalReference":"PENDING_EXPLICIT_HUMAN_APPROVAL"}';
export const APPROVED_DIGEST = "881ff69c0ec3b7b362ef48834f51800841a61b52bbd4fda91ec32cc9cc78ea75";
// Detached attestation of the explicit operator message, not runtime permission.
// Timestamp is receipt observation in UTC, not a fabricated signature timestamp.
export const APPROVAL = Object.freeze({ manifestBinding: APPROVED_DIGEST,
  approvedAt: "2026-10-08T02:49:03Z", approvedBy: "Human operator in this task",
  approvalReference: `explicit-human-approval:${APPROVED_DIGEST}` });
export const MANIFEST = Object.freeze(JSON.parse(APPROVED_BYTES) as {
  manifestVersion: number; environment: string; branch: string; database: string;
  organizationId: string; tenantId: string; actorSubjectId: string; targetSubjectId: string;
  resourceId: string; scopeId: string; entitlementId: string; action: string; entitlementKey: string;
  purpose: string; assignmentId: string; operationId: string; validFrom: string; validUntil: string;
});
