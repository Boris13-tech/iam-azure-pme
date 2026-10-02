import type { SecretResolver } from "../..";
import { CloudProviderAdapter, type CloudProjectionCollisionQuarantine } from "./cloud-provider-adapter";
import type { CloudProviderConfigResolver, CloudProviderGateway, RetryBackoff } from "./types";
type Dependencies = Readonly<{ configs: CloudProviderConfigResolver; secrets: SecretResolver; gateway: CloudProviderGateway;
  quarantine?: CloudProjectionCollisionQuarantine; backoff?: RetryBackoff }>;
export class GoogleWorkspaceAdapter extends CloudProviderAdapter { constructor(d: Dependencies) { super("GOOGLE_WORKSPACE", d.configs, d.secrets, d.gateway, d.quarantine, d.backoff); } }
export class AwsIamAdapter extends CloudProviderAdapter { constructor(d: Dependencies) { super("AWS", d.configs, d.secrets, d.gateway, d.quarantine, d.backoff); } }
export class GithubAdapter extends CloudProviderAdapter { constructor(d: Dependencies) { super("GITHUB", d.configs, d.secrets, d.gateway, d.quarantine, d.backoff); } }
