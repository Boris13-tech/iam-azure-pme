import type { ProviderOperationContext, SecretLease, SecretReference, SyncCursor } from "../..";

export const ENTERPRISE_DIRECTORY_TYPES = ["LDAP", "ACTIVE_DIRECTORY", "SAMBA_AD"] as const;
export type EnterpriseDirectoryType = (typeof ENTERPRISE_DIRECTORY_TYPES)[number];
export type DirectoryTransport = "LDAPS" | "STARTTLS";

export type EnterpriseDirectoryConfig = Readonly<{
  organizationId: string; tenantId: string; providerConnectionId: string; type: EnterpriseDirectoryType;
  host: string; port: number; baseDn: string; bindIdentity: string; bindSecret: SecretReference;
  transport: DirectoryTransport; certificateValidation: "SYSTEM" | "PINNED"; pinnedCertificateSha256?: string;
  connectTimeoutMs: number; operationTimeoutMs: number; maximumRetries: number; pageSize: number;
  userBaseDn?: string; groupBaseDn?: string;
}>;
export interface EnterpriseDirectoryConfigResolver { resolve(context: ProviderOperationContext): Promise<EnterpriseDirectoryConfig>; }

export type DirectoryRawEntry = Readonly<{ dn: string; attributes: Readonly<Record<string, string | ReadonlyArray<string> | undefined>> }>;
export type DirectoryPage = Readonly<{ entries: ReadonlyArray<DirectoryRawEntry>; nextCursor?: SyncCursor }>;
export type DirectoryGatewayRequest = Readonly<{ context: ProviderOperationContext; config: EnterpriseDirectoryConfig;
  bindSecret: SecretLease; cursor?: SyncCursor; maximumItems: number; escapedExternalId?: string }>;
export interface EnterpriseDirectoryGateway {
  health(request: DirectoryGatewayRequest): Promise<void>;
  listUsers(request: DirectoryGatewayRequest): Promise<DirectoryPage>;
  getUser(request: DirectoryGatewayRequest): Promise<DirectoryRawEntry | null>;
  listGroups(request: DirectoryGatewayRequest): Promise<DirectoryPage>;
}

export type NormalizedDirectoryIdentity = Readonly<{ externalObjectId: string; distinguishedName: string; displayName: string;
  principalName?: string; status: "ACTIVE" | "DISABLED" | "UNKNOWN"; attributes: Readonly<Record<string, string | null>>; version?: string }>;
export type NormalizedDirectoryGroup = Readonly<{ externalGroupId: string; distinguishedName: string; displayName: string;
  memberExternalIds: ReadonlyArray<string>; attributes: Readonly<Record<string, string | null>>; version?: string }>;
