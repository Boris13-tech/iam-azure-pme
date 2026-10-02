import type { ProviderOperationContext, SecretLease, SecretReference, SyncCursor } from "../..";
export const CLOUD_PROVIDER_TYPES = ["GOOGLE_WORKSPACE", "AWS", "GITHUB"] as const;
export type CloudProviderType = (typeof CLOUD_PROVIDER_TYPES)[number];
export type CloudProviderConfig = Readonly<{ organizationId: string; tenantId: string; providerConnectionId: string;
  type: CloudProviderType; apiBaseUrl: string; externalScopeId: string; credential: SecretReference;
  connectTimeoutMs: number; operationTimeoutMs: number; maximumRetries: number; initialBackoffMs: number; pageSize: number }>;
export interface CloudProviderConfigResolver { resolve(context: ProviderOperationContext): Promise<CloudProviderConfig>; }

export type GoogleWorkspaceUser = Readonly<{ id: string; primaryEmail: string; name?: Readonly<{ fullName?: string }>;
  suspended?: boolean; archived?: boolean; etag?: string }>;
export type AwsPrincipal = Readonly<{ principalId: string; kind: "USER" | "ROLE" | "WORKLOAD" | "SERVICE"; name: string;
  accountId: string; organizationId?: string; arn?: string; path?: string; active?: boolean; version?: string }>;
export type GithubMember = Readonly<{ databaseId: number | string; login: string; name?: string; organizationId: number | string;
  suspended?: boolean; nodeId?: string }>;
export type CloudRawIdentity = GoogleWorkspaceUser | AwsPrincipal | GithubMember;
export type CloudRawGroup = Readonly<{ id: string | number; name: string; memberIds?: ReadonlyArray<string | number>; version?: string }>;
export type CloudRawResource = Readonly<{ id: string | number; name: string; resourceType: string; scopeId: string; version?: string }>;
export type CloudPage<T> = Readonly<{ items: ReadonlyArray<T>; nextCursor?: SyncCursor }>;
export type CloudGatewayRequest = Readonly<{ context: ProviderOperationContext; config: CloudProviderConfig; credential: SecretLease;
  cursor?: SyncCursor; maximumItems: number; externalObjectId?: string }>;
export interface CloudProviderGateway {
  health(request: CloudGatewayRequest): Promise<void>;
  listIdentities(request: CloudGatewayRequest): Promise<CloudPage<CloudRawIdentity>>;
  getIdentity(request: CloudGatewayRequest): Promise<CloudRawIdentity | null>;
  listGroups(request: CloudGatewayRequest): Promise<CloudPage<CloudRawGroup>>;
  listResources(request: CloudGatewayRequest): Promise<CloudPage<CloudRawResource>>;
}
export interface RetryBackoff { wait(milliseconds: number): Promise<void>; }
