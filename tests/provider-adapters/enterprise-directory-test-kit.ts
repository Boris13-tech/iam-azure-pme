import { ProviderAdapterError, SecretLease, type ProviderOperationContext, type SecretReference, type SecretResolver } from "../../lib/provider-adapters";
import { ActiveDirectoryAdapter, LdapAdapter, SambaAdAdapter, type DirectoryCollisionQuarantine,
  type DirectoryGatewayRequest, type DirectoryPage, type DirectoryRawEntry, type EnterpriseDirectoryConfig,
  type EnterpriseDirectoryConfigResolver, type EnterpriseDirectoryGateway, type EnterpriseDirectoryType,
} from "../../lib/provider-adapters/implementations/enterprise-directory";

export const directoryContext = (operationId = "directory-op"): ProviderOperationContext => ({ organizationId: "organization-a",
  tenantId: "tenant-a", providerConnectionId: "directory-connection-a", operationId });

export class TestDirectoryConfigResolver implements EnterpriseDirectoryConfigResolver {
  constructor(readonly type: EnterpriseDirectoryType, readonly overrides: Partial<EnterpriseDirectoryConfig> = {}) {}
  async resolve(context: ProviderOperationContext): Promise<EnterpriseDirectoryConfig> { return { organizationId: context.organizationId,
    tenantId: context.tenantId, providerConnectionId: context.providerConnectionId, type: this.type, host: "directory.internal",
    port: 636, baseDn: "dc=example,dc=internal", bindIdentity: "cn=luxia-reader,dc=example,dc=internal",
    bindSecret: { key: "directory-bind", version: "1" }, transport: "LDAPS", certificateValidation: "SYSTEM",
    connectTimeoutMs: 1_000, operationTimeoutMs: 5_000, maximumRetries: 2, pageSize: 2, ...this.overrides }; }
}
export class TestDirectorySecrets implements SecretResolver {
  calls: Array<{ context: ProviderOperationContext; reference: SecretReference }> = [];
  async withSecret<T>(context: ProviderOperationContext, reference: SecretReference,
    consumer: (secret: SecretLease) => Promise<T>): Promise<T> {
    this.calls.push({ context, reference }); const lease = new SecretLease(Buffer.from("bind-password-not-for-logs"));
    try { return await consumer(lease); } finally { lease.dispose(); }
  }
}
export class TestDirectoryGateway implements EnterpriseDirectoryGateway {
  users: DirectoryRawEntry[] = []; groups: DirectoryRawEntry[] = []; calls: Array<{ method: string; request: DirectoryGatewayRequest }> = [];
  failuresRemaining = 0;
  async health(request: DirectoryGatewayRequest) { this.record("health", request); this.failIfNeeded(); }
  async listUsers(request: DirectoryGatewayRequest): Promise<DirectoryPage> { this.record("listUsers", request); this.failIfNeeded(); return this.page(this.users, request); }
  async getUser(request: DirectoryGatewayRequest): Promise<DirectoryRawEntry | null> { this.record("getUser", request); this.failIfNeeded();
    return this.users.find((entry) => immutable(entry).toLowerCase() === request.escapedExternalId?.toLowerCase()) ?? null; }
  async listGroups(request: DirectoryGatewayRequest): Promise<DirectoryPage> { this.record("listGroups", request); this.failIfNeeded(); return this.page(this.groups, request); }
  private record(method: string, request: DirectoryGatewayRequest) { request.bindSecret.read((bytes) => { if (!bytes.byteLength) throw new Error("missing secret"); }); this.calls.push({ method, request }); }
  private failIfNeeded() { if (this.failuresRemaining-- > 0) throw new ProviderAdapterError({ code: "UNAVAILABLE", message: "Directory unavailable", retryable: true }); }
  private page(entries: DirectoryRawEntry[], request: DirectoryGatewayRequest): DirectoryPage {
    const offset = Number(request.cursor?.value ?? 0); const selected = entries.slice(offset, offset + request.maximumItems);
    const next = offset + selected.length; return { entries: selected,
      ...(next < entries.length ? { nextCursor: { value: String(next), version: (request.cursor?.version ?? 0) + 1 } } : {}) };
  }
}
export class TestQuarantine implements DirectoryCollisionQuarantine {
  collisions: Array<Parameters<DirectoryCollisionQuarantine["quarantine"]>[1]> = [];
  async quarantine(_context: ProviderOperationContext, collision: Parameters<DirectoryCollisionQuarantine["quarantine"]>[1]) { this.collisions.push(collision); }
}

export function createDirectoryAdapter(type: EnterpriseDirectoryType, options: Readonly<{ config?: Partial<EnterpriseDirectoryConfig>;
  gateway?: TestDirectoryGateway; secrets?: TestDirectorySecrets; quarantine?: TestQuarantine }> = {}) {
  const gateway = options.gateway ?? seededGateway(type); const secrets = options.secrets ?? new TestDirectorySecrets();
  const dependencies = { configs: new TestDirectoryConfigResolver(type, options.config), secrets, gateway, quarantine: options.quarantine };
  const adapter = type === "LDAP" ? new LdapAdapter(dependencies) : type === "ACTIVE_DIRECTORY" ? new ActiveDirectoryAdapter(dependencies) : new SambaAdAdapter(dependencies);
  return { adapter, gateway, secrets };
}
export function seededGateway(type: EnterpriseDirectoryType): TestDirectoryGateway {
  const gateway = new TestDirectoryGateway(); gateway.users = [user(type, "alice", "Alice"), user(type, "bob", "Bob"), user(type, "carol", "Carol")];
  gateway.groups = [{ dn: "cn=admins,ou=groups,dc=example,dc=internal", attributes: { cn: "Admins",
    [type === "LDAP" ? "entryUUID" : "objectGUID"]: "group-0001", member: gateway.users.slice(0, 2).map((item) => item.dn), uSNChanged: "8" } }];
  return gateway;
}
export function user(type: EnterpriseDirectoryType, id: string, name: string): DirectoryRawEntry { return {
  dn: `cn=${name},ou=people,dc=example,dc=internal`, attributes: { [type === "LDAP" ? "entryUUID" : "objectGUID"]: `immutable-${id}`,
    displayName: name, mail: `${id}@example.internal`, userPrincipalName: `${id}@example.internal`, uSNChanged: "7" } }; }
function immutable(entry: DirectoryRawEntry): string { const attrs = Object.fromEntries(Object.entries(entry.attributes).map(([k, v]) => [k.toLowerCase(), v]));
  const value = attrs.entryuuid ?? attrs.objectguid; return typeof value === "string" ? value : value?.[0] ?? ""; }
