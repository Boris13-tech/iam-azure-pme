import type { SecretResolver } from "../..";
import { EnterpriseDirectoryAdapter, type DirectoryCollisionQuarantine } from "./enterprise-directory-adapter";
import type { EnterpriseDirectoryConfigResolver, EnterpriseDirectoryGateway } from "./types";

type Dependencies = Readonly<{ configs: EnterpriseDirectoryConfigResolver; secrets: SecretResolver;
  gateway: EnterpriseDirectoryGateway; quarantine?: DirectoryCollisionQuarantine }>;
export class LdapAdapter extends EnterpriseDirectoryAdapter {
  constructor(dependencies: Dependencies) { super("LDAP", dependencies.configs, dependencies.secrets, dependencies.gateway, dependencies.quarantine); }
}
export class ActiveDirectoryAdapter extends EnterpriseDirectoryAdapter {
  constructor(dependencies: Dependencies) { super("ACTIVE_DIRECTORY", dependencies.configs, dependencies.secrets, dependencies.gateway, dependencies.quarantine); }
}
export class SambaAdAdapter extends EnterpriseDirectoryAdapter {
  constructor(dependencies: Dependencies) { super("SAMBA_AD", dependencies.configs, dependencies.secrets, dependencies.gateway, dependencies.quarantine); }
}
