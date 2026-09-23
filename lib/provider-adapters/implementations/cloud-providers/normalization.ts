import { ProviderAdapterError, type ProviderGroup, type ProviderIdentity, type ProviderResource } from "../..";
import type { AwsPrincipal, CloudProviderType, CloudRawGroup, CloudRawIdentity, CloudRawResource, GithubMember, GoogleWorkspaceUser } from "./types";
export const CLOUD_NORMALIZATION_VERSION = 1;

export function normalizeCloudIdentity(type: CloudProviderType, raw: CloudRawIdentity, expectedScope: string, now = new Date()): ProviderIdentity {
  switch (type) {
    case "GOOGLE_WORKSPACE": return google(raw as GoogleWorkspaceUser, now);
    case "AWS": return aws(raw as AwsPrincipal, expectedScope, now);
    case "GITHUB": return github(raw as GithubMember, expectedScope, now);
  }
}
export function normalizeCloudGroup(type: CloudProviderType, raw: CloudRawGroup, now = new Date()): ProviderGroup {
  const id = stableId(raw.id); required(raw.name); return Object.freeze({ ref: { externalGroupId: `${prefix(type)}group:${id}` },
    displayName: clean(raw.name), attributes: { providerKind: type === "GITHUB" ? "TEAM" : "GROUP" }, observedAt: now.toISOString(),
    version: raw.version, members: Object.freeze((raw.memberIds ?? []).map((member) => ({ externalObjectId: identityPrefix(type, stableId(member)) }))) });
}
export function normalizeCloudResource(type: CloudProviderType, raw: CloudRawResource, expectedScope: string, now = new Date()): ProviderResource {
  if (clean(raw.scopeId) !== clean(expectedScope)) conflict("RESOURCE_SCOPE_MISMATCH"); required(raw.name); required(raw.resourceType);
  return Object.freeze({ ref: { externalResourceId: `${prefix(type)}resource:${stableId(raw.id)}` }, displayName: clean(raw.name),
    resourceType: clean(raw.resourceType).toUpperCase(), attributes: { providerType: type, scopeId: clean(raw.scopeId) },
    observedAt: now.toISOString(), version: raw.version });
}
function google(raw: GoogleWorkspaceUser, now: Date): ProviderIdentity {
  const id = stableId(raw.id); const email = emailAddress(raw.primaryEmail); return Object.freeze({ ref: { externalObjectId: identityPrefix("GOOGLE_WORKSPACE", id) },
    displayName: clean(raw.name?.fullName ?? email), principalName: email, status: raw.suspended || raw.archived ? "DISABLED" : "ACTIVE",
    suggestedSubjectKind: "HUMAN", attributes: { providerKind: "USER", primaryEmail: email }, observedAt: now.toISOString(), version: raw.etag });
}
function aws(raw: AwsPrincipal, expectedScope: string, now: Date): ProviderIdentity {
  if (!/^\d{12}$/.test(raw.accountId) || raw.accountId !== expectedScope) conflict("ACCOUNT_SCOPE_MISMATCH");
  const id = stableId(raw.principalId); required(raw.name); const kind = raw.kind === "USER" ? "HUMAN" : raw.kind === "SERVICE" ? "SERVICE" : "WORKLOAD";
  return Object.freeze({ ref: { externalObjectId: identityPrefix("AWS", id) }, displayName: clean(raw.name),
    status: raw.active === false ? "DISABLED" : "ACTIVE", suggestedSubjectKind: kind,
    attributes: { providerKind: raw.kind, accountId: raw.accountId, organizationId: raw.organizationId ? clean(raw.organizationId) : null,
      path: raw.path ? clean(raw.path) : null, arn: raw.arn ? clean(raw.arn) : null }, observedAt: now.toISOString(), version: raw.version });
}
function github(raw: GithubMember, expectedScope: string, now: Date): ProviderIdentity {
  const org = stableId(raw.organizationId); if (org !== expectedScope) conflict("ORGANIZATION_SCOPE_MISMATCH");
  const id = stableId(raw.databaseId); required(raw.login); return Object.freeze({ ref: { externalObjectId: identityPrefix("GITHUB", id) },
    displayName: clean(raw.name ?? raw.login), principalName: clean(raw.login).toLowerCase(), status: raw.suspended ? "DISABLED" : "ACTIVE",
    suggestedSubjectKind: "HUMAN", attributes: { providerKind: "MEMBER", organizationId: org, login: clean(raw.login).toLowerCase(),
      nodeId: raw.nodeId ? clean(raw.nodeId) : null }, observedAt: now.toISOString() });
}
function identityPrefix(type: CloudProviderType, id: string): string { return `${prefix(type)}identity:${id}`; }
function prefix(type: CloudProviderType): string { return `${type.toLowerCase()}:`; }
function stableId(value: string | number): string { const id = clean(String(value)).toLowerCase();
  if (!/^[a-z0-9_.:+\-/]{1,256}$/.test(id)) conflict("STABLE_ID_INVALID"); return id; }
function emailAddress(value: string): string { const email = clean(value).toLowerCase(); if (!/^[^\s@]+@[^\s@]+$/.test(email)) conflict("EMAIL_INVALID"); return email; }
function clean(value: string): string { return value.normalize("NFC").trim(); }
function required(value: string): void { if (!clean(value)) conflict("REQUIRED_FIELD_MISSING"); }
function conflict(reason: string): never { throw new ProviderAdapterError({ code: "CONFLICT", message: "Cloud provider response validation failed", safeDetails: { reason } }); }
