import { ProviderAdapterError, SecretLease, type ProviderOperationContext, type SecretReference, type SecretResolver } from "../../lib/provider-adapters";
import { AwsIamAdapter, GithubAdapter, GoogleWorkspaceAdapter, type CloudGatewayRequest, type CloudPage,
  type CloudProviderConfig, type CloudProviderConfigResolver, type CloudProviderGateway, type CloudProviderType,
  type CloudRawGroup, type CloudRawIdentity, type CloudRawResource, type CloudProjectionCollisionQuarantine, type RetryBackoff,
} from "../../lib/provider-adapters/implementations/cloud-providers";
export const cloudContext = (operationId = "cloud-op"): ProviderOperationContext => ({ organizationId: "organization-a", tenantId: "tenant-a",
  providerConnectionId: "cloud-connection-a", operationId });
const scopes: Record<CloudProviderType, string> = { GOOGLE_WORKSPACE: "customer-1", AWS: "123456789012", GITHUB: "99" };
const urls: Record<CloudProviderType, string> = { GOOGLE_WORKSPACE: "https://admin.googleapis.com", AWS: "https://iam.amazonaws.com", GITHUB: "https://api.github.com" };
export class TestCloudConfigResolver implements CloudProviderConfigResolver {
  constructor(readonly type: CloudProviderType, readonly overrides: Partial<CloudProviderConfig> = {}) {}
  async resolve(context: ProviderOperationContext): Promise<CloudProviderConfig> { return { ...context, type: this.type, apiBaseUrl: urls[this.type],
    externalScopeId: scopes[this.type], credential: { key: `${this.type.toLowerCase()}-credential`, version: "1" }, connectTimeoutMs: 1_000,
    operationTimeoutMs: 5_000, maximumRetries: 2, initialBackoffMs: 10, pageSize: 2, ...this.overrides }; }
}
export class TestCloudSecrets implements SecretResolver {
  calls: Array<{ context: ProviderOperationContext; reference: SecretReference }> = [];
  async withSecret<T>(context: ProviderOperationContext, reference: SecretReference, consumer: (secret: SecretLease) => Promise<T>) {
    this.calls.push({ context, reference }); const lease = new SecretLease(Buffer.from("provider-token-never-log"));
    try { return await consumer(lease); } finally { lease.dispose(); }
  }
}
export class TestCloudGateway implements CloudProviderGateway {
  identities: CloudRawIdentity[] = []; groups: CloudRawGroup[] = []; resources: CloudRawResource[] = [];
  calls: Array<{ method: string; request: CloudGatewayRequest }> = []; failuresRemaining = 0;
  async health(request: CloudGatewayRequest) { this.record("health", request); this.fail(); }
  async listIdentities(request: CloudGatewayRequest) { this.record("listIdentities", request); this.fail(); return this.page(this.identities, request); }
  async getIdentity(request: CloudGatewayRequest) { this.record("getIdentity", request); this.fail();
    return this.identities.find((item) => request.externalObjectId?.endsWith(rawIdentityId(item).toLowerCase())) ?? null; }
  async listGroups(request: CloudGatewayRequest) { this.record("listGroups", request); this.fail(); return this.page(this.groups, request); }
  async listResources(request: CloudGatewayRequest) { this.record("listResources", request); this.fail(); return this.page(this.resources, request); }
  private record(method: string, request: CloudGatewayRequest) { request.credential.read((bytes) => { if (!bytes.byteLength) throw new Error("credential missing"); }); this.calls.push({ method, request }); }
  private fail() { if (this.failuresRemaining-- > 0) throw new ProviderAdapterError({ code: "UNAVAILABLE", message: "provider outage", retryable: true }); }
  private page<T>(items: T[], request: CloudGatewayRequest): CloudPage<T> { const offset = Number(request.cursor?.value ?? 0);
    const selected = items.slice(offset, offset + request.maximumItems); const next = offset + selected.length;
    return { items: selected, ...(next < items.length ? { nextCursor: { value: String(next), version: (request.cursor?.version ?? 0) + 1 } } : {}) }; }
}
export class TestCloudQuarantine implements CloudProjectionCollisionQuarantine {
  items: Array<Parameters<CloudProjectionCollisionQuarantine["quarantine"]>[1]> = [];
  async quarantine(_context: ProviderOperationContext, item: Parameters<CloudProjectionCollisionQuarantine["quarantine"]>[1]) { this.items.push(item); }
}
export class InstantBackoff implements RetryBackoff { waits: number[] = []; async wait(milliseconds: number) { this.waits.push(milliseconds); } }
export function createCloudAdapter(type: CloudProviderType, options: Readonly<{ gateway?: TestCloudGateway; secrets?: TestCloudSecrets;
  quarantine?: TestCloudQuarantine; config?: Partial<CloudProviderConfig>; backoff?: InstantBackoff }> = {}) {
  const gateway = options.gateway ?? seededCloudGateway(type), secrets = options.secrets ?? new TestCloudSecrets(), backoff = options.backoff ?? new InstantBackoff();
  const dependencies = { configs: new TestCloudConfigResolver(type, options.config), secrets, gateway, quarantine: options.quarantine, backoff };
  const adapter = type === "GOOGLE_WORKSPACE" ? new GoogleWorkspaceAdapter(dependencies) : type === "AWS" ? new AwsIamAdapter(dependencies) : new GithubAdapter(dependencies);
  return { adapter, gateway, secrets, backoff };
}
export function seededCloudGateway(type: CloudProviderType): TestCloudGateway { const gateway = new TestCloudGateway();
  if (type === "GOOGLE_WORKSPACE") gateway.identities = [
    { id: "1001", primaryEmail: "alice@example.com", name: { fullName: "Alice" }, etag: "g1" },
    { id: "1002", primaryEmail: "bob@example.com", name: { fullName: "Bob" }, etag: "g2" },
    { id: "1003", primaryEmail: "carol@example.com", name: { fullName: "Carol" }, suspended: true, etag: "g3" }];
  else if (type === "AWS") gateway.identities = [
    { principalId: "aida-alice", kind: "USER", name: "Alice", accountId: scopes.AWS, arn: "arn:aws:iam::123456789012:user/Alice" },
    { principalId: "aroa-app", kind: "ROLE", name: "AppRole", accountId: scopes.AWS, arn: "arn:aws:iam::123456789012:role/App" },
    { principalId: "svc-build", kind: "SERVICE", name: "BuildService", accountId: scopes.AWS }];
  else gateway.identities = [
    { databaseId: 501, login: "alice", name: "Alice", organizationId: 99, nodeId: "U501" },
    { databaseId: 502, login: "bob", name: "Bob", organizationId: 99, nodeId: "U502" },
    { databaseId: 503, login: "carol", organizationId: 99, suspended: true, nodeId: "U503" }];
  gateway.groups = [{ id: "group-1", name: type === "GITHUB" ? "Platform Team" : "Admins", memberIds: [rawIdentityId(gateway.identities[0])] }];
  gateway.resources = [{ id: "resource-1", name: type === "GITHUB" ? "identity-repo" : "Primary account", resourceType: type === "GITHUB" ? "REPOSITORY" : "ACCOUNT", scopeId: scopes[type] }];
  return gateway; }
function rawIdentityId(item: CloudRawIdentity): string { if ("id" in item) return item.id; if ("principalId" in item) return item.principalId; return String(item.databaseId); }
